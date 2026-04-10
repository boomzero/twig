/**
 * Main process entry point for twig presentation editor.
 *
 * This file manages:
 * - Application lifecycle (startup, shutdown)
 * - Window creation and management
 * - IPC communication between main and renderer processes
 * - Database connection caching and management
 */

import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  powerMonitor,
  webContents,
  Menu
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { join, isAbsolute, normalize, basename, extname, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import Database from 'better-sqlite3'
import * as dbService from './db'
import type { Slide, FontData } from './db'
import { getPref, setPref } from './prefs'
import * as bookmarksService from './bookmarks'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import fontkit from 'fontkit'

// Suppress EIO errors on stdout/stderr that occur when the computer sleeps.
// Node.js emits 'error' events asynchronously on these streams when the
// underlying pipe is broken; without a listener, they crash the process.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EIO') throw err
})
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EIO') throw err
})

// ============================================================================
// Input Validation
// ============================================================================

/**
 * Validates that a file path is safe to use.
 * Prevents path traversal and ensures the file has the correct extension.
 *
 * @param filePath - The file path to validate
 * @throws Error if the file path is invalid
 */
function validateFilePath(filePath: string): void {
  // Ensure it's an absolute path
  if (!isAbsolute(filePath)) {
    throw new Error('File path must be absolute')
  }

  // Ensure it ends with .tb
  if (!filePath.endsWith('.tb')) {
    throw new Error('Invalid file extension. Expected .tb file')
  }

  // Prevent path traversal by ensuring normalized path matches original
  const normalized = normalize(filePath)
  if (normalized !== filePath) {
    throw new Error('Invalid file path: path traversal detected')
  }
}

/**
 * Validates that a slide ID is a valid UUID v4.
 *
 * @param slideId - The slide ID to validate
 * @throws Error if the slide ID is invalid
 */
function validateSlideId(slideId: string): void {
  // UUID v4 regex pattern
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(slideId)) {
    throw new Error('Invalid slide ID format. Expected UUID v4')
  }
}

// ============================================================================
// Temp Directory Management
// ============================================================================

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
 * Used to clean up temp files on app shutdown.
 */
const tempFilePaths = new Set<string>()
const masShadowCopies = new Map<string, string>()

const PRIVACY_POLICY_URL = 'https://twig.boomzero.uk/privacy/'
const isStoreManagedBuild =
  process.mas === true ||
  (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true

function isMasExternalFilePath(filePath: string): boolean {
  return process.mas && !filePath.startsWith(TEMP_DIR)
}

function getMasShadowPath(filePath: string): string {
  if (!isMasExternalFilePath(filePath)) {
    return filePath
  }

  const existingShadowPath = masShadowCopies.get(filePath)
  if (existingShadowPath && fs.existsSync(existingShadowPath)) {
    return existingShadowPath
  }
  if (existingShadowPath) {
    masShadowCopies.delete(filePath)
    tempFilePaths.delete(existingShadowPath)
  }

  ensureMasFileAccess(filePath)
  ensureTempDir()
  const shadowPath = join(TEMP_DIR, `shadow-${crypto.randomUUID()}.tb`)
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, shadowPath)
    safeLog(`[db] created MAS shadow copy ${shadowPath} for ${filePath}`)
  } else {
    safeLog(`[db] reserved MAS shadow path ${shadowPath} for ${filePath}`)
  }
  tempFilePaths.add(shadowPath)
  masShadowCopies.set(filePath, shadowPath)
  return shadowPath
}

function getRuntimeDbPath(filePath: string): string {
  return isMasExternalFilePath(filePath) ? getMasShadowPath(filePath) : filePath
}

function syncMasShadowCopy(filePath: string): void {
  const shadowPath = masShadowCopies.get(filePath)
  if (!shadowPath) {
    return
  }

  const db = connectionCache.get(filePath)
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)')
  }

  ensureMasFileAccess(filePath)
  fs.copyFileSync(shadowPath, filePath)
  safeLog(`[db] synced MAS shadow copy ${shadowPath} -> ${filePath}`)
}

