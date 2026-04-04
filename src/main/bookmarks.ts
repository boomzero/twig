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

// filePath → stop-access function returned by startAccessingSecurityScopedResource
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const stopFunctions = new Map<string, Function>()

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

/**
 * Save a base64-encoded security-scoped bookmark for a file path.
 * The bookmark data comes from Electron's dialog APIs when
 * `securityScopedBookmarks: true` is set.
 */
export function saveBookmark(filePath: string, base64Bookmark: string): void {
  store[filePath] = base64Bookmark
  persist()
}

/**
 * Start accessing all previously stored security-scoped bookmarks.
 * Call once on app startup — MAS builds only.
 */
export function startAccessingStoredBookmarks(): void {
  if (!process.mas) return
  store = load()
  for (const [filePath, base64] of Object.entries(store)) {
    try {
      // Electron's API accepts the base64 string directly
      const stop = app.startAccessingSecurityScopedResource(base64)
      stopFunctions.set(filePath, stop)
    } catch (err) {
      console.warn(`Failed to start accessing bookmark for ${filePath}:`, err)
    }
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
