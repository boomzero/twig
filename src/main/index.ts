/**
 * Main process entry point for Deckhand presentation editor.
 *
 * This file manages:
 * - Application lifecycle (startup, shutdown)
 * - Window creation and management
 * - IPC communication between main and renderer processes
 * - Database connection caching and management
 */

import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, isAbsolute, normalize, basename, extname } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import Database from 'better-sqlite3'
import * as dbService from './db'
import type { Slide, FontData } from './db'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import fontkit from 'fontkit'

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

  // Ensure it ends with .db
  if (!filePath.endsWith('.db')) {
    throw new Error('Invalid file extension. Expected .db file')
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
        if (file.endsWith('.db')) {
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
 * @param filePath - Absolute path to the .db file
 * @returns The database connection instance
 * @throws Error if the file is not a valid SQLite database
 */
function getDbConnection(filePath: string): Database.Database {
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
  if (fs.existsSync(filePath)) {
    let fd: number | undefined
    try {
      // Read the first 16 bytes to check for SQLite magic header
      fd = fs.openSync(filePath, 'r')
      const buffer = Buffer.alloc(16)
      fs.readSync(fd, buffer, 0, 16, 0)

      // SQLite files start with "SQLite format 3\0"
      const fileHeader = buffer.toString('utf8', 0, 16)

      if (!fileHeader.startsWith('SQLite format 3')) {
        throw new Error(
          `File ${filePath} is not a valid SQLite database. Please select a valid Deckhand presentation file.`
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

  // Create new connection, initialize schema, and cache it
  let db: Database.Database
  try {
    db = new Database(filePath)
  } catch (error) {
    if (error instanceof Error && error.message.includes('not a database')) {
      throw new Error(
        `File ${filePath} is not a valid SQLite database. Please select a valid Deckhand presentation file.`
      )
    }
    throw error
  }

  try {
    dbService.initializeDatabase(db)

    // Implement LRU eviction: if cache is full, close least recently used connection
    if (connectionCache.size >= MAX_CONNECTIONS) {
      const lruPath = accessOrder.shift() // Remove least recently used
      if (lruPath && connectionCache.has(lruPath)) {
        try {
          connectionCache.get(lruPath)!.close()
          connectionCache.delete(lruPath)
          console.log(`Closed LRU database connection: ${lruPath}`)
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
async function retryFileOperation<T>(
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
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  // All retries failed
  throw lastError || new Error('File operation failed after all retries')
}

/**
 * Closes and removes a database connection from the cache.
 * This should be called before overwriting or deleting a database file.
 *
 * @param filePath - Absolute path to the .db file
 * @param checkpoint - Whether to force a WAL checkpoint before closing (default: false)
 */
function closeDbConnection(filePath: string, checkpoint: boolean = false): void {
  if (connectionCache.has(filePath)) {
    try {
      const db = connectionCache.get(filePath)!

      // Force WAL checkpoint to ensure all data is written to the main file
      if (checkpoint) {
        try {
          db.pragma('wal_checkpoint(TRUNCATE)')
          console.log(`Checkpointed WAL for ${filePath}`)
        } catch (checkpointError) {
          console.warn(`Failed to checkpoint WAL for ${filePath}:`, checkpointError)
          // Continue anyway - close will still work
        }
      }

      db.close()
    } catch (error) {
      console.error(`Error closing database connection for ${filePath}:`, error)
      // Continue anyway - we still want to remove it from cache
    }
    connectionCache.delete(filePath)

    // Remove from access order
    const index = accessOrder.indexOf(filePath)
    if (index !== -1) {
      accessOrder.splice(index, 1)
    }
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
    // macOS font directories
    return [
      '/System/Library/Fonts',
      '/Library/Fonts',
      join(homedir, 'Library', 'Fonts')
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
                const familyName = collectionFont.familyName
                if (familyName) {
                  fonts.push({
                    family: familyName,
                    path: fullPath,
                    format
                  })
                }
              }
            } else {
              const familyName = font.familyName
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
      const isRegular = filename.includes('regular') || filename.includes('normal') || filename.includes('-rg.')

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
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 670,
    show: false, // Don't show until ready-to-show event (prevents visual flash)
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false // Required for better-sqlite3 native module
    }
  })

  // Show window only when content is ready to prevent blank white flash
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Close state management to prevent race conditions
  const FLUSH_TIMEOUT_MS = 5000
  let closeState: 'idle' | 'flushing' | 'closed' = 'idle'
  let flushTimeoutId: NodeJS.Timeout | null = null

  // Prevent window from closing until pending saves are flushed
  mainWindow.on('close', (event) => {
    // Only handle close if we're in idle state
    if (closeState !== 'idle') {
      event.preventDefault()
      return
    }

    // Transition to flushing state
    closeState = 'flushing'
    event.preventDefault()

    // Function to safely close the window
    const performClose = () => {
      if (closeState === 'closed') return // Already closed
      closeState = 'closed'

      // Clean up timeout if it exists
      if (flushTimeoutId) {
        clearTimeout(flushTimeoutId)
        flushTimeoutId = null
      }

      // Close window if not already destroyed
      if (!mainWindow.isDestroyed()) {
        mainWindow.destroy()
      }
    }

    // Ask renderer to flush pending saves
    mainWindow.webContents.send('lifecycle:before-close')

    // Listen for flush complete
    const flushCompleteHandler = () => {
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

  // Open external links in the system browser instead of within the app
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the app content (different paths for dev vs production)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Reference to the debug window (if open).
 * Only one debug window can be open at a time.
 */
let debugWindow: BrowserWindow | null = null

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
    title: 'Deckhand Debug Panel',
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

// ============================================================================
// Application Lifecycle
// ============================================================================

app.whenReady().then(() => {
  // Set app user model ID for Windows
  electronApp.setAppUserModelId('com.electron')

  // Enable dev tools shortcuts optimization
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // ============================================================================
  // IPC Handlers
  // ============================================================================

  // --------------------------------------------------------------------------
  // File Dialog Handlers
  // --------------------------------------------------------------------------

  /**
   * Shows a file open dialog for selecting a presentation file.
   * Returns the selected file path or null if cancelled.
   */
  ipcMain.handle('dialog:show-open-dialog', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const { filePaths } = await dialog.showOpenDialog(window!, {
      title: 'Open Presentation',
      properties: ['openFile'],
      filters: [{ name: 'Deckhand Files', extensions: ['db'] }]
    })
    return filePaths && filePaths.length > 0 ? filePaths[0] : null
  })

  /**
   * Shows a file save dialog for choosing where to save a presentation.
   * Returns the selected file path or undefined if cancelled.
   */
  ipcMain.handle('dialog:show-save-dialog', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const { filePath } = await dialog.showSaveDialog(window!, {
      title: 'Save Presentation',
      defaultPath: 'presentation.db',
      filters: [{ name: 'Deckhand Files', extensions: ['db'] }]
    })
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
      title: 'Insert Image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'] }
      ]
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
      throw new Error(`Failed to read image file: ${error instanceof Error ? error.message : 'Unknown error'}`)
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
      const db = getDbConnection(filePath)
      return dbService.getSlideIds(db)
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
      const db = getDbConnection(filePath)
      return dbService.getSlide(db, slideId)
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
      const db = getDbConnection(filePath)
      return dbService.createSlide(db)
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
      const db = getDbConnection(filePath)
      dbService.saveSlide(db, slide)
    } catch (error) {
      console.error('Error in db:save-slide:', error)
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
      const db = getDbConnection(filePath)
      dbService.saveAllSlides(db, slides)
    } catch (error) {
      console.error('Error in db:save-as:', error)
      throw error
    }
  })

  /**
   * Closes a database connection and removes it from the cache.
   * Used before overwriting or deleting a file.
   */
  ipcMain.handle('db:close-connection', (_event, filePath: string): void => {
    validateFilePath(filePath)
    closeDbConnection(filePath)
  })

  /**
   * Creates a new temporary database for an unsaved presentation.
   * Returns the path to the temp database file.
   */
  ipcMain.handle('db:create-temp', (): string => {
    try {
      ensureTempDir()
      const tempPath = join(TEMP_DIR, `temp-${crypto.randomUUID()}.db`)

      // Create and initialize the database
      getDbConnection(tempPath)

      // Track this as a temp file for cleanup
      tempFilePaths.add(tempPath)

      console.log(`Created temp database: ${tempPath}`)
      return tempPath
    } catch (error) {
      console.error('Error in db:create-temp:', error)
      throw error
    }
  })

  /**
   * Checks if a database file path is a temporary file.
   */
  ipcMain.handle('db:is-temp-file', (_event, filePath: string): boolean => {
    return tempFilePaths.has(filePath)
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
        console.log(`Deleted temp database: ${filePath}`)
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
  ipcMain.handle('db:save-to-location', async (_event, sourcePath: string, destPath: string): Promise<string> => {
    try {
      validateFilePath(sourcePath)
      validateFilePath(destPath)

      // Verify source file exists
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source file does not exist: ${sourcePath}`)
      }

      // Close connections to both paths and checkpoint WAL
      closeDbConnection(sourcePath, true)
      closeDbConnection(destPath, true)

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
      } catch (renameError) {
        // If cross-device move (EXDEV), fall back to copy+delete
        const errCode = (renameError as NodeJS.ErrnoException).code
        if (errCode === 'EXDEV') {
          console.log('Cross-device move detected, using copy+delete fallback')

          // Copy with retry logic
          await retryFileOperation(() => {
            fs.copyFileSync(sourcePath, destPath)
          })

          // Verify destination database integrity before deleting source
          try {
            const testDb = new Database(destPath, { readonly: true })

            // Run integrity check to verify data, not just header
            const integrityResult = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>
            testDb.close()

            if (!integrityResult || integrityResult[0]?.integrity_check !== 'ok') {
              throw new Error('Database integrity check failed')
            }
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
        } else {
          throw renameError
        }
      }

      // Remove from temp files set
      tempFilePaths.delete(sourcePath)

      // Open connection at destination
      getDbConnection(destPath)

      console.log(`Moved temp database from ${sourcePath} to ${destPath}`)
      return destPath
    } catch (error) {
      console.error('Error in db:save-to-location:', error)
      throw error
    }
  })

  /**
   * Copies a database to a new location (Save As from an already-saved file).
   */
  ipcMain.handle('db:copy-to-location', async (_event, sourcePath: string, destPath: string): Promise<string> => {
    try {
      validateFilePath(sourcePath)
      validateFilePath(destPath)

      // Verify source file exists
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source file does not exist: ${sourcePath}`)
      }

      // Close connections and checkpoint WAL
      closeDbConnection(sourcePath, true)
      closeDbConnection(destPath, true)

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

      // Copy the file (with retry logic)
      await retryFileOperation(() => {
        fs.copyFileSync(sourcePath, destPath)
      })

      // Verify destination database integrity
      try {
        const testDb = new Database(destPath, { readonly: true })

        // Run integrity check to verify data, not just header
        const integrityResult = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>
        testDb.close()

        if (!integrityResult || integrityResult[0]?.integrity_check !== 'ok') {
          throw new Error('Database integrity check failed')
        }
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

      console.log(`Copied database from ${sourcePath} to ${destPath}`)
      return destPath
    } catch (error) {
      console.error('Error in db:copy-to-location:', error)
      throw error
    }
  })

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
    (_event, filePath: string, fontPath: string, fontFamily: string, variant: string = 'normal-normal'): void => {
      try {
        validateFilePath(filePath)

        // Read the font file
        const fontData = fs.readFileSync(fontPath)

        // Determine format from file extension
        const ext = extname(fontPath).toLowerCase()
        let format = ext.substring(1) // Remove dot
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
        const db = getDbConnection(filePath)
        const font: FontData = {
          id,
          fontFamily,
          fontData: fontData,
          format,
          variant
        }
        dbService.addFont(db, font)
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
      const db = getDbConnection(filePath)
      return dbService.getFonts(db)
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
    (_event, filePath: string, fontFamily: string, variant: string = 'normal-normal'): FontData | null => {
      try {
        validateFilePath(filePath)
        const db = getDbConnection(filePath)
        return dbService.getFontData(db, fontFamily, variant)
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

  // On macOS, re-create window when dock icon is clicked and no windows are open
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
    const mainWindow = BrowserWindow.getAllWindows().find(
      (win) => win !== debugWindow && !win.isDestroyed()
    )
    if (mainWindow) {
      // Ask main window to send its state
      mainWindow.webContents.send('debug:request-state-from-main')
    }
  })

  createWindow()
})

// ============================================================================
// Application Shutdown
// ============================================================================

/**
 * Flag to prevent cleanup from running multiple times.
 * On macOS, both window-all-closed and before-quit can fire.
 */
let cleanupPromise: Promise<void> | null = null

/**
 * Cleans up all database connections and temp files.
 * Called on app shutdown and when all windows are closed.
 * Uses promise-based guard to prevent concurrent cleanup attempts.
 * The guard resets after completion to allow cleanup on subsequent window cycles.
 */
async function cleanupResources(): Promise<void> {
  if (cleanupPromise) return cleanupPromise

  cleanupPromise = (async () => {
    // Close all database connections with error handling
    for (const [filePath, connection] of connectionCache.entries()) {
      try {
        connection.close()
      } catch (error) {
        console.error(`Error closing database connection for ${filePath}:`, error)
        // Continue closing other connections
      }
    }
    connectionCache.clear()

    // Clean up temp files
    for (const tempPath of tempFilePaths) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath)
          console.log(`Deleted temp file: ${tempPath}`)
        }
      } catch (error) {
        console.warn(`Failed to delete temp file ${tempPath}:`, error)
      }
    }
    tempFilePaths.clear()

    // Clean up temp directory
    try {
      if (fs.existsSync(TEMP_DIR)) {
        fs.rmSync(TEMP_DIR, { recursive: true, force: true })
        console.log('Cleaned up temp directory')
      }
    } catch (error) {
      console.warn('Failed to clean up temp directory:', error)
    }
  })()

  try {
    await cleanupPromise
  } finally {
    // Reset promise guard so cleanup can run again on subsequent cycles
    cleanupPromise = null
  }
}

/**
 * Clean up resources when all windows are closed.
 * On macOS, the app stays running even when all windows are closed.
 */
app.on('window-all-closed', async () => {
  await cleanupResources()

  // On non-macOS platforms, quit the app when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Clean up resources before the app quits completely.
 * This handles cleanup on macOS when the app is actually quitting.
 */
app.on('before-quit', async () => {
  await cleanupResources()
})
