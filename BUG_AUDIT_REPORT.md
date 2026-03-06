# twig Bug Audit Report

**Date**: 2025-10-17
**Auditor**: Claude Code
**Scope**: Complete codebase analysis

## Executive Summary

This audit identified **7 bugs** across the twig codebase, ranging from critical user-facing issues to potential resource leaks. The bugs are categorized by severity:

- **High Priority**: 3 bugs
- **Medium Priority**: 2 bugs
- **Low Priority**: 2 bugs

---

## High Priority Bugs

### 1. Dirty Flag Timing Issue
**File**: `src/renderer/src/App.svelte:93-101`
**Severity**: High
**Impact**: Users may lose work or be unable to save changes

**Description**:
The dirty flag (which enables the Save button) uses a 100ms debounce that triggers on ANY change to `currentSlide`. This causes two problems:

1. If a user makes rapid changes (within 100ms of each other), the dirty flag won't be set until 100ms after the last change
2. If a user makes a change and immediately clicks Save (within 100ms), the Save button may still be disabled

**Current Code**:
```typescript
$effect(() => {
  if (appState.currentSlide) {
    const timeout = setTimeout(() => {
      if (appState.currentSlide) appState.isDirty = true
    }, 100)
    return () => clearTimeout(timeout)
  }
  return undefined
})
```

**Root Cause**:
Svelte 5's deep reactivity means ANY modification to `currentSlide` (including adding elements, modifying properties, etc.) triggers this effect. Each trigger clears and restarts the 100ms timer.

**Recommended Fix**:
Track slide changes without debouncing, or only debounce on initial slide load:
```typescript
let isInitialLoad = true
$effect(() => {
  if (appState.currentSlide) {
    if (isInitialLoad) {
      isInitialLoad = false
      // Don't mark dirty on initial render
    } else {
      appState.isDirty = true
    }
  }
})
```

---

### 2. Missing Error Feedback in Save Operations
**File**: `src/renderer/src/App.svelte:487-511, 667-669`
**Severity**: High
**Impact**: Silent failures leave users unaware their work wasn't saved

**Description**:
The `handleSave` function has no catch block to handle IPC errors. When called from the keyboard shortcut handler (Cmd/Ctrl+S), any save errors become unhandled promise rejections that only appear in the console.

**Current Code**:
```typescript
// Line 487-511
async function handleSave(): Promise<void> {
  if (isSaving) return
  isSaving = true
  try {
    // ... save logic that can throw ...
    await window.api.db.saveSlide(appState.currentFilePath, plainSlide)
  } finally {
    isSaving = false
  }
}

// Line 667-669: Called without await or .catch()
keys.onKeys(['meta', 's'], () => {
  if (!isSaving) handleSave()
})
```

**Impact Scenarios**:
- Database connection fails
- File permissions error
- Disk full
- Database corruption

In all these cases, the user receives NO feedback that the save failed.

**Recommended Fix**:
```typescript
async function handleSave(): Promise<void> {
  if (isSaving) return
  isSaving = true
  try {
    // ... save logic ...
  } catch (error) {
    console.error('Save failed:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    alert(`Failed to save: ${errorMessage}`)
  } finally {
    isSaving = false
  }
}

// Also update keyboard handler to await:
keys.onKeys(['meta', 's'], async () => {
  if (!isSaving) await handleSave()
})
```

---

### 3. Async Functions Called Without Await
**File**: `src/renderer/src/App.svelte:951`
**Severity**: High
**Impact**: Race conditions and unhandled errors

**Description**:
The slide navigation buttons call `loadSlide()` without await, which can cause race conditions if the user rapidly clicks between slides.

**Current Code**:
```svelte
<button
  onclick={() => loadSlide(slideId)}
>
  Slide {index + 1}
</button>
```

