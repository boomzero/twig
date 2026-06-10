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
import { join, normalize, basename, extname, sep, resolve, relative, isAbsolute } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as dbService from './db'
import type { Slide, FontData } from './db'
import { getPref, setPref } from './prefs'
import * as bookmarksService from './bookmarks'
import { createWindowCloseController } from './windowCloseController'
import { safeLog, formatError } from './logging'
import {
  getTempDir,
  ensureTempDir,
  createTempDbPath,
  registerTempFile,
  unregisterTempFile,
  isTempFile,
  cleanupAllTempFiles,
  removeTempDir
} from './files/tempManager'
import {
  validateFilePath,
  validateSlideId,
  withDbConnection,
  getWritableConnection,
  getReadOnlyConnection,
  closeDbConnection,
  evictConnectionCaches,
  getOpenConnectionPaths,
  isOpenedReadOnly,
  probeDatabaseFormat,
  verifyDatabaseIntegrity,
  retryFileOperation,
  ensureMasFileAccess
} from './db/connection'
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

// (validateFilePath / validateSlideId moved to ./db/connection.)
// (TEMP_DIR / tempFilePaths / ensureTempDir moved to ./files/tempManager.)
// (MAS shadow copies, connection caches, withDbConnection, integrity checks
//  moved to ./db/connection.)