function disposeMasShadowCopy(filePath: string): void {
  const shadowPath = masShadowCopies.get(filePath)
  if (!shadowPath) {
    return
  }

  masShadowCopies.delete(filePath)
  tempFilePaths.delete(shadowPath)

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
 * Ensures the temp directory exists and cleans up old orphaned temp files.
 * Called on app startup and when creating new temp databases.
 */
function ensureTempDir(): void {
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

// ============================================================================
// Database Connection Management
// ============================================================================

/**
 * Cache of open database connections, keyed by file path.
 * This prevents opening multiple connections to the same file and improves performance.
 */
const connectionCache = new Map<string, Database.Database>()

/**
 * Maximum number of database connections to keep open simultaneously.
 * When this limit is exceeded, the least recently used connection is closed.
 */
const MAX_CONNECTIONS = 3

/**
 * Tracks the access order of database connections for LRU eviction.
 * Most recently used connections are at the end of the array.
 */
const accessOrder: string[] = []

/**
 * Retrieves or creates a database connection for the given file.
 * Connections are cached for reuse across multiple operations.
 *
 * @param filePath - Absolute path to the .tb file
 * @returns The database connection instance
 * @throws Error if the file is not a valid SQLite database
 */
function getDbConnection(filePath: string): Database.Database {
  ensureMasFileAccess(filePath)
  const runtimePath = getRuntimeDbPath(filePath)
  safeLog(`[db] opening connection for ${filePath} (runtime=${runtimePath})`)

  // Return cached connection if available
  if (connectionCache.has(filePath)) {
    // Update access order - move to end (most recently used)
    const index = accessOrder.indexOf(filePath)
    if (index !== -1) {
      accessOrder.splice(index, 1)
    }
    accessOrder.push(filePath)
    return connectionCache.get(filePath)!
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
  if (runtimePath.startsWith(TEMP_DIR)) {
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

    dbService.initializeDatabase(db)

    // Implement LRU eviction: if cache is full, close least recently used connection
    if (connectionCache.size >= MAX_CONNECTIONS) {
      const lruPath = accessOrder.shift() // Remove least recently used
      if (lruPath && connectionCache.has(lruPath)) {
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
    connectionCache.set(filePath, db)
    accessOrder.push(filePath)
    return db
  } catch (error) {
    // Close connection on initialization error to prevent leak
    db.close()
    throw error
  }
}

/**
 * Error codes that indicate file is locked or inaccessible and should be retried.
 */
const RETRYABLE_FILE_ERROR_CODES = ['EBUSY', 'EPERM', 'EACCES']

/**
 * Retry a file operation with exponential backoff on Windows.
 * On Windows, closing a database connection doesn't immediately release the file lock.
 * This function retries the operation with increasing delays.
 *
 * @param operation - The file operation to retry
 * @param maxRetries - Maximum number of retry attempts (default: 5)
 * @returns The result of the successful operation
 * @throws The last error if all retries fail
 */
async function retryFileOperation<T>(operation: () => T, maxRetries: number = 5): Promise<T> {
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
 *
 * @param filePath - Path to the database file to check
 * @param context - Description of when/why this check is being performed (for error messages)
 * @throws Error if integrity check fails or returns unexpected format
 */
function verifyDatabaseIntegrity(filePath: string, context: string): void {
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
function verifyPragmaCheck(result: unknown, pragmaName: 'integrity_check' | 'quick_check'): void {
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
 * Note: this is intentionally called after {@link dbService.configureDatabaseConnection},
 * which sets mmap_size = 0. SQLite's quick_check does not require mmap-backed I/O and
 * still detects corruption correctly with mmap disabled.
 */
function verifyDatabaseQuickCheck(db: Database.Database, filePath: string): void {
  verifyPragmaCheck(db.pragma('quick_check'), 'quick_check')
  safeLog(`Database quick_check verified on open: ${filePath}`)
}

function shouldSkipExternalIntegrityChecks(filePath: string): boolean {
  return process.mas && !filePath.startsWith(TEMP_DIR)
}

/**
 * Safely logs a message, ignoring errors if console is unavailable (e.g., during shutdown).
 * This prevents crashes when logging during application exit.
 */
function safeLog(message: string, level: 'log' | 'warn' | 'error' = 'log'): void {
  try {
    console[level](message)
  } catch {
    // Ignore logging errors during shutdown - console streams may be closed
  }
}

/** Format unknown thrown values for diagnostic logging. */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message
  }
  return String(error)
}

/**
 * Re-activates a stored security-scoped bookmark before touching a user-selected
 * file in MAS builds. Temp files live under the app container and do not need it.
 */
function ensureMasFileAccess(filePath: string): void {
  if (!process.mas) return
  if (filePath.startsWith(TEMP_DIR)) return
  const hasAccess = bookmarksService.ensureAccess(filePath)
  safeLog(`[bookmarks] ensureMasFileAccess path=${filePath} active=${hasAccess}`)
}

/**
 * Closes and removes a database connection from the cache.
 * This should be called before overwriting or deleting a database file.
 *
 * @param filePath - Absolute path to the .tb file
 * @param checkpointMode - WAL checkpoint mode: 'none' (no checkpoint), 'passive' (non-blocking), 'truncate' (full checkpoint)
 */
function closeDbConnection(
  filePath: string,
  checkpointMode: 'none' | 'passive' | 'truncate' = 'none'
): void {
  const hasShadowCopy = masShadowCopies.has(filePath)

  if (connectionCache.has(filePath)) {
    try {
      const db = connectionCache.get(filePath)!

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
      // Continue anyway - we still want to remove it from cache
    }
    connectionCache.delete(filePath)

    // Remove from access order
    const index = accessOrder.indexOf(filePath)
    if (index !== -1) {
      accessOrder.splice(index, 1)
    }
  }

  if (hasShadowCopy) {
    disposeMasShadowCopy(filePath)
  }
}

/**
 * Executes a database operation.
 * The powerMonitor 'suspend' handler closes all connections before sleep, so
 * SQLITE_READONLY_DBMOVED should never occur. If it somehow does (e.g. forced
 * hibernate), we evict the stale connection and surface the error clearly so
 * the renderer can recover gracefully.
 *
 * @param filePath - Absolute path to the .tb file
 * @param fn - Database operation to run
 */
function withDbConnection<T>(
  filePath: string,
  fn: (db: Database.Database) => T,
  options: { syncShadowBack?: boolean } = {}
): T {
  const runOperation = (): T => {
    const result = fn(getDbConnection(filePath))
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

// ============================================================================
// Font Detection Utility
// ============================================================================

/**
 * Represents a system font with its family name and file path
 */
interface SystemFont {
  /** Font family name extracted from filename */
  family: string
  /** Absolute path to the font file */
  path: string
  /** Font file format (ttf, otf, woff, woff2) */
  format: string
}

/**
 * Gets the platform-specific font directories to scan for system fonts.
 *
 * @returns Array of absolute paths to font directories
 */
function getFontDirectories(): string[] {
  const platform = process.platform
  const homedir = os.homedir()

  if (platform === 'darwin') {
    // macOS font directories (including Apple's downloadable asset fonts, e.g. Founders Grotesk)
    const assetFontDirs: string[] = []
    const assetsV2 = '/System/Library/AssetsV2'
    try {
      const entries = fs.readdirSync(assetsV2)
      for (const entry of entries) {
        if (entry.startsWith('com_apple_MobileAsset_Font')) {
          assetFontDirs.push(join(assetsV2, entry))
        }
      }
    } catch {
      // AssetsV2 may not exist on older macOS versions
    }
    return [
      '/System/Library/Fonts',
      '/Library/Fonts',
      join(homedir, 'Library', 'Fonts'),
      ...assetFontDirs
    ]
  } else if (platform === 'win32') {
    // Windows font directories
    const windir = process.env.WINDIR || 'C:\\Windows'
    return [join(windir, 'Fonts')]
  } else {
    // Linux font directories
    return [
      '/usr/share/fonts',
      '/usr/local/share/fonts',
      join(homedir, '.fonts'),
      join(homedir, '.local', 'share', 'fonts')
    ]
  }
}

/**
 * Recursively scans a directory for font files.
 *
 * @param dir - Directory to scan
 * @param fonts - Accumulator array for found fonts
 */
function scanFontDirectory(dir: string, fonts: SystemFont[]): void {
  try {
    if (!fs.existsSync(dir)) {
      return
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        scanFontDirectory(fullPath, fonts)
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        // Check if it's a supported font file
        if (['.ttf', '.otf', '.ttc'].includes(ext)) {
          try {
            // Read the actual font family name from the font file metadata
            const font = fontkit.openSync(fullPath)
            const format = ext.substring(1) // Remove the dot

            if (font?.type === 'TTC' && Array.isArray(font.fonts)) {
              for (const collectionFont of font.fonts) {
                // Prefer typographic family name (name ID 16) which groups all weights
                // under one family. Fall back to name ID 1 which may include weight suffixes.
                const familyName =
                  (collectionFont as any).preferredFamily || collectionFont.familyName
                if (familyName) {
                  fonts.push({
                    family: familyName,
                    path: fullPath,
                    format
                  })
                }
              }
            } else {
              const familyName = (font as any).preferredFamily || font.familyName
              if (familyName) {
                fonts.push({
                  family: familyName,
                  path: fullPath,
                  format
                })
              }
            }
          } catch (fontError) {
            // Skip fonts that can't be parsed
            console.debug(`Skipping unparseable font ${fullPath}:`, fontError)
          }
        }
      }
    }
  } catch (error) {
    // Silently skip directories we don't have permission to read
    console.warn(`Skipping font directory ${dir}:`, error)
  }
}

/**
 * Detects all available system fonts.
 *
 * @returns Array of system fonts with their family names and file paths
 */
function getSystemFonts(): SystemFont[] {
  const fonts: SystemFont[] = []
  const directories = getFontDirectories()

  for (const dir of directories) {
    scanFontDirectory(dir, fonts)
  }

  // Group fonts by family name and prefer Regular variants
  const fontsByFamily = new Map<string, SystemFont>()

  for (const font of fonts) {
    const existing = fontsByFamily.get(font.family)

    if (!existing) {
      // First font of this family - keep it
      fontsByFamily.set(font.family, font)
    } else {
      // Check if current font is "Regular" or "Normal" variant (preferred)
      const filename = basename(font.path).toLowerCase()
      const isRegular =
        filename.includes('regular') || filename.includes('normal') || filename.includes('-rg.')

      const existingFilename = basename(existing.path).toLowerCase()
      const existingIsRegular =
        existingFilename.includes('regular') ||
        existingFilename.includes('normal') ||
        existingFilename.includes('-rg.')

      // Replace if current is regular and existing is not
      if (isRegular && !existingIsRegular) {
        fontsByFamily.set(font.family, font)
      }
    }
  }

  // Convert map to array and sort
  const uniqueFonts = Array.from(fontsByFamily.values())
  uniqueFonts.sort((a, b) => a.family.localeCompare(b.family))

  return uniqueFonts
}

// ============================================================================
// Window Management
// ============================================================================

/**
 * Creates and configures the main application window.
 * Sets up window properties, event handlers, and loads the renderer content.
 */
let mainWindow: BrowserWindow | null = null

function getMainWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  mainWindow = null
  return null
}

function focusMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
}

function showOrCreateMainWindow(): BrowserWindow {
  const existingWindow = getMainWindow()
  if (existingWindow) {
    focusMainWindow(existingWindow)
    return existingWindow
  }

  return createWindow()
}

function openSettingsInMainWindow(): void {
  const existingWindow = getMainWindow()
  if (existingWindow) {
    focusMainWindow(existingWindow)
    existingWindow.webContents.send('app:open-settings')
    return
  }

  const window = createWindow()
  window.webContents.once('did-finish-load', () => {
    if (!window.isDestroyed()) {
      window.webContents.send('app:open-settings')
    }
  })
}

function createWindow(): BrowserWindow {
  const existingWindow = getMainWindow()
  if (existingWindow) {
    focusMainWindow(existingWindow)
    return existingWindow
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false, // Don't show until ready-to-show event (prevents visual flash)
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false // Required for better-sqlite3 native module
    }
  })
  mainWindow = window

  let hasShownWindow = false
  let showFallbackTimeout: NodeJS.Timeout | null = null

  const showMainWindow = (): void => {
    if (hasShownWindow || window.isDestroyed()) return
    hasShownWindow = true
    if (showFallbackTimeout) {
      clearTimeout(showFallbackTimeout)
      showFallbackTimeout = null
    }
    window.show()
  }

  // Show window only when content is ready to prevent blank white flash
  window.on('ready-to-show', () => {
    showMainWindow()
  })

  // In MAS/sandboxed builds ready-to-show can fail to fire even though the
  // renderer has loaded successfully, leaving the app with no visible window.
  window.webContents.on('did-finish-load', () => {
    showFallbackTimeout = setTimeout(showMainWindow, 250)
  })

  // Promise-based guard to prevent concurrent close operations
  const FLUSH_TIMEOUT_MS = 5000
  let closePromise: Promise<void> | null = null

  // Prevent window from closing until pending saves are flushed
  window.on('close', (event) => {
    // Always prevent default close - we'll destroy manually when ready
    event.preventDefault()

    // If close already in progress, ignore
    if (closePromise) return

    closePromise = new Promise<void>((resolve) => {
      let flushTimeoutId: NodeJS.Timeout | null = null
      let isResolved = false

      // Function to safely close the window
      const performClose = (): void => {
        if (isResolved) return // Already closed
        isResolved = true

        // Clean up timeout if it exists
        if (flushTimeoutId) {
          clearTimeout(flushTimeoutId)
          flushTimeoutId = null
        }

        // Close window if not already destroyed
        if (!window.isDestroyed()) {
          window.destroy()
        }

        resolve()

        // On macOS, event.preventDefault() in the close handler cancels the quit
        // sequence. After destroying the window, we must explicitly re-trigger quit
        // so the user doesn't have to press Cmd+Q twice.
        if (isQuitting) {
          app.quit()
        }
      }

      // Ask renderer to flush pending saves
      window.webContents.send('lifecycle:before-close')

      // Listen for flush complete (only from the main window)
      const flushCompleteHandler = (_event: Electron.IpcMainEvent): void => {
        // Validate that the message came from the main window
        if (_event.sender !== window.webContents) {
          console.warn('Received lifecycle:flush-complete from non-main window, ignoring')
          return
        }
        ipcMain.removeListener('lifecycle:flush-complete', flushCompleteHandler)
        performClose()
      }
      ipcMain.once('lifecycle:flush-complete', flushCompleteHandler)

      // Set timeout for flush operation
      flushTimeoutId = setTimeout(() => {
        console.warn('Flush timeout - forcing window close')
        // Remove the listener since we're closing anyway
        ipcMain.removeListener('lifecycle:flush-complete', flushCompleteHandler)
        flushTimeoutId = null
        performClose()
      }, FLUSH_TIMEOUT_MS)
    })
  })

  // Open external links in the system browser instead of within the app
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the app content (different paths for dev vs production)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  return window
}

/**
 * Reference to the debug window (if open).
 * Only one debug window can be open at a time.
 */
let debugWindow: BrowserWindow | null = null

/**
 * Reference to the presentation window (if open).
 * Only one presentation window can be open at a time.
 */
let presentationWindow: BrowserWindow | null = null

/**
 * Creates and opens the debug window.
 * If a debug window is already open, focuses it instead of creating a new one.
 */
function createDebugWindow(): void {
  // If debug window already exists, focus it
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.focus()
    return
  }

  debugWindow = new BrowserWindow({
    width: 800,
    height: 900,
    title: 'twig Debug Panel',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  debugWindow.on('ready-to-show', () => {
    debugWindow?.show()
  })

  // Clean up reference when window is closed
  debugWindow.on('closed', () => {
    debugWindow = null
  })

  // Load the debug window content
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    debugWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/debug.html`)
  } else {
    debugWindow.loadFile(join(__dirname, '../renderer/debug.html'))
  }
}

/**
 * Creates and opens the presentation window in fullscreen.
 * If already open, focuses it instead.
 */
function createPresentationWindow(): void {
  if (presentationWindow && !presentationWindow.isDestroyed()) {
    presentationWindow.focus()
    return
  }

  presentationWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    title: 'twig Presentation',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  presentationWindow.on('ready-to-show', () => {
    presentationWindow?.show()
  })

  presentationWindow.on('closed', () => {
    // Notify main window that presentation was closed
    getMainWindow()?.webContents.send('presentation:window-closed')
    presentationWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    presentationWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/presentation.html`)
  } else {
    presentationWindow.loadFile(join(__dirname, '../renderer/presentation.html'))
  }
}

// ============================================================================
// File Association Handling
// ============================================================================

// Path of a .tb file to open on launch (set by OS file association)
let fileToOpen: string | null = null

// macOS: open-file fires before and after app ready when double-clicking a .tb file
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (path.endsWith('.tb')) {
    fileToOpen = path
    ensureMasFileAccess(path)
    const window = getMainWindow()
    if (window) {
      focusMainWindow(window)
      window.webContents.send('app:open-file', path)
    } else if (app.isReady()) {
      createWindow()
    }
  }
})