**Issues**:
1. Rapid clicks can trigger multiple concurrent `loadSlide` calls
2. While `loadSlide` has an `isLoadingSlide` flag to prevent concurrent execution, the async nature means UI updates may be out of order
3. Any errors in `loadSlide` become unhandled promise rejections

**Recommended Fix**:
```svelte
<button
  onclick={async () => await loadSlide(slideId)}
  disabled={isLoadingSlide}
>
  Slide {index + 1}
</button>
```

---

## Medium Priority Bugs

### 4. Database Connection Leak
**File**: `src/main/index.ts:28-103`
**Severity**: Medium
**Impact**: Resource exhaustion with multiple file operations

**Description**:
Database connections are cached in a Map but never closed except when:
1. The application quits
2. A file is being overwritten (Save As to same path)

If a user opens many different files during a session, all connections remain open, potentially exhausting file descriptors or memory.

**Current Behavior**:
```typescript
const connectionCache = new Map<string, Database.Database>()

function getDbConnection(filePath: string): Database.Database {
  if (connectionCache.has(filePath)) {
    return connectionCache.get(filePath)!
  }
  // ... create and cache connection ...
  connectionCache.set(filePath, db)
  return db
}
```

**Scenario**:
1. User opens file A.db
2. User opens file B.db
3. User opens file C.db
4. User works only with C.db
→ Connections to A.db and B.db remain open unnecessarily

**Recommended Fix**:
Implement one of:
1. **LRU cache** with maximum size (e.g., keep only 3 most recent connections)
2. **Close on file switch**: Close previous file's connection when opening a new one
3. **Activity-based cleanup**: Close connections idle for > 5 minutes

---

### 5. No Input Validation in IPC Handlers
**File**: `src/main/index.ts:217-313`
**Severity**: Medium
**Impact**: Potential security issues and crashes

**Description**:
IPC handlers accept file paths and slide IDs from the renderer process without validation. While Electron's context isolation provides some protection, malicious or buggy renderer code could:
- Access files outside the intended directory
- Cause crashes with invalid slide IDs
- Trigger SQL injection (though better-sqlite3 uses prepared statements)

**Current Code**:
```typescript
ipcMain.handle('db:get-slide', (_event, filePath: string, slideId: string): Slide | null => {
  try {
    const db = getDbConnection(filePath)  // No validation of filePath!
    return dbService.getSlide(db, slideId)  // No validation of slideId!
  } catch (error) {
    console.error('Error in db:get-slide:', error)
    throw error
  }
})
```

**Recommended Fix**:
```typescript
import path from 'path'

function validateFilePath(filePath: string): void {
  // Ensure it's an absolute path
  if (!path.isAbsolute(filePath)) {
    throw new Error('File path must be absolute')
  }
  // Ensure it ends with .db
  if (!filePath.endsWith('.db')) {
    throw new Error('Invalid file extension')
  }
  // Prevent path traversal (optional, add if needed)
  const normalized = path.normalize(filePath)
  if (normalized !== filePath) {
    throw new Error('Invalid file path')
  }
}

function validateSlideId(slideId: string): void {
  // Ensure it's a valid UUID v4 format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(slideId)) {
    throw new Error('Invalid slide ID format')
  }
}
```

---

## Low Priority Bugs

### 6. Zero Width Check Bug
**File**: `src/renderer/src/App.svelte:280`
**Severity**: Low
**Impact**: State updates fail for zero-width objects (rare edge case)

**Description**:
The `updateStateFromObject` function checks `!obj.width`, which treats 0 as falsy. If a user somehow creates an object with 0 width, state updates will be skipped.

**Current Code**:
```typescript
function updateStateFromObject(obj: DeckFabricObject): void {
  if (!obj.id || !obj.width || !appState.currentSlide) return
  // ... state update logic ...
}
```

**Note**: fabric.js likely prevents resizing to exactly 0, so this is mostly a theoretical issue.

**Recommended Fix**:
```typescript
if (!obj.id || obj.width === undefined || obj.width === null || !appState.currentSlide) return
```

