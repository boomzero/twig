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
import { join, isAbsolute, normalize } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import Database from 'better-sqlite3'
import * as dbService from './db'
import type { Slide } from './db'
import fs from 'fs'

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
 * Closes and removes a database connection from the cache.
 * This should be called before overwriting or deleting a database file.
 *
 * @param filePath - Absolute path to the .db file
 */
function closeDbConnection(filePath: string): void {
  if (connectionCache.has(filePath)) {
    try {
      connectionCache.get(filePath)!.close()
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
  ipcMain.handle('dialog:show-open-dialog', async () => {
    const { filePaths } = await dialog.showOpenDialog({
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
  ipcMain.handle('dialog:show-save-dialog', async () => {
    const { filePath } = await dialog.showSaveDialog({
      title: 'Save Presentation',
      defaultPath: 'presentation.db',
      filters: [{ name: 'Deckhand Files', extensions: ['db'] }]
    })
    return filePath
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

  // Create the main window
  createWindow()

  // On macOS, re-create window when dock icon is clicked and no windows are open
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// ============================================================================
// Application Shutdown
// ============================================================================

/**
 * Clean up all database connections before quitting the app.
 * On macOS, the app stays running even when all windows are closed.
 */
app.on('window-all-closed', () => {
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

  // On non-macOS platforms, quit the app when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
