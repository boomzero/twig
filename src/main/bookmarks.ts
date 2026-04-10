/**
 * Security-scoped bookmark management for macOS App Store (MAS) builds.
 *
 * On MAS, the sandbox limits file access to files the user has explicitly
 * chosen via open/save dialogs. Security-scoped bookmarks let the app
 * re-access those files in future sessions without requiring another dialog.
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const BOOKMARKS_PATH = join(app.getPath('userData'), 'twig-bookmarks.json')

// filePath → base64-encoded security-scoped bookmark data
type BookmarkStore = Record<string, string>

let store: BookmarkStore = {}
let hasLoadedStore = false

// filePath → stop-access function returned by startAccessingSecurityScopedResource
const stopFunctions = new Map<string, () => void>()

function load(): BookmarkStore {
  try {
    if (existsSync(BOOKMARKS_PATH)) {
      return JSON.parse(readFileSync(BOOKMARKS_PATH, 'utf-8')) as BookmarkStore
    }
  } catch {
    // Corrupted or missing — start fresh
  }
  return {}
}

function persist(): void {
  try {
    writeFileSync(BOOKMARKS_PATH, JSON.stringify(store), 'utf-8')
  } catch (err) {
    console.warn('Failed to persist bookmarks:', err)
  }
}

function ensureStoreLoaded(): void {
  if (hasLoadedStore) return
  store = load()
  hasLoadedStore = true
}

function stopAccessing(filePath: string): void {
  const stop = stopFunctions.get(filePath)
  if (!stop) return

  try {
    stop()
  } catch {
    // ignore
  }

  stopFunctions.delete(filePath)
}

/**
 * Save a base64-encoded security-scoped bookmark for a file path.
 * The bookmark data comes from Electron's dialog APIs when
 * `securityScopedBookmarks: true` is set.
 */
export function saveBookmark(filePath: string, base64Bookmark: string): void {
  ensureStoreLoaded()
  store[filePath] = base64Bookmark
  persist()

  // Overwriting a file can invalidate an older active scope for the same path.
  // Refresh immediately so subsequent file access uses the newest bookmark.
  if (process.mas && stopFunctions.has(filePath)) {
    stopAccessing(filePath)
    ensureAccess(filePath)
  }
}

/**
 * Ensure we are actively accessing a previously stored security-scoped bookmark.
 * Returns false when no bookmark is available for the path.
 */
export function ensureAccess(filePath: string): boolean {
  if (!process.mas) return true

  ensureStoreLoaded()

  if (stopFunctions.has(filePath)) {
    console.log(`[bookmarks] access already active for ${filePath}`)
    return true
  }

  const base64 = store[filePath]
  if (!base64) {
    console.warn(`[bookmarks] no stored bookmark for ${filePath}`)
    return false
  }

  try {
    stopAccessing(filePath)
    const stop = app.startAccessingSecurityScopedResource(base64) as () => void
    stopFunctions.set(filePath, stop)
    console.log(`[bookmarks] started access for ${filePath}`)
    return true
  } catch (err) {
    console.warn(`Failed to start accessing bookmark for ${filePath}:`, err)
    return false
  }
}

/**
 * Start accessing all previously stored security-scoped bookmarks.
 * Call once on app startup — MAS builds only.
 */
export function startAccessingStoredBookmarks(): void {
  if (!process.mas) return
  ensureStoreLoaded()
  for (const filePath of Object.keys(store)) {
    ensureAccess(filePath)
  }
}

/**
 * Stop accessing all security-scoped resources.
 * Call when the app is about to quit.
 */
export function stopAccessingAllBookmarks(): void {
  for (const stop of stopFunctions.values()) {
    try {
      stop()
    } catch {
      // ignore
    }
  }
  stopFunctions.clear()
}