const PRIVACY_POLICY_URL = 'https://twig.boomzero.uk/privacy/'
const isStoreManagedBuild =
  process.mas === true ||
  (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore === true
const MAX_EXPORT_FOLDER_ALLOWLIST_ENTRIES = 16
const exportFolderAllowlist = new Set<string>()
const exportFolderBookmarks = new Map<string, string>()

function allowExportFolder(dirPath: string, bookmark?: string): void {
  exportFolderAllowlist.delete(dirPath)
  exportFolderAllowlist.add(dirPath)

  if (bookmark) {
    exportFolderBookmarks.delete(dirPath)
    exportFolderBookmarks.set(dirPath, bookmark)
  }

  while (exportFolderAllowlist.size > MAX_EXPORT_FOLDER_ALLOWLIST_ENTRIES) {
    const oldest = exportFolderAllowlist.values().next().value
    if (!oldest) break
    exportFolderAllowlist.delete(oldest)
    exportFolderBookmarks.delete(oldest)
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

interface FontkitFontMetadata {
  familyName?: string
  preferredFamily?: string
  type?: string
  fonts?: FontkitFontMetadata[]
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
            const font = fontkit.openSync(fullPath) as FontkitFontMetadata
            const format = ext.substring(1) // Remove the dot

            if (font?.type === 'TTC' && Array.isArray(font.fonts)) {
              for (const collectionFont of font.fonts) {
                // Prefer typographic family name (name ID 16) which groups all weights
                // under one family. Fall back to name ID 1 which may include weight suffixes.
                const familyName = collectionFont.preferredFamily || collectionFont.familyName
                if (familyName) {
                  fonts.push({
                    family: familyName,
                    path: fullPath,
                    format
                  })
                }
              }
            } else {
              const familyName = font.preferredFamily || font.familyName
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

function openExportImagesInMainWindow(): void {
  const existingWindow = getMainWindow()
  if (existingWindow) {
    focusMainWindow(existingWindow)
    existingWindow.webContents.send('menu:export-images')
    return
  }

  const window = showOrCreateMainWindow()
  window.webContents.once('did-finish-load', () => {
    if (!window.isDestroyed()) {
      window.webContents.send('menu:export-images')
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
    // The menu bar must stay visible on Windows/Linux: it is the only entry
    // point for File > Export as Images and (on those platforms) Settings.
    autoHideMenuBar: false,
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

  const closeController = createWindowCloseController({
    window,
    ipcMain,
    timeoutMs: 30000,
    getIsQuitting: () => isQuitting,
    setIsQuitting: (value) => {
      isQuitting = value
    },
    quitApp: () => {
      app.quit()
    }
  })

  window.on('close', (event) => {
    closeController.handleClose(event)
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
// Application Menu
// ============================================================================

/**
 * Sets up the application menu.
 * On macOS the system menu bar needs the standard app/Window menus so users can
 * reopen windows after close (MAS Guideline 4). On Windows/Linux, avoid applying
 * macOS-only roles such as Services/Hide.
 */
function setupAppMenu(): void {
  const fileMenu: Electron.MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      ...(process.platform === 'darwin'
        ? []
        : [
            {
              label: 'Settings…',
              accelerator: 'CmdOrCtrl+,',
              click: () => {
                openSettingsInMainWindow()
              }
            },
            { type: 'separator' as const }
          ]),
      {
        label: 'Export as Images…',
        accelerator: 'CmdOrCtrl+Shift+E',
        click: () => {
          openExportImagesInMainWindow()
        }
      },
      { type: 'separator' },
      { role: 'close' }
    ]
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => {
                  openSettingsInMainWindow()
                }
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    fileMenu,
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
      label: 'View',
      submenu: [
        {
          label: 'Snap to Guides',
          type: 'checkbox',
          checked: getPref('snapToGuides'),
          click: () => {
            const next = !getPref('snapToGuides')
            setPref('snapToGuides', next)
            getMainWindow()?.webContents.send('snap:changed', next)
            setupAppMenu()
          }
        },
        { type: 'separator' as const },
        ...(is.dev ? [{ role: 'reload' as const }, { role: 'forceReload' as const }] : []),
        { role: 'toggleDevTools' as const }
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

  // Set up application menu.
  setupAppMenu()

  // Enable dev tools shortcuts optimization
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Close all cached database connections before the system sleeps so that
  // connections are never stale after wake (SQLITE_READONLY_DBMOVED). Iterate
  // both RW and RO caches (closeDbConnection tolerates either).
  powerMonitor.on('suspend', () => {
    safeLog('System suspending — closing all database connections')
    for (const filePath of getOpenConnectionPaths()) {
      closeDbConnection(filePath, 'passive')
    }
  })

  // ============================================================================
  // IPC Handlers
  // ============================================================================

  // --------------------------------------------------------------------------
  // Global Preferences Handlers
  // --------------------------------------------------------------------------

  ipcMain.handle('prefs:get', (_event, key: string) =>
    getPref(key as 'locale' | 'autoUpdate' | 'snapToGuides')
  )
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
    } else if (key === 'snapToGuides' && typeof value === 'boolean') {
      setPref('snapToGuides', value)
      // Only the main editor window owns the interactive canvas
      getMainWindow()?.webContents.send('snap:changed', value)
      // Rebuild the menu so the checkbox state stays in sync
      setupAppMenu()
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
      'dialog.export_images.title': { en: 'Choose Export Folder', zh: '选择导出文件夹' },
      'dialog.export_images.select': { en: 'Select', zh: '选择' },
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
   * Shows a folder picker for exporting one image file per slide.
   * Returns the canonical selected directory path or null if cancelled.
   */
  ipcMain.handle('dialog:show-export-folder-dialog', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
      title: tDialog('dialog.export_images.title'),
      buttonLabel: tDialog('dialog.export_images.select'),
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: process.mas === true
    })
    const { filePaths, bookmarks } = result

    if (!filePaths || filePaths.length === 0) {
      return null
    }

    const resolved = fs.realpathSync(resolve(filePaths[0]))

    if (process.mas && bookmarks && bookmarks.length > 0) {
      bookmarksService.saveBookmark(resolved, bookmarks[0])
      bookmarksService.ensureAccess(resolved)
    }

    allowExportFolder(resolved, bookmarks?.[0])
    return { dirPath: resolved }
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
      filters: [
        {
          name: tDialog('dialog.filter.image'),
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']
        }
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
      throw new Error(
        `Failed to read image file: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  })

  /**
   * Writes a rendered slide image into a previously user-selected export folder.
   */
  ipcMain.handle(
    'fs:write-image-file',
    async (
      _event,
      args: { dirPath?: unknown; filename?: unknown; base64?: unknown }
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const { dirPath, filename, base64 } = args ?? {}

        if (
          typeof dirPath !== 'string' ||
          typeof filename !== 'string' ||
          typeof base64 !== 'string'
        ) {
          throw new Error('Invalid image write arguments')
        }

        const canon = fs.realpathSync(resolve(dirPath))
        if (!exportFolderAllowlist.has(canon)) {
          throw new Error('Export folder is not allowlisted')
        }

        if (!/^slide-\d{3,}\.(png|jpe?g)$/.test(filename)) {
          throw new Error('Invalid export image filename')
        }

        const target = resolve(canon, filename)
        const rel = relative(canon, target)
        if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
          throw new Error('Invalid export image path')
        }

        if (base64.includes(',') || /[^A-Za-z0-9+/=]/.test(base64)) {
          throw new Error('Invalid base64 image data')
        }

        let stopAccessing: (() => void) | null = null
        try {
          if (process.mas) {
            const bookmark = exportFolderBookmarks.get(canon)
            if (bookmark) {
              stopAccessing = app.startAccessingSecurityScopedResource(bookmark) as () => void
            } else {
              bookmarksService.ensureAccess(canon)
            }
          }

          fs.writeFileSync(target, Buffer.from(base64, 'base64'))
        } finally {
          try {
            stopAccessing?.()
          } catch {
            // Ignore security-scoped resource cleanup failures.
          }
        }

        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown image write error'
        console.error('Error in fs:write-image-file:', error)
        return { ok: false, error: message }
      }
    }
  )

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
        syncShadowBack: true,
        write: true
      })
    } catch (error) {
      console.error('Error in db:create-slide:', error)
      throw error
    }
  })

  /**
   * Duplicates a slide and inserts the copy immediately after the source.
   */
  ipcMain.handle('db:duplicate-slide', (_event, filePath: string, slideId: string): Slide => {
    try {
      validateFilePath(filePath)
      validateSlideId(slideId)
      return withDbConnection(filePath, (db) => dbService.duplicateSlide(db, slideId), {
        syncShadowBack: true,
        write: true
      })
    } catch (error) {
      console.error('Error in db:duplicate-slide:', error)
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
        syncShadowBack: true,
        write: true
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
          syncShadowBack: true,
          write: true
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
          syncShadowBack: true,
          write: true
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
          syncShadowBack: true,
          write: true
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
        syncShadowBack: true,
        write: true
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
        syncShadowBack: true,
        write: true
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
      closeDbConnection(filePath, 'none', { forgetReadOnly: true })

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
        syncShadowBack: true,
        write: true
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
    closeDbConnection(filePath, 'passive', { forgetReadOnly: true })
  })

  /**
   * Probes a `.tb` candidate for its format identity without mutating it or
   * caching a connection. Used by the renderer's open flow to distinguish
   * fresh/legacy/current/tooNew/notTwig before committing to an open mode.
   */
  ipcMain.handle('db:probe-format', (_event, filePath: string): dbService.FormatProbeResult => {
    try {
      validateFilePath(filePath)
      return probeDatabaseFormat(filePath)
    } catch (error) {
      console.error('Error in db:probe-format:', error)
      throw error
    }
  })

  /**
   * Opens a presentation for editing or read-only viewing. In read-only mode
   * the file is validated as a twig file first (refuses fresh/notTwig/older);
   * callers should only use `readOnly: true` after a probe reports `tooNew`.
   * Returns slide IDs so the renderer can begin loading thumbnails.
   */
  ipcMain.handle(
    'db:open-for-edit',
    (_event, filePath: string, options?: { readOnly?: boolean }): string[] => {
      try {
        validateFilePath(filePath)
        const readOnly = options?.readOnly === true
        if (readOnly) {
          // getReadOnlyConnection validates format via detectFormat and only
          // allows `tooNew` files, which are the whole reason read-only mode
          // exists.
          const db = getReadOnlyConnection(filePath)
          return dbService.getSlideIds(db)
        }
        const db = getWritableConnection(filePath)
        return dbService.getSlideIds(db)
      } catch (error) {
        console.error('Error in db:open-for-edit:', error)
        throw error
      }
    }
  )

  /**
   * Creates a new temporary database for an unsaved presentation.
   * Returns the path to the temp database file.
   */
  ipcMain.handle('db:create-temp', (): string => {
    try {
      ensureTempDir()
      const tempPath = createTempDbPath()

      // Create and initialize the database (stamps format metadata).
      getWritableConnection(tempPath)

      // Track this as a temp file for cleanup — only after successful init.
      registerTempFile(tempPath)

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
      const realTempDir = fs.realpathSync(getTempDir())

      // Ensure the path is inside TEMP_DIR (not just a prefix match)
      // Check if path starts with tempDir followed by a separator, or is exactly tempDir
      const isInTempDir = realPath === realTempDir || realPath.startsWith(realTempDir + sep)

      return isInTempDir
    } catch {
      // If file doesn't exist or path is invalid, it's not a temp file
      return false
    }
  })

  ipcMain.handle('db:is-bootstrap-presentation', (_event, filePath: string): boolean => {
    try {
      validateFilePath(filePath)
      return withDbConnection(filePath, (db) => dbService.isBootstrapPresentation(db))
    } catch (error) {
      console.error('Error in db:is-bootstrap-presentation:', error)
      throw error
    }
  })

  /**
   * Deletes a temporary database file.
   * Used for cleanup when temp file creation succeeds but initialization fails.
   */
  ipcMain.handle('db:delete-temp', (_event, filePath: string): void => {
    try {
      // Validate that this is actually a tracked temp file to prevent arbitrary deletion
      if (!isTempFile(filePath)) {
        throw new Error('Cannot delete: path is not a tracked temporary file')
      }

      // Close any connection to this file
      closeDbConnection(filePath, 'none', { forgetReadOnly: true })

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
      unregisterTempFile(filePath)
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

        // Reject Save if the source was opened read-only (newer-than-supported
        // file): the user explicitly declined to migrate it, so we must not
        // write its bytes to a new location under a writable connection.
        if (isOpenedReadOnly(sourcePath)) {
          throw new Error(
            'Cannot save a file that was opened read-only. Close and reopen it after upgrading twig, or save a copy through your file manager.'
          )
        }

        // Close connections to both paths and checkpoint WAL with full TRUNCATE
        closeDbConnection(sourcePath, 'truncate', { forgetReadOnly: true })
        closeDbConnection(destPath, 'truncate', { forgetReadOnly: true })

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
            console.log(
              'Rename blocked (cross-device or sandbox permission), using copy+delete fallback'
            )

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
        unregisterTempFile(sourcePath)

        // Evict source path from both connection caches to prevent memory leak
        // (the connection was already closed before the move operation).
        evictConnectionCaches(sourcePath)

        // Open a writable connection at the destination. `getWritableConnection`
        // runs `initializeDatabase`, which stamps format metadata, so the
        // newly-placed file carries the same pragmas and settings rows as any
        // other saved .tb.
        getWritableConnection(destPath)

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

        // A read-only source means the user opened it without agreeing to
        // migrate. Copying it as a new writable twig file would stamp metadata
        // from this build onto bytes written by a future format — refuse.
        if (isOpenedReadOnly(sourcePath)) {
          throw new Error(
            'Cannot copy a file that was opened read-only. Close and reopen it after upgrading twig, or copy it through your file manager.'
          )
        }

        // Close connections and checkpoint WAL with full TRUNCATE
        closeDbConnection(sourcePath, 'truncate')
        closeDbConnection(destPath, 'truncate', { forgetReadOnly: true })

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

        // Open a writable connection at the destination. `getWritableConnection`
        // runs `initializeDatabase`, which stamps format metadata on the copy.
        getWritableConnection(destPath)

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
          syncShadowBack: true,
          write: true
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
    // Close all database connections with full WAL checkpoint. Iterate both
    // RW and RO caches (RO close skips the checkpoint internally).
    for (const filePath of getOpenConnectionPaths()) {
      closeDbConnection(filePath, 'truncate')
    }

    // Clean up temp files
    cleanupAllTempFiles()

    // Release all security-scoped resource access (MAS builds only)
    bookmarksService.stopAccessingAllBookmarks()

    // Clean up temp directory
    removeTempDir()
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
