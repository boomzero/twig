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
 * Maximum age for orphaned temp files before automatic cleanup (24 hours).
 */
const TEMP_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000

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
 * Ensures the temp directory exists and cleans up old orphaned temp files.
 * The orphan sweep runs on EVERY call (not memoized) - current behavior.
 */
export function ensureTempDir(): void {
  // Create temp directory with restrictive permissions (user-only access)
  // Mode 0o700 = rwx------ (owner read/write/execute only)
  fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 })

  // Clean up orphaned temp files older than 24 hours (crash recovery)
  try {
    const now = Date.now()

    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR)
      for (const file of files) {
        if (file.endsWith('.tb')) {
          const filePath = join(TEMP_DIR, file)
          try {
            const stats = fs.statSync(filePath)
            if (now - stats.mtimeMs > TEMP_FILE_MAX_AGE_MS) {
              fs.unlinkSync(filePath)
              console.log(`Cleaned up orphaned temp file: ${filePath}`)
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
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
        safeLog(`Deleted temp file: ${tempPath}`)
      }
    } catch (error) {
      safeLog(`Failed to delete temp file ${tempPath}: ${error}`, 'warn')
    }
  }
  tempFilePaths.clear()
}

/**
 * Recursively removes the temp directory. Used on app shutdown after
 * `cleanupAllTempFiles`.
 */
export function removeTempDir(): void {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true })
      safeLog('Cleaned up temp directory')
    }
  } catch (error) {
    safeLog(`Failed to clean up temp directory: ${error}`, 'warn')
  }
}