Or even better:
```typescript
if (!obj.id || typeof obj.width !== 'number' || !appState.currentSlide) return
```

---

### 7. Slide Order Not Updated in saveAllSlides
**File**: `src/main/db.ts:338-416`
**Severity**: Low
**Impact**: Future feature blocker (slide reordering)

**Description**:
The `saveAllSlides` function doesn't update the `slide_order` column for existing slides. Currently this isn't a problem because:
1. Slides cannot be reordered in the UI
2. Slides are always saved in the order of `appState.slideIds`

However, if slide reordering is added in the future, the database order won't reflect the new order.

**Current Code**:
```typescript
if (slideInfo) {
  // Slide exists - delete all its old elements
  db.prepare('DELETE FROM elements WHERE slide_id = ?').run(slide.id)
  // BUG: slide_order is not updated!
} else {
  // New slide - create with order
  const maxOrder = db.prepare('SELECT MAX(slide_order) as max FROM slides').get() as {
    max: number | null
  }
  const newOrder = maxOrder.max === null ? 0 : maxOrder.max + 1
  db.prepare('INSERT INTO slides (id, slide_order) VALUES (?, ?)').run(slide.id, newOrder)
}
```

**Recommended Fix**:
Accept slide order as a parameter or use array index:
```typescript
export function saveAllSlides(db: Database, slides: Slide[]): void {
  // ...
  const transaction = db.transaction((slidesToSave: Slide[]) => {
    slidesToSave.forEach((slide, index) => {
      const slideInfo = db.prepare('SELECT slide_order FROM slides WHERE id = ?').get(slide.id)

      if (slideInfo) {
        // Update order for existing slide
        db.prepare('UPDATE slides SET slide_order = ? WHERE id = ?').run(index, slide.id)
        db.prepare('DELETE FROM elements WHERE slide_id = ?').run(slide.id)
      } else {
        // Insert new slide with order
        db.prepare('INSERT INTO slides (id, slide_order) VALUES (?, ?)').run(slide.id, index)
      }
      // ... insert elements ...
    })
  })
  transaction(slides)
}
```

---

## Additional Observations (Not Bugs)

### Good Practices Found
1. **Excellent error recovery** in `handleSaveAs` (App.svelte:518-662) - tries to restore original state on failure
2. **Transaction usage** in database operations ensures atomicity
3. **Event listener cleanup** in `renderCanvasFromState` prevents memory leaks
4. **Concurrent operation prevention** with `isSaving` and `isLoadingSlide` flags
5. **File descriptor cleanup** in SQLite header validation (main/index.ts:70-77)

### Potential Improvements (Not Bugs)
1. **Canvas re-render optimization**: Currently re-creates all objects on every state change. Could use object pooling or dirty checking.
2. **Undo/Redo**: The codebase mentions `runed` library's `StateHistory`, which could be implemented.
3. **Auto-save**: Given the dirty flag issues, auto-save would improve UX.
4. **Connection pooling**: More sophisticated than just fixing the leak.

---

## Testing Recommendations

To verify these bugs, test the following scenarios:

1. **Dirty flag**: Make a change, immediately press Cmd+S (within 100ms)
2. **Save errors**: Deny file permissions and try to save
3. **Rapid slide switching**: Click between slides rapidly
4. **Many files**: Open 20+ different .db files in one session
5. **Zero width**: Try to resize an object to 0 width via Properties panel

---

## Priority Recommendation

Fix in this order:
1. Bug #2 (Missing error feedback) - Critical for data safety
2. Bug #1 (Dirty flag timing) - Affects common user workflows
3. Bug #3 (Async without await) - Prevents race conditions
4. Bug #5 (Input validation) - Security best practice
5. Bug #4 (Connection leak) - Resource management
6. Bugs #6, #7 - Low impact, fix when touching related code

---

**End of Report**
