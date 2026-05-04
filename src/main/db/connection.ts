/**
 * Database connection management - caching, LRU eviction, MAS shadow copies,
 * format probing, integrity checks, and the `withDbConnection` wrapper that
 * every IPC handler runs through.
 *
 * Internal state (`rwConnectionCache`, `roConnectionCache`, `readOnlyOpenPaths`,
 * `rwAccessOrder`, `roAccessOrder`, `masShadowCopies`) is intentionally NOT
 * exported. Callers must go through the named functions so the caches can't
 * desync from the read-only marker or from MAS shadow tracking.
 */

import { app } from 'electron'
import { join, isAbsolute, normalize } from 'path'
import fs from 'fs'
import crypto from 'crypto'
import Database from 'better-sqlite3'
import * as dbService from '../db'
import * as bookmarksService from '../bookmarks'
import { safeLog, formatError } from '../logging'
import {
  getTempDir,
  isPathInTempDir,
  ensureTempDir,
  registerTempFile,
  unregisterTempFile
} from '../files/tempManager'

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validates that a file path is safe to use.
 * Prevents path traversal and ensures the file has the correct extension.
 */
export function validateFilePath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== 'string') {
    throw new Error('File path must be a string')
  }
  if (!isAbsolute(filePath)) {
    throw new Error('File path must be absolute')
  }
  if (!filePath.endsWith('.tb')) {
    throw new Error('Invalid file extension. Expected .tb file')
  }
  const normalized = normalize(filePath)
  if (normalized !== filePath) {
    throw new Error('Invalid file path: path traversal detected')
  }
}

/**
 * Validates that a slide ID is a valid UUID v4.
 */
export function validateSlideId(slideId: unknown): asserts slideId is string {
  if (typeof slideId !== 'string') {
    throw new Error('Slide ID must be a string')
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(slideId)) {
    throw new Error('Invalid slide ID format. Expected UUID v4')
  }
}

// ============================================================================
// MAS shadow-copy management
// ============================================================================

const masShadowCopies = new Map<string, string>()

export function isMasExternalFilePath(filePath: string): boolean {
  return process.mas && !isPathInTempDir(filePath)
}

export function getMasShadowPath(filePath: string): string {
  if (!isMasExternalFilePath(filePath)) {
    return filePath
  }

  const existingShadowPath = masShadowCopies.get(filePath)
  if (existingShadowPath && fs.existsSync(existingShadowPath)) {
    return existingShadowPath
  }
  if (existingShadowPath) {
    masShadowCopies.delete(filePath)
    unregisterTempFile(existingShadowPath)
  }

  ensureMasFileAccess(filePath)
  ensureTempDir()
  const shadowPath = join(getTempDir(), `shadow-${crypto.randomUUID()}.tb`)
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, shadowPath)
    safeLog(`[db] created MAS shadow copy ${shadowPath} for ${filePath}`)
  } else {
    safeLog(`[db] reserved MAS shadow path ${shadowPath} for ${filePath}`)
  }
  registerTempFile(shadowPath)
  masShadowCopies.set(filePath, shadowPath)
  return shadowPath
}

export function getRuntimeDbPath(filePath: string): string {
  return isMasExternalFilePath(filePath) ? getMasShadowPath(filePath) : filePath
}

export function syncMasShadowCopy(filePath: string): void {
  const shadowPath = masShadowCopies.get(filePath)
  if (!shadowPath) {
    return
  }

  // Only the writable cache participates in shadow sync - RO connections
  // never produce WAL changes to flush.
  const db = rwConnectionCache.get(filePath)
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)')
  }

  ensureMasFileAccess(filePath)
  fs.copyFileSync(shadowPath, filePath)
  safeLog(`[db] synced MAS shadow copy ${shadowPath} -> ${filePath}`)
}