// Windows / Linux: the file path is passed as a CLI argument
if (process.platform !== 'darwin') {
  const argFile = process.argv.slice(1).find((a) => a.endsWith('.tb'))
  if (argFile) fileToOpen = argFile
}

// ============================================================================
// Application Menu (macOS)
// ============================================================================

/**
 * Sets up the macOS application menu.
 * On macOS the system menu bar is always visible, so a proper menu with
 * a Window submenu is required — otherwise there is no way to reopen a
 * window after it has been closed (MAS Guideline 4).
 */
function setupMacAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => {
            openSettingsInMainWindow()
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      role: 'window',
      submenu: [
        {
          label: 'Show Main Window',
          click: () => {
            showOrCreateMainWindow()
          }
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ============================================================================
// Application Lifecycle
// ============================================================================

app.whenReady().then(() => {
  // Ensure the temp directory exists and clean up stale temp files from previous sessions.
  ensureTempDir()

  // Restore access to previously-opened files via stored security-scoped bookmarks.
  // No-op on non-MAS builds.
  bookmarksService.startAccessingStoredBookmarks()

  // Set app user model ID for Windows
  electronApp.setAppUserModelId('com.electron')

  // Set up macOS application menu (required for MAS: Window menu lets users
  // reopen windows and the menu bar remains usable when no windows are open)
  if (process.platform === 'darwin') {
    setupMacAppMenu()
  }

  // Enable dev tools shortcuts optimization
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupMacAppMenu()

  // Close all cached database connections before the system sleeps so that
  // connections are never stale after wake (SQLITE_READONLY_DBMOVED).
  powerMonitor.on('suspend', () => {
    safeLog('System suspending — closing all database connections')
    for (const [filePath] of connectionCache) {
      closeDbConnection(filePath, 'passive')
    }
  })

  // ============================================================================
  // IPC Handlers
  // ============================================================================

  // --------------------------------------------------------------------------
  // Global Preferences Handlers
  // --------------------------------------------------------------------------

  ipcMain.handle('prefs:get', (_event, key: string) => getPref(key as 'locale' | 'autoUpdate'))
  ipcMain.handle('prefs:set', (_event, key: string, value: unknown) => {
    if (key === 'locale' && (value === 'en' || value === 'zh')) {
      setPref('locale', value)
      // Broadcast to all windows so the debug window stays in sync
      for (const wc of webContents.getAllWebContents()) {
        wc.send('locale:changed', value)
      }
    } else if (key === 'autoUpdate' && typeof value === 'boolean') {
      setPref('autoUpdate', value)
      // Apply immediately to the running updater (not just on next launch)
      if (!isStoreManagedBuild) {
        autoUpdater.autoDownload = value
        autoUpdater.autoInstallOnAppQuit = value
      }
    }
    // Unknown key or invalid value type: silently ignore
  })

  // --------------------------------------------------------------------------
  // File Dialog Handlers
  // --------------------------------------------------------------------------

  /**
   * Translate a native dialog string by key using the current locale preference.
   *
   * NOTE: These strings intentionally duplicate content in en.json / zh.json because
   * the main process cannot import renderer JSON files at runtime. If you update a
   * translation here, update the corresponding key in both locale files too.
   */
  function tDialog(key: string): string {
    const locale = getPref('locale')
    const strings: Record<string, { en: string; zh: string }> = {
      'dialog.open.title': { en: 'Open Presentation', zh: '打开演示文稿' },
      'dialog.save.title': { en: 'Save Presentation', zh: '保存演示文稿' },
      'dialog.image.title': { en: 'Insert Image', zh: '插入图片' },
      'dialog.filter.twig': { en: 'twig Files', zh: 'twig 文件' },
      'dialog.filter.image': { en: 'Images', zh: '图片' }
    }
    return strings[key]?.[locale] ?? strings[key]?.en ?? key
  }

  /**
   * Shows a file open dialog for selecting a presentation file.
   * Returns the selected file path or null if cancelled.
   */
  ipcMain.handle('dialog:show-open-dialog', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
      title: tDialog('dialog.open.title'),
      properties: ['openFile'],
      filters: [{ name: tDialog('dialog.filter.twig'), extensions: ['tb'] }],
      securityScopedBookmarks: process.mas === true
    })
    const { filePaths, bookmarks } = result
    safeLog(
      `[dialog] open result paths=${filePaths?.length ?? 0} bookmarks=${bookmarks?.length ?? 0}`
    )
    if (filePaths && filePaths.length > 0) {
      if (process.mas && bookmarks && bookmarks.length > 0) {
        bookmarksService.saveBookmark(filePaths[0], bookmarks[0])
        bookmarksService.ensureAccess(filePaths[0])
      }
      return filePaths[0]
    }
    return null
  })

  /**
   * Shows a file save dialog for choosing where to save a presentation.
   * Returns the selected file path or undefined if cancelled.
   */
  ipcMain.handle('dialog:show-save-dialog', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(window!, {
      title: tDialog('dialog.save.title'),
      defaultPath: 'presentation.tb',
      filters: [{ name: tDialog('dialog.filter.twig'), extensions: ['tb'] }],
      securityScopedBookmarks: process.mas === true
    })
    const { filePath, bookmark } = result
    if (filePath && process.mas && bookmark) {
      bookmarksService.saveBookmark(filePath, bookmark)
    }
    return filePath
  })

  /**
   * Shows a file open dialog for selecting an image file.
   * Reads the image and returns it as a base64 data URI along with filename.
   * Returns null if cancelled.
   */
  ipcMain.handle('dialog:show-image-dialog', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const { filePaths } = await dialog.showOpenDialog(window!, {
      title: tDialog('dialog.image.title'),
      properties: ['openFile'],
      filters: [{ name: tDialog('dialog.filter.image'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }]
    })

    if (!filePaths || filePaths.length === 0) {
      return null
    }

    const filePath = filePaths[0]
    const filename = basename(filePath)
    const ext = extname(filePath).toLowerCase()

    try {
      // Read the image file as a buffer
      const imageBuffer = fs.readFileSync(filePath)

      // Determine MIME type based on file extension
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp'
      }

      const mimeType = mimeTypes[ext] || 'image/png'

      // Convert to base64 data URI
      const base64 = imageBuffer.toString('base64')
      const dataUri = `data:${mimeType};base64,${base64}`

      return {
        src: dataUri,
        filename: filename
      }
    } catch (error) {
      console.error('Failed to read image file:', error)
      throw new Error(
        `Failed to read image file: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  })

  // --------------------------------------------------------------------------
  // Database Operation Handlers
  // --------------------------------------------------------------------------

  /**
   * Retrieves all slide IDs from a presentation file.
   */
  ipcMain.handle('db:get-slide-ids', (_event, filePath: string): string[] => {
    try {
      validateFilePath(filePath)
      return withDbConnection(filePath, (db) => dbService.getSlideIds(db))
    } catch (error) {
      console.error('Error in db:get-slide-ids:', error)
      throw error
    }
  })

  /**
   * Loads a specific slide with all its elements from the database.
   */
  ipcMain.handle('db:get-slide', (_event, filePath: string, slideId: string): Slide | null => {
    try {
      validateFilePath(filePath)
      validateSlideId(slideId)
      return withDbConnection(filePath, (db) => dbService.getSlide(db, slideId))
    } catch (error) {
      console.error('Error in db:get-slide:', error)
      throw error
    }
  })

  /**
   * Creates a new blank slide in the database.
   */
  ipcMain.handle('db:create-slide', (_event, filePath: string): Slide => {
    try {
      validateFilePath(filePath)
      return withDbConnection(filePath, (db) => dbService.createSlide(db), {
        syncShadowBack: true
      })
    } catch (error) {
      console.error('Error in db:create-slide:', error)
      throw error
    }
  })

  /**
   * Saves a slide and all its elements to the database.
   */
  ipcMain.handle('db:save-slide', (_event, filePath: string, slide: Slide): void => {
    try {
      validateFilePath(filePath)
      validateSlideId(slide.id)
      withDbConnection(filePath, (db) => dbService.saveSlide(db, slide), {
        syncShadowBack: true
      })
    } catch (error) {
      console.error('Error in db:save-slide:', error)
      throw error
    }
  })

  /**
   * Saves a thumbnail for a specific slide.
   */
  ipcMain.handle(
    'db:save-thumbnail',
    (_event, filePath: string, slideId: string, thumbnail: string): void => {
      try {
        validateFilePath(filePath)
        validateSlideId(slideId)
        withDbConnection(filePath, (db) => dbService.saveThumbnail(db, slideId, thumbnail), {
          syncShadowBack: true
        })
      } catch (error) {
        console.error('Error in db:save-thumbnail:', error)
        throw error
      }
    }
  )

  /**
   * Retrieves all stored thumbnails for a presentation.
   */
  ipcMain.handle('db:get-thumbnails', (_event, filePath: string): Record<string, string> => {
    try {
      validateFilePath(filePath)
      return withDbConnection(filePath, (db) => dbService.getThumbnails(db))
    } catch (error) {
      console.error('Error in db:get-thumbnails:', error)
      throw error
    }
  })

  ipcMain.handle('db:get-setting', (_event, filePath: string, key: string): string | null => {
    try {
      validateFilePath(filePath)
      return withDbConnection(filePath, (db) => dbService.getSetting(db, key))
    } catch (error) {
      console.error('Error in db:get-setting:', error)
      throw error
    }
  })

  ipcMain.handle(
    'db:set-setting',
    (_event, filePath: string, key: string, value: string | null): void => {
      try {
        validateFilePath(filePath)
        withDbConnection(filePath, (db) => dbService.setSetting(db, key, value), {
          syncShadowBack: true
        })
      } catch (error) {
        console.error('Error in db:set-setting:', error)
        throw error
      }
    }
  )

  ipcMain.handle(
    'db:apply-background-to-all',
    (_event, filePath: string, background: dbService.SlideBackground | null): void => {
      try {
        validateFilePath(filePath)
        withDbConnection(filePath, (db) => dbService.applyBackgroundToAllSlides(db, background), {
          syncShadowBack: true
        })
      } catch (error) {
        console.error('Error in db:apply-background-to-all:', error)
        throw error
      }
    }
  )

  ipcMain.handle('db:delete-slide', (_event, filePath: string, slideId: string): void => {
    try {
      validateFilePath(filePath)
      validateSlideId(slideId)
      withDbConnection(filePath, (db) => dbService.deleteSlide(db, slideId), {
        syncShadowBack: true
      })
    } catch (error) {
      console.error('Error in db:delete-slide:', error)
      throw error
    }
  })

  ipcMain.handle('db:reorder-slides', (_event, filePath: string, orderedIds: string[]): void => {
    try {
      validateFilePath(filePath)
      for (const id of orderedIds) validateSlideId(id)
      withDbConnection(filePath, (db) => dbService.reorderSlides(db, orderedIds), {
        syncShadowBack: true
      })
    } catch (error) {
      console.error('Error in db:reorder-slides:', error)
      throw error
    }
  })

  /**
   * Saves all slides to a new file (Save As operation).
   * This creates a completely new database file with all slides.
   */
  ipcMain.handle('db:save-as', (_event, filePath: string, slides: Slide[]): void => {
    try {
      validateFilePath(filePath)
      ensureMasFileAccess(filePath)
      // Validate all slide IDs
      for (const slide of slides) {
        validateSlideId(slide.id)
      }
      // Close any existing connection to this file path
      closeDbConnection(filePath)

      // Delete the file if it exists to ensure a clean overwrite
      // We try to delete it atomically, and handle common error cases
      try {
        fs.unlinkSync(filePath)
      } catch (unlinkError) {
        const errCode = (unlinkError as NodeJS.ErrnoException).code
        // ENOENT: File doesn't exist - that's fine, we wanted to delete it anyway
        if (errCode === 'ENOENT') {
          // No action needed
        }
        // EBUSY/EPERM: File is locked or in use by another process
        else if (errCode === 'EBUSY' || errCode === 'EPERM') {
          console.error('File is locked or in use by another process:', unlinkError)
          throw new Error(
            `Cannot save to ${filePath} because it is currently in use by another process. Please close any applications using this file and try again.`
          )
        }
        // Other errors: log and attempt to proceed (better-sqlite3 may handle overwrite)
        else {
          console.warn('Failed to delete existing file, attempting to overwrite:', unlinkError)
        }
      }

      // Create a new database and save all slides in a single transaction
      withDbConnection(filePath, (db) => dbService.saveAllSlides(db, slides), {
        syncShadowBack: true
      })
    } catch (error) {
      console.error('Error in db:save-as:', error)
      throw error
    }
  })

  /**
   * Closes a database connection and removes it from the cache.
   * Used before overwriting or deleting a file.
   * Uses PASSIVE checkpoint mode for non-blocking WAL flush.
   */
  ipcMain.handle('db:close-connection', (_event, filePath: string): void => {
    validateFilePath(filePath)
    closeDbConnection(filePath, 'passive')
  })

  /**
   * Creates a new temporary database for an unsaved presentation.
   * Returns the path to the temp database file.
   */
  ipcMain.handle('db:create-temp', (): string => {
    try {
      ensureTempDir()
      const tempPath = join(TEMP_DIR, `temp-${crypto.randomUUID()}.tb`)

      // Create and initialize the database
      getDbConnection(tempPath)

      // Track this as a temp file for cleanup
      tempFilePaths.add(tempPath)

      safeLog(`Created temp database: ${tempPath}`)
      return tempPath
    } catch (error) {
      console.error('Error in db:create-temp:', error)
      throw error
    }
  })

  /**
   * Checks if a database file path is a temporary file.
   * Uses path-based detection (checks if under TEMP_DIR) to persist across restarts,
   * so recovered temp files from crashes are still recognized as temporary.
   * Resolves symlinks to prevent path traversal attacks.
   */
  ipcMain.handle('db:is-temp-file', (_event, filePath: string): boolean => {
    try {
      validateFilePath(filePath)

      // Resolve symlinks and normalize paths
      const realPath = fs.realpathSync(filePath)
      const realTempDir = fs.realpathSync(TEMP_DIR)

      // Ensure the path is inside TEMP_DIR (not just a prefix match)
      // Check if path starts with tempDir followed by a separator, or is exactly tempDir
      const isInTempDir = realPath === realTempDir || realPath.startsWith(realTempDir + sep)

      return isInTempDir
    } catch {
      // If file doesn't exist or path is invalid, it's not a temp file
      return false
    }
  })

  /**
   * Deletes a temporary database file.
   * Used for cleanup when temp file creation succeeds but initialization fails.
   */
  ipcMain.handle('db:delete-temp', (_event, filePath: string): void => {
    try {
      // Validate that this is actually a tracked temp file to prevent arbitrary deletion
      if (!tempFilePaths.has(filePath)) {
        throw new Error('Cannot delete: path is not a tracked temporary file')
      }

      // Close any connection to this file
      closeDbConnection(filePath)

      // Delete the file if it exists
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)

        // Verify file is actually deleted
        if (fs.existsSync(filePath)) {
          throw new Error('File still exists after deletion - possible file system error')
        }

        safeLog(`Deleted temp database: ${filePath}`)
      }

      // Remove from temp files tracking
      tempFilePaths.delete(filePath)
    } catch (error) {
      console.error('Error deleting temp file:', error)
      throw error
    }
  })

  /**
   * Moves a temp database to a user-chosen location (Save operation).
   * Handles cross-device moves by falling back to copy+delete.
   */
  ipcMain.handle(
    'db:save-to-location',
    async (_event, sourcePath: string, destPath: string): Promise<string> => {
      try {
        validateFilePath(sourcePath)
        validateFilePath(destPath)
        ensureMasFileAccess(sourcePath)
        ensureMasFileAccess(destPath)

        // Verify source file exists
        if (!fs.existsSync(sourcePath)) {
          throw new Error(`Source file does not exist: ${sourcePath}`)
        }

        // Close connections to both paths and checkpoint WAL with full TRUNCATE
        closeDbConnection(sourcePath, 'truncate')
        closeDbConnection(destPath, 'truncate')

        // Delete destination if it exists (with retry logic for file locks)
        if (fs.existsSync(destPath)) {
          try {
            await retryFileOperation(() => {
              fs.unlinkSync(destPath)
            })
          } catch (unlinkError) {
            const errCode = (unlinkError as NodeJS.ErrnoException).code
            if (errCode === 'EBUSY' || errCode === 'EPERM') {
              throw new Error(
                `Cannot save to ${destPath} because it is currently in use. Please close any applications using this file and try again.`
              )
            }
            // ENOENT is fine, other errors we'll try to proceed
            if (errCode !== 'ENOENT') {
              console.warn('Failed to delete existing destination file:', unlinkError)
            }
          }
        }

        // Try to rename (move) the file (with retry logic)
        try {
          await retryFileOperation(() => {
            fs.renameSync(sourcePath, destPath)
          })

          // Clean up any orphaned WAL companion files at source path
          // Even after TRUNCATE checkpoint, .tb-shm can persist
          for (const suffix of ['-wal', '-shm']) {
            const companionPath = sourcePath + suffix
            try {
              if (fs.existsSync(companionPath)) {
                fs.unlinkSync(companionPath)
              }
            } catch {
              // Non-fatal: orphaned companion files don't affect correctness
            }
          }
        } catch (renameError) {
          // If cross-device move (EXDEV) or sandbox permission error (EPERM/EACCES on
          // macOS MAS when renaming out of the app container), fall back to copy+delete.
          const errCode = (renameError as NodeJS.ErrnoException).code
          if (errCode === 'EXDEV' || errCode === 'EPERM' || errCode === 'EACCES') {
            console.log('Rename blocked (cross-device or sandbox permission), using copy+delete fallback')

            // Verify source database integrity before copying
            try {
              verifyDatabaseIntegrity(sourcePath, 'before cross-device copy')
            } catch (sourceVerifyError) {
              throw new Error(
                `Source database is corrupted: ${sourceVerifyError instanceof Error ? sourceVerifyError.message : 'Unknown error'}`
              )
            }

            // Copy with retry logic
            await retryFileOperation(() => {
              fs.copyFileSync(sourcePath, destPath)
            })

            // Verify destination database integrity before deleting source
            try {
              verifyDatabaseIntegrity(destPath, 'after cross-device copy')
            } catch (verifyError) {
              // Destination is corrupted, delete it and don't delete source
              try {
                fs.unlinkSync(destPath)
              } catch {
                // Ignore cleanup error
              }
              throw new Error(
                `Failed to verify destination database after copy: ${verifyError instanceof Error ? verifyError.message : 'Unknown error'}`
              )
            }

            // Destination verified, safe to delete source (with retry)
            await retryFileOperation(() => {
              fs.unlinkSync(sourcePath)
            })

            // Verify source is actually deleted
            if (fs.existsSync(sourcePath)) {
              throw new Error(
                'Source file still exists after move operation - this indicates a file system error'
              )
            }

            // Clean up any orphaned WAL companion files at source path
            for (const suffix of ['-wal', '-shm']) {
              const companionPath = sourcePath + suffix
              try {
                if (fs.existsSync(companionPath)) {
                  fs.unlinkSync(companionPath)
                }
              } catch {
                // Non-fatal: orphaned companion files don't affect correctness
              }
            }
          } else {
            throw renameError
          }
        }

        // Remove from temp files set
        tempFilePaths.delete(sourcePath)

        // Evict source path from connection cache to prevent memory leak
        // The connection was already closed before the move operation
        connectionCache.delete(sourcePath)

        // Open connection at destination
        getDbConnection(destPath)

        safeLog(`Moved temp database from ${sourcePath} to ${destPath}`)
        return destPath
      } catch (error) {
        console.error('Error in db:save-to-location:', error)
        throw error
      }
    }
  )

  /**
   * Copies a database to a new location (Save As from an already-saved file).
   */
  ipcMain.handle(
    'db:copy-to-location',
    async (_event, sourcePath: string, destPath: string): Promise<string> => {
      try {
        validateFilePath(sourcePath)
        validateFilePath(destPath)
        ensureMasFileAccess(sourcePath)
        ensureMasFileAccess(destPath)

        // Prevent data loss by checking if source and destination are the same path
        // Use normalize to handle trailing slashes and relative path segments
        const normalizedSourcePath = normalize(sourcePath)
        const normalizedDestPath = normalize(destPath)

        if (normalizedSourcePath === normalizedDestPath) {
          throw new Error(
            'Cannot save to the same file. Please choose a different filename or location.'
          )
        }

        // Verify source file exists
        if (!fs.existsSync(sourcePath)) {
          throw new Error(`Source file does not exist: ${sourcePath}`)
        }

        // Close connections and checkpoint WAL with full TRUNCATE
        closeDbConnection(sourcePath, 'truncate')
        closeDbConnection(destPath, 'truncate')

        // Delete destination if it exists (with retry logic)
        if (fs.existsSync(destPath)) {
          try {
            await retryFileOperation(() => {
              fs.unlinkSync(destPath)
            })
          } catch (unlinkError) {
            const errCode = (unlinkError as NodeJS.ErrnoException).code
            if (errCode === 'EBUSY' || errCode === 'EPERM') {
              throw new Error(
                `Cannot save to ${destPath} because it is currently in use. Please close any applications using this file and try again.`
              )
            }
            // ENOENT is fine, other errors we'll try to proceed
            if (errCode !== 'ENOENT') {
              console.warn('Failed to delete existing destination file:', unlinkError)
            }
          }
        }

        // Verify source database integrity before copying
        try {
          verifyDatabaseIntegrity(sourcePath, 'before Save As copy')
        } catch (sourceVerifyError) {
          throw new Error(
            `Source database is corrupted: ${sourceVerifyError instanceof Error ? sourceVerifyError.message : 'Unknown error'}`
          )
        }

        // Copy the file (with retry logic)
        await retryFileOperation(() => {
          fs.copyFileSync(sourcePath, destPath)
        })

        // Verify destination database integrity
        try {
          verifyDatabaseIntegrity(destPath, 'after Save As copy')
        } catch (verifyError) {
          // Destination is corrupted, delete it and throw
          try {
            fs.unlinkSync(destPath)
          } catch {
            // Ignore cleanup error
          }
          throw new Error(
            `Failed to verify destination database after copy: ${verifyError instanceof Error ? verifyError.message : 'Unknown error'}`
          )
        }

        // Open connection at destination
        getDbConnection(destPath)

        safeLog(`Copied database from ${sourcePath} to ${destPath}`)
        return destPath
      } catch (error) {
        console.error('Error in db:copy-to-location:', error)
        throw error
      }
    }
  )

  // --------------------------------------------------------------------------
  // Font Operation Handlers
  // --------------------------------------------------------------------------

  /**
   * Returns all available system fonts.
   */
  ipcMain.handle('fonts:get-system-fonts', (): SystemFont[] => {
    try {
      return getSystemFonts()
    } catch (error) {
      console.error('Error in fonts:get-system-fonts:', error)
      throw error
    }
  })

  /**
   * Embeds a font file into the database.
   * Reads the font file from the system and stores it in the fonts table.
   */
  ipcMain.handle(
    'fonts:embed-font',
    (
      _event,
      filePath: string,
      fontPath: string,
      fontFamily: string,
      variant: string = 'normal-normal'
    ): void => {
      try {
        validateFilePath(filePath)

        // Read the font file
        const fontData = fs.readFileSync(fontPath)

        // Determine format from file extension
        const ext = extname(fontPath).toLowerCase()
        const format = ext.substring(1) // Remove dot
        if (!['ttf', 'otf', 'ttc', 'woff', 'woff2'].includes(format)) {
          throw new Error(`Unsupported font format: ${format}`)
        }

        // Create a unique ID for this font (hash of family + variant)
        const id = crypto
          .createHash('sha256')
          .update(`${fontFamily}-${variant}`)
          .digest('hex')
          .substring(0, 16)

        // Store in database
        const font: FontData = {
          id,
          fontFamily,
          fontData: fontData,
          format,
          variant
        }
        withDbConnection(filePath, (db) => dbService.addFont(db, font), {
          syncShadowBack: true
        })
      } catch (error) {
        console.error('Error in fonts:embed-font:', error)
        throw error
      }
    }
  )

  /**
   * Retrieves all embedded fonts from the database.
   */
  ipcMain.handle('fonts:get-embedded-fonts', (_event, filePath: string): FontData[] => {
    try {
      validateFilePath(filePath)
      return withDbConnection(filePath, (db) => dbService.getFonts(db))
    } catch (error) {
      console.error('Error in fonts:get-embedded-fonts:', error)
      throw error
    }
  })

  /**
   * Retrieves a specific font from the database.
   */
  ipcMain.handle(
    'fonts:get-font-data',
    (
      _event,
      filePath: string,
      fontFamily: string,
      variant: string = 'normal-normal'
    ): FontData | null => {
      try {
        validateFilePath(filePath)
        return withDbConnection(filePath, (db) => dbService.getFontData(db, fontFamily, variant))
      } catch (error) {
        console.error('Error in fonts:get-font-data:', error)
        throw error
      }
    }
  )

  /**
   * Loads a font file directly from the filesystem for preview purposes.
   * Does not embed the font in the database.
   */
  ipcMain.handle('fonts:load-font-file', (_event, fontPath: string): Buffer => {
    try {
      return fs.readFileSync(fontPath)
    } catch (error) {
      console.error('Error in fonts:load-font-file:', error)
      throw error
    }
  })

  // Create the main window
  createWindow()

  // On macOS, restore the primary editor window when the dock icon is clicked.
  app.on('activate', () => {
    showOrCreateMainWindow()
  })

  // --------------------------------------------------------------------------
  // File Association Handlers
  // --------------------------------------------------------------------------

  /**
   * Returns the file path to open on launch (from OS file association or argv).
   * Clears the pending value after returning it so it is consumed only once.
   */
  ipcMain.handle('app:get-file-to-open', (): string | null => {
    const path = fileToOpen
    fileToOpen = null
    return path
  })

  /**
   * Opens the privacy policy in the user's default browser.
   */
  ipcMain.handle('app:open-privacy-policy', async (): Promise<void> => {
    await shell.openExternal(PRIVACY_POLICY_URL)
  })

  // --------------------------------------------------------------------------
  // Debug Window Handlers
  // --------------------------------------------------------------------------

  /**
   * Opens the debug window.
   * If already open, focuses it instead of creating a new one.
   */
  ipcMain.handle('debug:open-window', () => {
    createDebugWindow()
  })

  /**
   * Broadcasts state updates to the debug window (if open).
   * Called from the main renderer window whenever state changes.
   */
  ipcMain.on('debug:state-update', (_event, state) => {
    if (debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.webContents.send('debug:state-changed', state)
    }
  })

  /**
   * Handles request from debug window to get initial state.
   * Forwards the request to the main window.
   */
  ipcMain.on('debug:request-state', () => {
    const window = getMainWindow()
    if (window) {
      // Ask main window to send its state
      window.webContents.send('debug:request-state-from-main')
    }
  })

  // --------------------------------------------------------------------------
  // Presentation Window Handlers
  // --------------------------------------------------------------------------

  // Fire-and-forget: renderer does not await this, so we use ipcMain.on
  ipcMain.on('presentation:open-window', () => {
    createPresentationWindow()
  })

  ipcMain.handle('presentation:close-window', () => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
  })

  /** Forward slide state from main window to presentation window. */
  ipcMain.on('presentation:state-update', (_event, state) => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.webContents.send('presentation:state-changed', state)
    }
  })

  /** Forward navigation requests from presentation window to main window. */
  ipcMain.on('presentation:navigate', (_event, direction: string) => {
    getMainWindow()?.webContents.send('presentation:navigate-request', direction)
  })

  /** Forward exit request from presentation window to main window. */
  ipcMain.on('presentation:exit', () => {
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
  })

  /** Presentation window signals it's ready — forward to main window so it sends initial state. */
  ipcMain.on('presentation:ready', () => {
    getMainWindow()?.webContents.send('presentation:window-ready')
  })

  // --------------------------------------------------------------------------
  // Auto-updater (disabled for store-managed builds — the platform store handles updates)
  // --------------------------------------------------------------------------

  if (!isStoreManagedBuild) {
    const autoUpdateEnabled = getPref('autoUpdate')

    // Public releases are published on GitHub's default "latest" channel even while the
    // app version still uses rc.* semver. If we let electron-updater infer prerelease
    // mode from the app version, it switches to the Atom feed path and can resolve a tag
    // that doesn't actually have update artifacts attached. Keep update checks pinned to
    // the published latest release metadata instead.
    autoUpdater.allowPrerelease = false

    // Explicit assignment required — electron-updater defaults both to true internally
    autoUpdater.autoDownload = autoUpdateEnabled
    autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled

    /** Notify the main window that a new version is downloaded and ready. */
    function notifyUpdateReady(version: string): void {
      getMainWindow()?.webContents.send('app:update-downloaded', version)
    }

    autoUpdater.on('update-downloaded', (info) => {
      notifyUpdateReady(info.version)
    })

    ipcMain.handle('app:check-for-updates', async () => {
      try {
        const result = await autoUpdater.checkForUpdates()
        if (!result?.isUpdateAvailable) return 'up-to-date'
        return 'checking'
      } catch (error) {
        safeLog(`Auto-update check failed: ${formatError(error)}`, 'warn')
        return 'error'
      }
    })

    ipcMain.handle('app:install-update', () => {
      autoUpdater.quitAndInstall()
    })

    // Manual check for Settings modal — returns availability without auto-downloading.
    // Temporarily forces autoDownload=false so checkForUpdates() never starts a download,
    // regardless of the user's autoUpdate preference.
    ipcMain.handle('app:check-for-update-manual', async () => {
      const prev = autoUpdater.autoDownload
      autoUpdater.autoDownload = false
      try {
        const result = await autoUpdater.checkForUpdates()
        if (!result?.isUpdateAvailable) return { available: false }
        return { available: true, version: result.updateInfo.version }
      } catch (error) {
        safeLog(`Manual auto-update check failed: ${formatError(error)}`, 'warn')
        return { available: false, error: true }
      } finally {
        autoUpdater.autoDownload = prev
      }
    })

    // Manual download + install (triggered from Settings after manual check).
    // Rejects on download failure so the renderer can show an error.
    ipcMain.handle('app:download-and-install', async () => {
      await new Promise<void>((resolve, reject) => {
        const onDownloaded = (): void => {
          autoUpdater.quitAndInstall()
          resolve()
        }
        autoUpdater.once('update-downloaded', onDownloaded)
        autoUpdater.downloadUpdate().catch((err) => {
          autoUpdater.removeListener('update-downloaded', onDownloaded)
          safeLog(`Auto-update download failed: ${formatError(err)}`, 'warn')
          reject(err)
        })
      })
    })

    // Silent background check on startup (errors are silently ignored)
    if (!is.dev && autoUpdateEnabled) {
      autoUpdater.checkForUpdates().catch((error) => {
        safeLog(`Background auto-update check failed: ${formatError(error)}`, 'warn')
      })
    }
  }
})

// ============================================================================
// Application Shutdown
// ============================================================================

/**
 * Flag to prevent cleanup from running multiple times.
 * On macOS, both window-all-closed and will-quit can fire.
 */
let cleanupPromise: Promise<void> | null = null

/**
 * Flag to track if cleanup has completed.
 * Used to prevent re-running cleanup and to allow quit to proceed.
 */
let cleanupCompleted = false

/**
 * Flag to track if the user is explicitly trying to quit the app (Cmd+Q).
 * This helps distinguish between "close all windows" and "quit app" on macOS.
 */
let isQuitting = false

/**
 * Cleans up all database connections and temp files during app shutdown.
 * Uses a promise-based guard to prevent concurrent cleanup attempts.
 */
async function cleanupResources(): Promise<void> {
  // If cleanup already completed, don't run again
  if (cleanupCompleted) return

  // If cleanup is in progress, wait for it
  if (cleanupPromise) return cleanupPromise

  cleanupPromise = (async () => {
    // Close all database connections with full WAL checkpoint
    // Copy keys to array to avoid modifying map while iterating
    const filePaths = Array.from(connectionCache.keys())
    for (const filePath of filePaths) {
      closeDbConnection(filePath, 'truncate')
    }

    // Clean up temp files
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

    // Release all security-scoped resource access (MAS builds only)
    bookmarksService.stopAccessingAllBookmarks()

    // Clean up temp directory
    try {
      if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true })
        safeLog('Cleaned up temp directory')
      }
    } catch (error) {
      safeLog(`Failed to clean up temp directory: ${error}`, 'warn')
    }
  })()

  try {
    await cleanupPromise
    cleanupCompleted = true
    safeLog('Cleanup completed successfully')
  } finally {
    cleanupPromise = null
  }
}

/**
 * Track when the user explicitly tries to quit the app.
 * This fires before windows start closing.
 */
app.on('before-quit', () => {
  isQuitting = true
})

/**
 * Clean up resources when the app is actually exiting.
 */
app.on('window-all-closed', async () => {
  if (process.platform === 'darwin' && !isQuitting) {
    safeLog('All windows closed on macOS; app remains active until explicit quit')
    return
  }

  await cleanupResources()
  app.quit()
})

/**
 * Clean up resources before the app quits (backup handler).
 * This should rarely be needed since window-all-closed handles cleanup,
 * but provides a safety net.
 */
app.on('will-quit', async (event) => {
  // If cleanup hasn't been completed yet, prevent quit to do it now
  if (!cleanupCompleted) {
    event.preventDefault()
    await cleanupResources()
    // Trigger quit again, this time it will proceed since cleanupCompleted is true
    app.quit()
  }
  // Otherwise cleanup was already done (by window-all-closed), let quit proceed naturally
})
