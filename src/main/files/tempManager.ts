/**
 * Temporary file management for unsaved presentations and MAS shadow copies.
 *
 * The in-memory `tempFilePaths` set is for cleanup tracking (delete on shutdown,
 * delete guards). It is NOT authoritative across restarts - `db:is-temp-file`
 * intentionally uses a path-based `realpathSync` check against `getTempDir()` so
 * crash-recovered temp files are still recognized.
 */

import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { safeLog } from '../logging'

/**
 * Temporary directory for unsaved presentations.
 * Each new presentation gets a temp database here until the user saves it.
 * Uses userData directory (user-specific) instead of system temp for security.
 */
const TEMP_DIR = join(app.getPath('userData'), 'temp')

/**
 * Maximum age for disposable probe files before automatic cleanup.
 * Unsaved `temp-*.tb` presentations are deliberately never age-swept: after a
 * crash they may be the user's only recoverable copy. Shadow files are also
 * preserved because a failed MAS sync can leave the newest data there.
 */
const DISPOSABLE_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Tracks which database file paths are temporary files.
 * Used to clean up temp files on app shutdown and to guard delete operations.
 */
const tempFilePaths = new Set<string>()

export function getTempDir(): string {
  return TEMP_DIR
}

export function isPathInTempDir(filePath: string): boolean {
  return filePath.startsWith(TEMP_DIR)
}

/**
 * Ensures the temp directory exists and cleans up only disposable probe
 * artifacts. Crash-recovered unsaved presentations are preserved indefinitely.
 */
export function ensureTempDir(): void {
  // Create temp directory with restrictive permissions (user-only access)
  // Mode 0o700 = rwx------ (owner read/write/execute only)
  fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 })

  // Clean up orphaned disposable files older than 24 hours.
  try {
    const now = Date.now()

    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR)
      for (const file of files) {
        const disposableMatch = /^probe-.+\.tb(?:-(?:wal|shm))?$/.test(file)
        const mainPath = join(TEMP_DIR, file.replace(/-(?:wal|shm)$/, ''))
        if (disposableMatch && !tempFilePaths.has(mainPath)) {
          const filePath = join(TEMP_DIR, file)
          try {
            const stats = fs.statSync(filePath)
            if (now - stats.mtimeMs > DISPOSABLE_FILE_MAX_AGE_MS) {
              fs.unlinkSync(filePath)
              safeLog(`Cleaned up orphaned disposable file: ${filePath}`)
            }
          } catch (err) {
            console.warn(`Failed to clean up temp file ${filePath}:`, err)
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to clean up temp directory:', error)
  }
}

/**
 * Returns a fresh `temp-<uuid>.tb` path inside the temp directory.
 * Does NOT register the path - register only after successful initialization
 * so failed-init candidates don't get tracked for shutdown deletion.
 */
export function createTempDbPath(): string {
  return join(TEMP_DIR, `temp-${crypto.randomUUID()}.tb`)
}

export function registerTempFile(filePath: string): void {
  tempFilePaths.add(filePath)
}

export function unregisterTempFile(filePath: string): void {
  tempFilePaths.delete(filePath)
}

/** True iff the path is in the in-memory tracked set. NOT for `db:is-temp-file`. */
export function isTempFile(filePath: string): boolean {
  return tempFilePaths.has(filePath)
}

export function getRegisteredTempFiles(): readonly string[] {
  return Array.from(tempFilePaths)
}

/**
 * Unlink every tracked temp file. Used on app shutdown.
 * Logs (not throws) failures so shutdown can continue.
 */
export function cleanupAllTempFiles(): void {
  for (const tempPath of tempFilePaths) {
    for (const candidatePath of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
      try {
        if (fs.existsSync(candidatePath)) {
          fs.unlinkSync(candidatePath)
          safeLog(`Deleted temp file: ${candidatePath}`)
        }
      } catch (error) {
        safeLog(`Failed to delete temp file ${candidatePath}: ${error}`, 'warn')
      }
    }
  }
  tempFilePaths.clear()
}

/**
 * Removes the temp directory only when empty. Unregistered crash-recovery files
 * must survive a later clean shutdown.
 */
export function removeTempDir(): void {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmdirSync(TEMP_DIR)
      safeLog('Removed empty temp directory')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return
    safeLog(`Failed to clean up temp directory: ${error}`, 'warn')
  }
}