export function disposeMasShadowCopy(filePath: string): void {
  const shadowPath = masShadowCopies.get(filePath)
  if (!shadowPath) {
    return
  }

  masShadowCopies.delete(filePath)
  unregisterTempFile(shadowPath)

  for (const candidatePath of [shadowPath, `${shadowPath}-wal`, `${shadowPath}-shm`]) {
    try {
      if (fs.existsSync(candidatePath)) {
        fs.unlinkSync(candidatePath)
      }
    } catch (error) {
      safeLog(`Failed to delete MAS shadow file ${candidatePath}: ${formatError(error)}`, 'warn')
    }
  }
}

/**
 * Re-activates a stored security-scoped bookmark before touching a user-selected
 * file in MAS builds. Temp files live under the app container and do not need it.
 */
export function ensureMasFileAccess(filePath: string): void {
  if (!process.mas) return
  if (isPathInTempDir(filePath)) return
  const hasAccess = bookmarksService.ensureAccess(filePath)
  safeLog(`[bookmarks] ensureMasFileAccess path=${filePath} active=${hasAccess}`)
}

function shouldSkipExternalIntegrityChecks(filePath: string): boolean {
  return process.mas && !isPathInTempDir(filePath)
}

// ============================================================================
// Connection caches and LRU bookkeeping
// ============================================================================

/**
 * Caches of open database connections, keyed by file path.
 *
 * Read-write and read-only connections are tracked separately so that a file
 * opened read-only (because it was written by a newer twig format we can't
 * fully edit) cannot accidentally be re-opened as writable by a later caller.
 * Write paths must never see a file that is in the RO cache.
 */
const rwConnectionCache = new Map<string, Database.Database>()
const roConnectionCache = new Map<string, Database.Database>()

/**
 * Logical files that the user has opened in read-only mode.
 *
 * This is intentionally separate from `roConnectionCache`: cache entries are
 * allowed to disappear on suspend, stale-connection recovery, or LRU eviction,
 * but the open document should still be treated as read-only until the
 * renderer explicitly closes it.
 */
const readOnlyOpenPaths = new Set<string>()

/**
 * Maximum number of database connections to keep open simultaneously, per
 * cache. When this limit is exceeded, the least recently used connection in
 * that cache is closed.
 */
const MAX_CONNECTIONS = 3

/**
 * Tracks the access order of database connections for LRU eviction, per cache.
 * Most recently used connections are at the end of the array.
 */
const rwAccessOrder: string[] = []
const roAccessOrder: string[] = []

/** True if the file is currently open in read-only mode. */
export function isOpenedReadOnly(filePath: string): boolean {
  return readOnlyOpenPaths.has(filePath)
}

/** All file paths with an open connection (RW or RO). Used for suspend/shutdown. */
export function getOpenConnectionPaths(): string[] {
  return Array.from(new Set<string>([...rwConnectionCache.keys(), ...roConnectionCache.keys()]))
}

/**
 * Defensive cache eviction used after a Save-As that already closed connections.
 * Removes the path from both connection caches and from the read-only marker
 * set so a subsequent open of the same path starts cleanly.
 */
export function evictConnectionCaches(filePath: string): void {
  rwConnectionCache.delete(filePath)
  roConnectionCache.delete(filePath)
  readOnlyOpenPaths.delete(filePath)
}

function touchAccessOrder(order: string[], filePath: string): void {
  const index = order.indexOf(filePath)
  if (index !== -1) {
    order.splice(index, 1)
  }
  order.push(filePath)
}

// ============================================================================
// Connection accessors
// ============================================================================

/**
 * Retrieves or creates a read-write database connection for the given file.
 * Initializes schema, applies migrations, and stamps format metadata.
 *
 * Throws if the file is currently open as read-only - callers must close the
 * RO connection first.
 */
