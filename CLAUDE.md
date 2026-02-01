# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Deckhand is a presentation editor built with Electron, Svelte 5, and fabric.js. It allows users to create slide decks with text and shapes, which are stored in SQLite database files (.db format).

## Tech Stack

- **Electron**: Desktop application framework
- **Svelte 5**: Frontend framework using the new runes syntax (`$state`, `$effect`, etc.)
- **fabric.js**: Canvas manipulation library for handling shapes and text
- **better-sqlite3**: SQLite database for persistent storage
- **TypeScript**: Type safety across main, preload, and renderer processes
- **TailwindCSS**: Styling
- **electron-vite**: Build tooling

## Common Commands

### Development

```bash
npm run dev              # Start development server with hot reload
npm start                # Preview production build
```

### Building

```bash
npm run build            # Type-check and build for production
npm run build:mac        # Build for macOS
npm run build:win        # Build for Windows
npm run build:linux      # Build for Linux
npm run build:unpack     # Build without packaging
```

### Code Quality

```bash
npm run lint             # Run ESLint
npm run format           # Format code with Prettier
npm run typecheck        # Run TypeScript type checking
npm run typecheck:node   # Check main/preload process types only
npm run svelte-check     # Check Svelte component types
```

### Native Dependencies

```bash
npm run rebuild          # Rebuild native modules (e.g., after Node version change)
```

## Architecture

### Three-Process Model

Deckhand follows Electron's standard architecture:

1. **Main Process** (`src/main/index.ts`): Node.js process that manages the application lifecycle, native APIs (dialogs, file system), and database connections
2. **Preload Script** (`src/preload/index.ts`): Bridge layer that safely exposes IPC handlers to the renderer via `contextBridge`
3. **Renderer Process** (`src/renderer/`): Svelte application running in the browser context

### Database Layer (`src/main/db.ts`)

- Uses better-sqlite3 for synchronous SQLite operations
- Schema: `slides` table (id, slide_order) and `elements` table (properties of shapes/text)
- Connection caching: Main process maintains a Map of open database connections by file path
- All database operations are transactional for consistency

### State Management (`src/renderer/src/lib/state.svelte.ts`)

- Global application state using Svelte 5's `$state` rune
- Tracks:
  - Current file path (null for unsaved presentations)
  - In-memory slides (for new, unsaved presentations)
  - Current slide and slide index
  - Selected object ID
  - Dirty flag for unsaved changes
- State updates trigger reactive re-renders via `$effect` in App.svelte

### Canvas Rendering (`src/renderer/src/App.svelte`)

- Fabric.js Canvas manages the visual representation of slide elements
- Key pattern: State is the source of truth, Canvas reflects state
- When state changes → Canvas re-renders (`renderCanvasFromState`)
- When Canvas objects are modified → State is updated (`updateStateFromObject`)
- Selection state is preserved across re-renders when possible

### IPC Communication

The preload script exposes these APIs to the renderer:

- `window.api.dialog`: File open/save dialogs
- `window.api.db`: All database operations (getSlideIds, getSlide, createSlide, saveSlide, saveAs)

All IPC calls are asynchronous and return Promises.

## Key Concepts

### Svelte 5 Runes

This project uses Svelte 5's runes syntax. See `svelte-docs-for-llms.md` for full documentation. Common patterns:

- `$state()`: Reactive state
- `$effect()`: Side effects that run when dependencies change
- `$derived()`: Computed values (not currently used but available)

### File Persistence Model

**Saved presentations** (has `currentFilePath`):

- Slides stored in SQLite database
- Individual slides loaded on-demand from DB
- Save operation updates only the current slide

**Unsaved presentations** (no `currentFilePath`):

- All slides stored in `inMemorySlides` array
- Save As operation required to persist to disk

### fabric.js Custom Properties

Canvas objects are extended with an `id` property to link them back to state:

```typescript
type DeckFabricObject = FabricObject & { id?: string }
```

This ID is crucial for synchronizing Canvas modifications back to the state.

## Important Files

- `src/main/index.ts`: Main process entry, IPC handlers, window management
- `src/main/db.ts`: Database schema and CRUD operations
- `src/renderer/src/App.svelte`: Main UI component, Canvas logic, event handlers
- `src/renderer/src/lib/state.svelte.ts`: Global state management
- `src/preload/index.ts`: IPC bridge definitions
- `AGENTS.md`: Notes about technology choices

## Debugging & Development Tools

### Debug Window

A separate debug window allows real-time inspection of the application state:

- **Keyboard shortcut**: Press `Cmd/Ctrl+Shift+D` to open the debug window
- **UI button**: Click the "Debug" button in the toolbar
- **Console access**: State is exposed on `window.__DECKHAND_STATE__` for console inspection
- **Features**:
  - Real-time state updates - automatically reflects changes from the main window
  - View current file path and persistence mode
  - Inspect all slide IDs and current slide details
  - Monitor selection state and loading flags
  - View all elements on the current slide
  - Copy state snapshot to clipboard
  - Log full state to console
  - Separate window can be positioned on another monitor

The debug window is implemented in `src/renderer/src/Debug.svelte` and uses IPC to receive state updates from the main window.

## Known Dependencies

- `runed`: Utility library (currently unused but available for features like StateHistory)
- Coordinate system: fabric.js objects use center origin by default (`originX/Y = 'center'`)