export function getWritableConnection(filePath: string): Database.Database {
  if (readOnlyOpenPaths.has(filePath)) {
    throw new Error(`Cannot open ${filePath} for writing: the file is currently open read-only`)
  }

  ensureMasFileAccess(filePath)
  const runtimePath = getRuntimeDbPath(filePath)
  safeLog(`[db] opening connection for ${filePath} (runtime=${runtimePath})`)

  // Return cached connection if available
  if (rwConnectionCache.has(filePath)) {
    touchAccessOrder(rwAccessOrder, filePath)
    return rwConnectionCache.get(filePath)!
  }

  // Check if file exists and validate it's a SQLite database (if it exists)
  const fileExists = fs.existsSync(runtimePath)
  safeLog(`[db] file exists=${fileExists} path=${runtimePath} logical=${filePath}`)
  if (fileExists) {
    let fd: number | undefined
    try {
      // Read the first 16 bytes to check for SQLite magic header
      fd = fs.openSync(runtimePath, 'r')
      const buffer = Buffer.alloc(16)
      fs.readSync(fd, buffer, 0, 16, 0)

      // SQLite files start with "SQLite format 3\0"
      const fileHeader = buffer.toString('utf8', 0, 16)

      if (!fileHeader.startsWith('SQLite format 3')) {
        throw new Error(
          `File ${runtimePath} is not a valid SQLite database. Please select a valid twig presentation file.`
        )
      }
    } catch (error) {
      // If it's our validation error, re-throw it
      if (error instanceof Error && error.message.includes('not a valid SQLite database')) {
        throw error
      }
      // For other errors (e.g., file access errors), log and continue
      // The Database constructor will provide a more specific error
      console.warn('Could not validate database file header:', error)
    } finally {
      // Always close the file descriptor to prevent leaks
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch (closeError) {
          console.error('Failed to close file descriptor:', closeError)
        }
      }
    }
  }

  // Create new connection, initialize schema, and cache it.
  // If the path is under TEMP_DIR, recreate the directory in case it was
  // deleted externally (e.g. after the system woke from sleep).
  if (isPathInTempDir(runtimePath)) {
    ensureTempDir()
  }

  let db: Database.Database
  try {
    db = new Database(runtimePath)
  } catch (error) {
    if (error instanceof Error && error.message.includes('not a database')) {
      throw new Error(
        `File ${runtimePath} is not a valid SQLite database. Please select a valid twig presentation file.`
      )
    }
    safeLog(
      `[db] Database constructor failed for ${filePath} (runtime=${runtimePath}): ${formatError(error)}`,
      'error'
    )
    throw error
  }

  try {
    dbService.configureDatabaseConnection(db)

    if (fileExists && !shouldSkipExternalIntegrityChecks(runtimePath)) {
      verifyDatabaseQuickCheck(db, runtimePath)
    } else if (fileExists) {
      safeLog(`[db] skipping quick_check for MAS external file ${runtimePath}`, 'warn')
    }

    dbService.initializeDatabase(db, app.getVersion())

    // Implement LRU eviction: if cache is full, close least recently used connection
    if (rwConnectionCache.size >= MAX_CONNECTIONS) {
      const lruPath = rwAccessOrder.shift() // Remove least recently used
      if (lruPath && rwConnectionCache.has(lruPath)) {
        try {
          closeDbConnection(lruPath, 'none')
          safeLog(`Closed LRU database connection: ${lruPath}`)
        } catch (closeError) {
          console.error(`Error closing LRU connection for ${lruPath}:`, closeError)
          // Continue anyway - we'll still add the new connection
        }
      }
    }

    // Cache the new connection and add to access order
    rwConnectionCache.set(filePath, db)
    rwAccessOrder.push(filePath)
    return db
  } catch (error) {
    // Close connection on initialization error to prevent leak
    db.close()
    throw error
  }
}

/**
 * Retrieves or creates a read-only database connection for a `.tb` file that
 * the user asked to open read-only (typically because it's newer than this
 * build understands). Never mutates the file: no schema creation, no
 * migrations, no stamping.
 *
 * Validates that the file is actually a twig presentation before caching.
 * Refuses fresh/empty SQLite files (there's nothing to view).
 */
export function getReadOnlyConnection(filePath: string): Database.Database {
  if (rwConnectionCache.has(filePath)) {
    throw new Error(`Cannot open ${filePath} read-only: the file is already open for writing`)
  }

  ensureMasFileAccess(filePath)
  const runtimePath = getRuntimeDbPath(filePath)

  if (roConnectionCache.has(filePath)) {
    touchAccessOrder(roAccessOrder, filePath)
    return roConnectionCache.get(filePath)!
  }

  const fileExists = fs.existsSync(runtimePath)
  if (!fileExists) {
    throw new Error(`File does not exist: ${runtimePath}`)
  }

  let db: Database.Database
  try {
    db = new Database(runtimePath, { readonly: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('not a database')) {
      throw new Error(
        `File ${runtimePath} is not a valid SQLite database. Please select a valid twig presentation file.`
      )
    }
    throw error
  }

  try {
    dbService.configureDatabaseConnection(db)

    const format = dbService.detectFormat(db)
    if (format.status === 'notTwig') {
      throw new dbService.NotATwigFileError()
    }
    // Read-only mode exists for one reason: the file is too new to migrate
    // safely. For every other status (fresh, legacy, current, older) the
    // correct open mode is read-write. This enforcement is the main-process
    // defense-in-depth; the renderer is expected to have probed first and
    // only request RO when status is `tooNew`.
    if (format.status !== 'tooNew') {
      throw new Error(
        `Read-only open is only for files newer than this build; got status "${format.status}"`
      )
    }

    if (roConnectionCache.size >= MAX_CONNECTIONS) {
      const lruPath = roAccessOrder.shift()
      if (lruPath && roConnectionCache.has(lruPath)) {
        try {
          closeDbConnection(lruPath, 'none')
        } catch (closeError) {
          console.error(`Error closing LRU RO connection for ${lruPath}:`, closeError)
        }
      }
    }

    roConnectionCache.set(filePath, db)
    readOnlyOpenPaths.add(filePath)
    roAccessOrder.push(filePath)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/**
 * Returns a readable connection for `filePath`. Prefers an existing read-only
 * connection if one is cached; if the logical file is open read-only but its
 * cached connection was evicted/closed, re-establishes a read-only connection.
 * Otherwise falls through to the writable connection (which is also readable).
 * Use this for read-only operations inside `withDbConnection({ write: false })`.
 */
export function getReadableConnection(filePath: string): Database.Database {
  if (roConnectionCache.has(filePath)) {
    touchAccessOrder(roAccessOrder, filePath)
    return roConnectionCache.get(filePath)!
  }
  if (readOnlyOpenPaths.has(filePath)) {
    return getReadOnlyConnection(filePath)
  }
  return getWritableConnection(filePath)
}

/**
 * Probes a `.tb` candidate file for its format identity without mutating it.
 * Opens a short-lived read-only SQLite connection that bypasses the cache.
 *
 * Used by the renderer's open flow to detect files newer than this build
 * understands (so it can show a compat-notes warning) and to reject non-twig
 * SQLite files up front with a clear error.
 */
export function probeDatabaseFormat(filePath: string): dbService.FormatProbeResult {
  ensureMasFileAccess(filePath)

  let probePath = filePath
  let disposableProbePath: string | null = null

  if (isMasExternalFilePath(filePath)) {
    ensureTempDir()
    disposableProbePath = join(getTempDir(), `probe-${crypto.randomUUID()}.tb`)
    fs.copyFileSync(filePath, disposableProbePath)
    probePath = disposableProbePath
    safeLog(`[db] probing MAS external file via temp copy ${probePath} for ${filePath}`)
  }

  if (!fs.existsSync(probePath)) {
    throw new Error(`File does not exist: ${filePath}`)
  }

  let db: Database.Database | null = null
  try {
    try {
      db = new Database(probePath, { readonly: true })
    } catch (error) {
      if (error instanceof Error && error.message.includes('not a database')) {
        return { status: 'notTwig' }
      }
      throw error
    }

    dbService.configureDatabaseConnection(db)
    return dbService.detectFormat(db)
  } finally {
    if (db) {
      try {
        db.close()
      } catch (closeError) {
        safeLog(`[db] failed to close probe connection: ${formatError(closeError)}`, 'warn')
      }
    }
    if (disposableProbePath) {
      for (const candidatePath of [
        disposableProbePath,
        `${disposableProbePath}-wal`,
        `${disposableProbePath}-shm`
      ]) {
        try {
          if (fs.existsSync(candidatePath)) {
            fs.unlinkSync(candidatePath)
          }
        } catch (cleanupError) {
          safeLog(
            `[db] failed to clean up probe copy ${candidatePath}: ${formatError(cleanupError)}`,
            'warn'
          )
        }
      }
    }
  }
}

// ============================================================================
// File-op retry & integrity checks
// ============================================================================

/**
 * Error codes that indicate file is locked or inaccessible and should be retried.
 */
const RETRYABLE_FILE_ERROR_CODES = ['EBUSY', 'EPERM', 'EACCES']

/**
 * Retry a file operation with exponential backoff on Windows.
 * On Windows, closing a database connection doesn't immediately release the file lock.
 * This function retries the operation with increasing delays.
 */
export async function retryFileOperation<T>(
  operation: () => T,
  maxRetries: number = 5
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return operation()
    } catch (error) {
      const errCode = (error as NodeJS.ErrnoException).code

      // Only retry on file locking errors
      if (!RETRYABLE_FILE_ERROR_CODES.includes(errCode || '')) {
        throw error
      }

      lastError = error as Error

      // Don't wait after the last attempt
      if (attempt < maxRetries - 1) {
        // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms
        const delay = 50 * Math.pow(2, attempt)
        console.log(
          `File operation failed (${errCode}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  // All retries failed
  throw lastError || new Error('File operation failed after all retries')
}

/**
 * Verifies database integrity using PRAGMA integrity_check.
 * Performs robust validation of the pragma result format.
 */
export function verifyDatabaseIntegrity(filePath: string, context: string): void {
  if (shouldSkipExternalIntegrityChecks(filePath)) {
    safeLog(`[db] skipping integrity_check for MAS external file ${filePath} (${context})`, 'warn')
    return
  }
  ensureMasFileAccess(filePath)
  const testDb = new Database(filePath, { readonly: true })

  try {
    dbService.configureDatabaseConnection(testDb)
    verifyPragmaCheck(testDb.pragma('integrity_check'), 'integrity_check')
  } finally {
    testDb.close()
  }

  safeLog(`Database integrity verified (${context}): ${filePath}`)
}

/**
 * Validates the output shape for SQLite integrity-style PRAGMAs.
 */
export function verifyPragmaCheck(
  result: unknown,
  pragmaName: 'integrity_check' | 'quick_check'
): void {
  if (!Array.isArray(result)) {
    throw new Error(`${pragmaName} returned non-array result: ${JSON.stringify(result)}`)
  }

  if (result.length === 0) {
    throw new Error(`${pragmaName} returned empty array`)
  }

  const firstRow = result[0] as Record<string, unknown> | undefined
  const pragmaValue = firstRow?.[pragmaName]
  if (pragmaValue !== 'ok') {
    throw new Error(`${pragmaName} failed: ${JSON.stringify(result)}`)
  }
}

/**
 * Runs a lightweight consistency check when opening an existing presentation.
 *
 * Note: this is intentionally called after `dbService.configureDatabaseConnection`,
 * which sets mmap_size = 0. SQLite's quick_check does not require mmap-backed I/O and
 * still detects corruption correctly with mmap disabled.
 */
export function verifyDatabaseQuickCheck(db: Database.Database, filePath: string): void {
  verifyPragmaCheck(db.pragma('quick_check'), 'quick_check')
  safeLog(`Database quick_check verified on open: ${filePath}`)
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Closes and removes a database connection from the cache.
 * This should be called before overwriting or deleting a database file.
 *
 * @param filePath - Absolute path to the .tb file
 * @param checkpointMode - WAL checkpoint mode: 'none' (no checkpoint), 'passive' (non-blocking), 'truncate' (full checkpoint)
 */
export function closeDbConnection(
  filePath: string,
  checkpointMode: 'none' | 'passive' | 'truncate' = 'none',
  options: { forgetReadOnly?: boolean } = {}
): void {
  const hasShadowCopy = masShadowCopies.has(filePath)

  // Close the writable connection (if any). Shadow sync + WAL checkpoint only
  // apply here - RO connections never mutate the file.
  if (rwConnectionCache.has(filePath)) {
    try {
      const db = rwConnectionCache.get(filePath)!

      if (hasShadowCopy) {
        try {
          syncMasShadowCopy(filePath)
        } catch (checkpointError) {
          safeLog(
            `Failed to sync MAS shadow copy for ${filePath}: ${formatError(checkpointError)}`,
            'warn'
          )
        }
      } else if (checkpointMode !== 'none') {
        try {
          const mode = checkpointMode === 'passive' ? 'PASSIVE' : 'TRUNCATE'
          db.pragma(`wal_checkpoint(${mode})`)
          safeLog(`Checkpointed WAL (${mode}) for ${filePath}`)
        } catch (checkpointError) {
          safeLog(`Failed to checkpoint WAL for ${filePath}: ${checkpointError}`, 'warn')
          // Continue anyway - close will still work
        }
      }

      db.close()
    } catch (error) {
      safeLog(`Error closing database connection for ${filePath}: ${error}`, 'error')
    }
    rwConnectionCache.delete(filePath)
    const rwIndex = rwAccessOrder.indexOf(filePath)
    if (rwIndex !== -1) {
      rwAccessOrder.splice(rwIndex, 1)
    }
  }

  // Close the read-only connection (if any).
  if (roConnectionCache.has(filePath)) {
    try {
      roConnectionCache.get(filePath)!.close()
    } catch (error) {
      safeLog(`Error closing RO database connection for ${filePath}: ${error}`, 'error')
    }
    roConnectionCache.delete(filePath)
    const roIndex = roAccessOrder.indexOf(filePath)
    if (roIndex !== -1) {
      roAccessOrder.splice(roIndex, 1)
    }
  }

  if (hasShadowCopy) {
    disposeMasShadowCopy(filePath)
  }

  if (options.forgetReadOnly) {
    readOnlyOpenPaths.delete(filePath)
  }
}

/**
 * Executes a database operation.
 * The powerMonitor 'suspend' handler closes all connections before sleep, so
 * SQLITE_READONLY_DBMOVED should never occur. If it somehow does (e.g. forced
 * hibernate), we evict the stale connection and surface the error clearly so
 * the renderer can recover gracefully.
 */
export function withDbConnection<T>(
  filePath: string,
  fn: (db: Database.Database) => T,
  options: { syncShadowBack?: boolean; write?: boolean } = {}
): T {
  const runOperation = (): T => {
    // Write paths must refuse files that are open read-only.
    if (options.write && readOnlyOpenPaths.has(filePath)) {
      throw new Error(
        `Presentation is open read-only: ${filePath}. Writes are disabled for files written by a newer version of twig.`
      )
    }
    const db = options.write ? getWritableConnection(filePath) : getReadableConnection(filePath)
    const result = fn(db)
    // Stamp provenance BEFORE the MAS shadow is flushed, so the copy sees the
    // refreshed `last_written_with_app_version` row.
    if (options.write) {
      dbService.stampFileMetadata(db, app.getVersion())
    }
    if (options.syncShadowBack) {
      syncMasShadowCopy(filePath)
    }
    return result
  }

  try {
    return runOperation()
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_READONLY_DBMOVED') {
      // Stale connection (file was moved/renamed while the connection was open).
      // Evict it and retry once with a fresh connection.
      closeDbConnection(filePath, 'none')
      safeLog(
        `Retrying after stale DB connection for ${filePath} (SQLITE_READONLY_DBMOVED)`,
        'warn'
      )
      return runOperation()
    }
    throw error
  }
}
