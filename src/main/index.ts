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
import { join, basename, extname, sep, resolve, relative, isAbsolute } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as dbService from './db'
import type { Slide, FontData } from './db'
import { getPref, setPref } from './prefs'
import * as bookmarksService from './bookmarks'
import { closeWindowsSequentially, createWindowCloseController } from './windowCloseController'
import { EditorWindowManager } from './editorWindowManager'
import { presentationPathsFromArgv } from './launchPaths'
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
  ensureMasFileAccess
} from './db/connection'
import {
  createSiblingStagingPath,
  pathsReferToSameFile,
  removeDatabaseCompanions,
  replaceFilePreservingDestination
} from './files/atomicFile'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import fontkit from 'fontkit'

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

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
const allowedSystemFontPaths = new Set<string>()

type SaveLocationResult = { status: 'saved'; filePath: string } | { status: 'focused-existing' }

function assertAllowedSystemFontPath(fontPath: unknown): string {
  if (typeof fontPath !== 'string' || !isAbsolute(fontPath)) {
    throw new Error('Font path must be absolute')
  }

  let realPath: string
  try {
    realPath = fs.realpathSync(fontPath)
  } catch {
    throw new Error('Font file does not exist')
  }

  if (!allowedSystemFontPaths.has(realPath)) {
    throw new Error('Font file was not selected from the system font list')
  }
  if (!['.ttf', '.otf', '.ttc', '.woff', '.woff2'].includes(extname(realPath).toLowerCase())) {
    throw new Error('Unsupported font format')
  }
  return realPath
}

function stageVerifiedDatabaseCopy(sourcePath: string, destinationPath: string): string {
  const stageAt = (stagingPath: string): string => {
    fs.copyFileSync(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL)
    verifyDatabaseIntegrity(stagingPath, 'staged save', { forceExternalCheck: true })
    return stagingPath
  }

  const siblingPath = createSiblingStagingPath(destinationPath)
  try {
    return stageAt(siblingPath)
  } catch (error) {
    for (const candidatePath of [siblingPath, `${siblingPath}-wal`, `${siblingPath}-shm`]) {
      try {
        if (fs.existsSync(candidatePath)) fs.unlinkSync(candidatePath)
      } catch {
        // Keep the original failure; a uniquely named staging artifact is safe.
      }
    }

    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error

    // A MAS security-scoped bookmark can permit writing the chosen file but
    // forbid creating siblings. Stage and verify in the app container instead;
    // installation retains a recovery backup for the non-atomic final copy.
    ensureTempDir()
    const tempStagingPath = join(getTempDir(), `save-${crypto.randomUUID()}.tb`)
    try {
      return stageAt(tempStagingPath)
    } catch (tempError) {
      try {
        if (fs.existsSync(tempStagingPath)) fs.unlinkSync(tempStagingPath)
      } catch {
        // Preserve the original staging failure.
      }
      throw tempError
    }
  }
}

function installStagedDatabase(stagingPath: string, destinationPath: string): void {
  try {
    replaceFilePreservingDestination(stagingPath, destinationPath)
    try {
      // A successfully checkpointed destination can still leave an inert SHM file.
      removeDatabaseCompanions(destinationPath)
    } catch (cleanupError) {
      safeLog(
        `Installed ${destinationPath}, but could not remove an inert SQLite companion: ${formatError(cleanupError)}`,
        'warn'
      )
    }
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV' && code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') throw error
  }

  ensureTempDir()
  const recoveryPath = join(getTempDir(), `recovery-save-${crypto.randomUUID()}.tb`)
  const originalExisted = fs.existsSync(destinationPath)
  let retainRecovery = false
  try {
    if (originalExisted) fs.copyFileSync(destinationPath, recoveryPath, fs.constants.COPYFILE_EXCL)
    try {
      fs.copyFileSync(stagingPath, destinationPath)
      removeDatabaseCompanions(destinationPath)
      fs.unlinkSync(stagingPath)
    } catch (copyError) {
      try {
        if (originalExisted) {
          fs.copyFileSync(recoveryPath, destinationPath)
        } else if (fs.existsSync(destinationPath)) {
          fs.unlinkSync(destinationPath)
        }
      } catch (restoreError) {
        retainRecovery = true
        throw new AggregateError(
          [copyError, restoreError],
          `Failed to install ${destinationPath}; recovery copy retained at ${recoveryPath}`
        )
      }
      throw copyError
    }
  } finally {
    if (!retainRecovery) {
      try {
        if (fs.existsSync(recoveryPath)) fs.unlinkSync(recoveryPath)
      } catch {
        // A leftover recovery copy is safe and should not mask a completed save.
      }
    }
  }
}

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

const editorWindows = new EditorWindowManager<BrowserWindow>()
const editorCloseControllers = new Map<number, ReturnType<typeof createWindowCloseController>>()
const readyEditorIds = new Set<number>()
const queuedEditorOpenFiles = new Map<number, string[]>()

function getActiveEditorWindow(): BrowserWindow | null {
  return editorWindows.getActiveEditor(BrowserWindow.getFocusedWindow())?.window ?? null
}

function getEditorForSender(senderId: number): BrowserWindow | null {
  return editorWindows.getEditorByWebContentsId(senderId)?.window ?? null
}

function getOwnerForSender(senderId: number): BrowserWindow | null {
  return editorWindows.getOwnerByWebContentsId(senderId)?.window ?? null
}

function assertSenderOwnsDocument(senderId: number, filePath: string): BrowserWindow {
  const editor = getEditorForSender(senderId)
  const owner = editor ?? getOwnerForSender(senderId)
  if (!owner || !editorWindows.ownsDocument(owner, filePath, Boolean(editor))) {
    throw new Error('Presentation is owned by another editor window')
  }
  return owner
}

function sendToEditor(window: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (window.isDestroyed()) return
  const send = (): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, ...args)
  }
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send)
  else send()
}

function showOrCreateEditorWindow(): BrowserWindow {
  const existingWindow = getActiveEditorWindow()
  if (existingWindow) {
    editorWindows.focus(existingWindow)
    return existingWindow
  }
  return createWindow()
}

function openSettingsInMainWindow(): void {
  const existingWindow = getActiveEditorWindow()
  if (existingWindow) {
    editorWindows.focus(existingWindow)
    sendToEditor(existingWindow, 'app:open-settings')
    return
  }

  const window = createWindow()
  sendToEditor(window, 'app:open-settings')
}

function openExportImagesInMainWindow(): void {
  const existingWindow = getActiveEditorWindow()
  if (existingWindow) {
    editorWindows.focus(existingWindow)
    sendToEditor(existingWindow, 'menu:export-images')
    return
  }

  const window = showOrCreateEditorWindow()
  sendToEditor(window, 'menu:export-images')
}

function createWindow(launchFile: string | null = null): BrowserWindow {
  if (launchFile) {
    ensureMasFileAccess(launchFile)
    const existingOwner = editorWindows.findDocumentOwner(launchFile)
    if (existingOwner) {
      editorWindows.focus(existingOwner.window)
      return existingOwner.window
    }
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--twig-window-role=editor']
    }
  })
  editorWindows.registerEditor(window, launchFile)
  window.on('focus', () => editorWindows.noteFocused(window))

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
    getIsQuitting: () => false,
    setIsQuitting: () => {},
    quitApp: () => {}
  })
  editorCloseControllers.set(window.id, closeController)

  window.on('close', (event) => {
    closeController.handleClose(event)
  })

  // Open external links in the system browser instead of within the app
  window.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        void shell.openExternal(url.toString())
      }
    } catch {
      safeLog(`Blocked invalid external URL: ${details.url}`, 'warn')
    }
    return { action: 'deny' }
  })

  // Load the app content (different paths for dev vs production)
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    const queuedOpenFiles = queuedEditorOpenFiles.get(window.id) ?? []
    const record = editorWindows.getEditor(window)
    for (const auxiliary of [record?.debugWindow, record?.presentationWindow]) {
      if (auxiliary && !auxiliary.isDestroyed()) auxiliary.destroy()
    }
    editorWindows.unregisterEditor(window)
    editorCloseControllers.delete(window.id)
    readyEditorIds.delete(window.id)
    queuedEditorOpenFiles.delete(window.id)
    setupAppMenu()
    if (!isQuitting) {
      for (const filePath of queuedOpenFiles) setImmediate(() => routeExternalOpen(filePath))
    }
  })

  return window
}

function createDebugWindow(owner: BrowserWindow): void {
  const existingWindow = editorWindows.getAuxiliary(owner, 'debug')
  if (existingWindow && !existingWindow.isDestroyed()) {
    editorWindows.focus(existingWindow)
    return
  }

  const debugWindow = new BrowserWindow({
    width: 800,
    height: 900,
    title: 'twig Debug Panel',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--twig-window-role=debug']
    }
  })
  editorWindows.attachAuxiliary(owner, 'debug', debugWindow)
  debugWindow.on('focus', () => editorWindows.noteFocused(debugWindow))

  debugWindow.on('ready-to-show', () => {
    if (!debugWindow.isDestroyed()) debugWindow.show()
  })

  // Clean up reference when window is closed
  debugWindow.on('closed', () => {
    editorWindows.detachAuxiliary(debugWindow)
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
function createPresentationWindow(owner: BrowserWindow): void {
  const existingWindow = editorWindows.getAuxiliary(owner, 'presentation')
  if (existingWindow && !existingWindow.isDestroyed()) {
    editorWindows.focus(existingWindow)
    return
  }

  const presentationWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    title: 'twig Presentation',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--twig-window-role=presentation']
    }
  })
  editorWindows.attachAuxiliary(owner, 'presentation', presentationWindow)
  presentationWindow.on('focus', () => editorWindows.noteFocused(presentationWindow))

  presentationWindow.on('ready-to-show', () => {
    if (!presentationWindow.isDestroyed()) presentationWindow.show()
  })

  presentationWindow.on('closed', () => {
    sendToEditor(owner, 'presentation:window-closed')
    editorWindows.detachAuxiliary(presentationWindow)
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

const pendingOpenFiles: string[] = []

function routeExternalOpen(filePath: string): void {
  ensureMasFileAccess(filePath)
  const existingOwner = editorWindows.findDocumentOwner(filePath)
  if (existingOwner) {
    editorWindows.focus(existingOwner.window)
    return
  }

  const activeEditor = getActiveEditorWindow()
  if (!activeEditor) {
    createWindow(filePath)
    return
  }
  if (readyEditorIds.has(activeEditor.id)) {
    sendToEditor(activeEditor, 'app:open-file', filePath)
    return
  }
  const queued = queuedEditorOpenFiles.get(activeEditor.id) ?? []
  queued.push(filePath)
  queuedEditorOpenFiles.set(activeEditor.id, queued)
}

// macOS: open-file fires before and after app ready when double-clicking a .tb file
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (path.toLowerCase().endsWith('.tb')) {
    if (app.isReady()) routeExternalOpen(path)
    else pendingOpenFiles.push(path)
  }
})

if (process.platform !== 'darwin')
  pendingOpenFiles.push(...presentationPathsFromArgv(process.argv.slice(1)))

app.on('second-instance', (_event, argv, workingDirectory) => {
  const paths = presentationPathsFromArgv(argv, workingDirectory)
  for (const filePath of paths) routeExternalOpen(filePath)
  if (paths.length === 0) showOrCreateEditorWindow()
})

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
      {
        label: 'New Presentation',
        accelerator: 'CmdOrCtrl+N',
        click: () => {
          const window = getActiveEditorWindow()
          if (window) sendToEditor(window, 'menu:new-presentation')
          else createWindow()
        }
      },
      {
        label: 'Open Presentation…',
        accelerator: 'CmdOrCtrl+O',
        click: () => {
          const window = getActiveEditorWindow() ?? createWindow()
          sendToEditor(window, 'menu:open-presentation')
        }
      },
      { type: 'separator' as const },
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
            for (const record of editorWindows.getEditors()) {
              sendToEditor(record.window, 'snap:changed', next)
            }
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
          label: 'Show Editor Window',
          click: () => {
            showOrCreateEditorWindow()
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
  if (!hasSingleInstanceLock) return
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
      try {
        closeDbConnection(filePath, 'passive')
      } catch (error) {
        safeLog(
          `Could not safely close ${filePath} before suspend; retaining its connection and recovery data: ${formatError(error)}`,
          'error'
        )
      }
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
      for (const record of editorWindows.getEditors()) {
        sendToEditor(record.window, 'snap:changed', value)
      }
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
  ipcMain.handle('db:get-slide-ids', (event, filePath: string): string[] => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
      return withDbConnection(filePath, (db) => dbService.getSlideIds(db))
    } catch (error) {
      console.error('Error in db:get-slide-ids:', error)
      throw error
    }
  })

  /**
   * Loads a specific slide with all its elements from the database.
   */
  ipcMain.handle('db:get-slide', (event, filePath: string, slideId: string): Slide | null => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
  ipcMain.handle('db:create-slide', (event, filePath: string): Slide => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
  ipcMain.handle('db:duplicate-slide', (event, filePath: string, slideId: string): Slide => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
  ipcMain.handle('db:save-slide', (event, filePath: string, slide: Slide): void => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
    (event, filePath: string, slideId: string, thumbnail: string): void => {
      try {
        validateFilePath(filePath)
        assertSenderOwnsDocument(event.sender.id, filePath)
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
  ipcMain.handle('db:get-thumbnails', (event, filePath: string): Record<string, string> => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
      return withDbConnection(filePath, (db) => dbService.getThumbnails(db))
    } catch (error) {
      console.error('Error in db:get-thumbnails:', error)
      throw error
    }
  })

  ipcMain.handle('db:get-setting', (event, filePath: string, key: string): string | null => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
      return withDbConnection(filePath, (db) => dbService.getSetting(db, key))
    } catch (error) {
      console.error('Error in db:get-setting:', error)
      throw error
    }
  })

  ipcMain.handle(
    'db:set-setting',
    (event, filePath: string, key: string, value: string | null): void => {
      try {
        validateFilePath(filePath)
        assertSenderOwnsDocument(event.sender.id, filePath)
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
    (event, filePath: string, background: dbService.SlideBackground | null): void => {
      try {
        validateFilePath(filePath)
        assertSenderOwnsDocument(event.sender.id, filePath)
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

  ipcMain.handle('db:delete-slide', (event, filePath: string, slideId: string): void => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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

  ipcMain.handle('db:reorder-slides', (event, filePath: string, orderedIds: string[]): void => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
   * Closes a database connection and removes it from the cache.
   * Used before overwriting or deleting a file.
   * Uses PASSIVE checkpoint mode for non-blocking WAL flush.
   */
  ipcMain.handle('db:close-connection', (event, filePath: string): void => {
    validateFilePath(filePath)
    const window = getEditorForSender(event.sender.id)
    if (!window || !editorWindows.ownsDocument(window, filePath)) {
      throw new Error('Cannot close a presentation owned by another editor window')
    }
    closeDbConnection(filePath, 'passive', { forgetReadOnly: true })
  })

  /**
   * Probes a `.tb` candidate for its format identity without mutating it or
   * caching a connection. Used by the renderer's open flow to distinguish
   * fresh/legacy/current/tooNew/notTwig before committing to an open mode.
   */
  ipcMain.handle('db:probe-format', (event, filePath: string): dbService.FormatProbeResult => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
    (event, filePath: string, options?: { readOnly?: boolean }): string[] => {
      try {
        validateFilePath(filePath)
        const window = getEditorForSender(event.sender.id)
        if (!window || !editorWindows.ownsDocument(window, filePath)) {
          throw new Error('Presentation must be reserved by this editor before opening')
        }
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
  ipcMain.handle('db:create-temp', (event): string => {
    try {
      ensureTempDir()
      const tempPath = createTempDbPath()

      // Create and initialize the database (stamps format metadata).
      getWritableConnection(tempPath)

      // Track this as a temp file for cleanup — only after successful init.
      registerTempFile(tempPath)

      const window = getEditorForSender(event.sender.id)
      if (!window) throw new Error('Temporary presentations require an editor window')
      editorWindows.bindCreatedDocument(window, tempPath)

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
  ipcMain.handle('db:is-temp-file', (event, filePath: string): boolean => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)

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

  ipcMain.handle('db:is-bootstrap-presentation', (event, filePath: string): boolean => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
  ipcMain.handle('db:delete-temp', (event, filePath: string): void => {
    try {
      const window = getEditorForSender(event.sender.id)
      if (!window) throw new Error('Only editor windows can delete temporary presentations')
      const owner = editorWindows.findDocumentOwner(filePath)
      if (owner && owner.window.id !== window.id) {
        throw new Error('Cannot delete a temporary presentation owned by another editor window')
      }
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
      editorWindows.releaseDocument(window, filePath)
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
    async (event, sourcePath: string, destPath: string): Promise<SaveLocationResult> => {
      let stagingPath: string | null = null
      const window = getEditorForSender(event.sender.id)
      try {
        validateFilePath(sourcePath)
        validateFilePath(destPath)
        if (!window || !editorWindows.ownsDocument(window, sourcePath, false)) {
          throw new Error('Cannot save a presentation owned by another editor window')
        }
        ensureMasFileAccess(sourcePath)
        ensureMasFileAccess(destPath)

        if (!fs.existsSync(sourcePath)) {
          throw new Error(`Source file does not exist: ${sourcePath}`)
        }
        if (pathsReferToSameFile(sourcePath, destPath)) {
          throw new Error('Cannot save a temporary presentation onto itself')
        }
        const reservation = editorWindows.reserveDocument(window, destPath)
        if (reservation === 'focused-existing') return { status: 'focused-existing' }
        if (isOpenedReadOnly(sourcePath)) {
          throw new Error(
            'Cannot save a file that was opened read-only. Close and reopen it after upgrading twig, or save a copy through your file manager.'
          )
        }

        // These calls are intentionally strict. A failed checkpoint or MAS
        // shadow sync aborts the save while its recoverable source stays open.
        closeDbConnection(sourcePath, 'truncate', { forgetReadOnly: true })
        closeDbConnection(destPath, 'truncate', { forgetReadOnly: true })

        stagingPath = stageVerifiedDatabaseCopy(sourcePath, destPath)
        installStagedDatabase(stagingPath, destPath)
        stagingPath = null

        // Do not remove the only source until the installed destination has
        // successfully opened and initialized.
        getWritableConnection(destPath)
        try {
          fs.unlinkSync(sourcePath)
          removeDatabaseCompanions(sourcePath)
          unregisterTempFile(sourcePath)
          evictConnectionCaches(sourcePath)
        } catch (cleanupError) {
          // The destination is valid; retaining a duplicate temp source is much
          // safer than reporting the save as failed or hiding the recovery copy.
          safeLog(
            `Saved ${destPath}, but retained temp source ${sourcePath}: ${formatError(cleanupError)}`,
            'warn'
          )
        }

        safeLog(`Saved temp database from ${sourcePath} to ${destPath}`)
        editorWindows.commitDocument(window, destPath)
        return { status: 'saved', filePath: destPath }
      } catch (error) {
        if (window) editorWindows.cancelDocument(window, destPath)
        console.error('Error in db:save-to-location:', error)
        throw error
      } finally {
        if (stagingPath) {
          try {
            if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath)
          } catch {
            // A unique, verified staging file is a recoverable artifact.
          }
        }
      }
    }
  )

  /**
   * Copies a database to a new location (Save As from an already-saved file).
   */
  ipcMain.handle(
    'db:copy-to-location',
    async (event, sourcePath: string, destPath: string): Promise<SaveLocationResult> => {
      let stagingPath: string | null = null
      const window = getEditorForSender(event.sender.id)
      try {
        validateFilePath(sourcePath)
        validateFilePath(destPath)
        if (!window || !editorWindows.ownsDocument(window, sourcePath, false)) {
          throw new Error('Cannot copy a presentation owned by another editor window')
        }
        ensureMasFileAccess(sourcePath)
        ensureMasFileAccess(destPath)

        if (pathsReferToSameFile(sourcePath, destPath)) {
          throw new Error(
            'Cannot save to the same file. Please choose a different filename or location.'
          )
        }
        const reservation = editorWindows.reserveDocument(window, destPath)
        if (reservation === 'focused-existing') return { status: 'focused-existing' }

        if (!fs.existsSync(sourcePath)) {
          throw new Error(`Source file does not exist: ${sourcePath}`)
        }
        if (isOpenedReadOnly(sourcePath)) {
          throw new Error(
            'Cannot copy a file that was opened read-only. Close and reopen it after upgrading twig, or copy it through your file manager.'
          )
        }

        closeDbConnection(sourcePath, 'truncate')
        closeDbConnection(destPath, 'truncate', { forgetReadOnly: true })

        stagingPath = stageVerifiedDatabaseCopy(sourcePath, destPath)
        installStagedDatabase(stagingPath, destPath)
        stagingPath = null
        getWritableConnection(destPath)

        safeLog(`Copied database from ${sourcePath} to ${destPath}`)
        editorWindows.commitDocument(window, destPath)
        return { status: 'saved', filePath: destPath }
      } catch (error) {
        if (window) editorWindows.cancelDocument(window, destPath)
        console.error('Error in db:copy-to-location:', error)
        throw error
      } finally {
        if (stagingPath) {
          try {
            if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath)
          } catch {
            // A unique, verified staging file is a recoverable artifact.
          }
        }
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
      const fonts = getSystemFonts().flatMap((font) => {
        try {
          const realPath = fs.realpathSync(font.path)
          allowedSystemFontPaths.add(realPath)
          return [{ ...font, path: realPath }]
        } catch {
          return []
        }
      })
      return fonts
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
      event,
      filePath: string,
      fontPath: string,
      fontFamily: string,
      variant: string = 'normal-normal'
    ): void => {
      try {
        validateFilePath(filePath)
        assertSenderOwnsDocument(event.sender.id, filePath)

        const allowedFontPath = assertAllowedSystemFontPath(fontPath)
        if (typeof fontFamily !== 'string' || fontFamily.length === 0 || fontFamily.length > 256) {
          throw new Error('Invalid font family')
        }
        if (!/^[a-z0-9-]{1,64}$/i.test(variant)) {
          throw new Error('Invalid font variant')
        }

        // Read only a font path returned by fonts:get-system-fonts.
        const fontData = fs.readFileSync(allowedFontPath)

        // Determine format from file extension
        const ext = extname(allowedFontPath).toLowerCase()
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
  ipcMain.handle('fonts:get-embedded-fonts', (event, filePath: string): FontData[] => {
    try {
      validateFilePath(filePath)
      assertSenderOwnsDocument(event.sender.id, filePath)
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
      event,
      filePath: string,
      fontFamily: string,
      variant: string = 'normal-normal'
    ): FontData | null => {
      try {
        validateFilePath(filePath)
        assertSenderOwnsDocument(event.sender.id, filePath)
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
      return fs.readFileSync(assertAllowedSystemFontPath(fontPath))
    } catch (error) {
      console.error('Error in fonts:load-font-file:', error)
      throw error
    }
  })

  if (pendingOpenFiles.length > 0) {
    const launchFiles = pendingOpenFiles.splice(0)
    for (const filePath of launchFiles) createWindow(filePath)
  } else {
    createWindow()
  }

  // On macOS, restore the primary editor window when the dock icon is clicked.
  app.on('activate', () => {
    showOrCreateEditorWindow()
  })

  // --------------------------------------------------------------------------
  // File Association Handlers
  // --------------------------------------------------------------------------

  /**
   * Returns the file path to open on launch (from OS file association or argv).
   * Clears the pending value after returning it so it is consumed only once.
   */
  ipcMain.handle('app:get-file-to-open', (event): string | null => {
    const window = getEditorForSender(event.sender.id)
    return window ? editorWindows.consumeLaunchFile(window) : null
  })

  ipcMain.handle('windows:create-editor', () => {
    createWindow()
  })

  ipcMain.on('windows:ready', (event) => {
    const window = getEditorForSender(event.sender.id)
    if (!window) return
    readyEditorIds.add(window.id)
    const queued = queuedEditorOpenFiles.get(window.id) ?? []
    queuedEditorOpenFiles.delete(window.id)
    for (const filePath of queued) sendToEditor(window, 'app:open-file', filePath)
  })

  ipcMain.handle('windows:close-if-empty', (event): boolean => {
    const window = getEditorForSender(event.sender.id)
    const record = window ? editorWindows.getEditor(window) : null
    if (
      !window ||
      !record ||
      record.currentPath ||
      record.pendingPath ||
      editorWindows.getEditors().length <= 1
    ) {
      return false
    }
    setImmediate(() => {
      if (!window.isDestroyed()) window.destroy()
    })
    return true
  })

  ipcMain.handle('windows:open-file', (event, filePath: string): 'created' | 'focused-existing' => {
    validateFilePath(filePath)
    const existingOwner = editorWindows.findDocumentOwner(filePath)
    if (existingOwner) {
      editorWindows.focus(existingOwner.window)
      return 'focused-existing'
    }
    const sourceWindow = getEditorForSender(event.sender.id)
    if (!sourceWindow) throw new Error('Only editor windows can open presentations')
    createWindow(filePath)
    return 'created'
  })

  ipcMain.handle(
    'documents:reserve',
    (event, filePath: string): 'reserved' | 'already-current' | 'focused-existing' => {
      validateFilePath(filePath)
      const window = getEditorForSender(event.sender.id)
      if (!window) throw new Error('Only editor windows can reserve presentations')
      return editorWindows.reserveDocument(window, filePath)
    }
  )

  ipcMain.handle('documents:commit', (event, filePath: string): void => {
    validateFilePath(filePath)
    const window = getEditorForSender(event.sender.id)
    if (!window) throw new Error('Only editor windows can commit presentations')
    editorWindows.commitDocument(window, filePath)
  })

  ipcMain.handle('documents:cancel', (event, filePath: string): void => {
    validateFilePath(filePath)
    const window = getEditorForSender(event.sender.id)
    if (window) editorWindows.cancelDocument(window, filePath)
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
  ipcMain.handle('debug:open-window', (event) => {
    const owner = getEditorForSender(event.sender.id)
    if (!owner) throw new Error('Debug windows require an editor owner')
    createDebugWindow(owner)
  })

  /**
   * Broadcasts state updates to the debug window (if open).
   * Called from the main renderer window whenever state changes.
   */
  ipcMain.on('debug:state-update', (event, state) => {
    const owner = getEditorForSender(event.sender.id)
    const debugWindow = owner ? editorWindows.getAuxiliary(owner, 'debug') : null
    if (debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.webContents.send('debug:state-changed', state)
    }
  })

  /**
   * Handles request from debug window to get initial state.
   * Forwards the request to the main window.
   */
  ipcMain.on('debug:request-state', (event) => {
    const owner = getOwnerForSender(event.sender.id)
    if (owner) sendToEditor(owner, 'debug:request-state-from-main')
  })

  // --------------------------------------------------------------------------
  // Presentation Window Handlers
  // --------------------------------------------------------------------------

  // Fire-and-forget: renderer does not await this, so we use ipcMain.on
  ipcMain.on('presentation:open-window', (event) => {
    const owner = getEditorForSender(event.sender.id)
    if (owner) createPresentationWindow(owner)
  })

  ipcMain.handle('presentation:close-window', (event) => {
    const owner = getEditorForSender(event.sender.id)
    const presentationWindow = owner ? editorWindows.getAuxiliary(owner, 'presentation') : null
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
  })

  /** Forward slide state from main window to presentation window. */
  ipcMain.on('presentation:state-update', (event, state) => {
    const owner = getEditorForSender(event.sender.id)
    const presentationWindow = owner ? editorWindows.getAuxiliary(owner, 'presentation') : null
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.webContents.send('presentation:state-changed', state)
    }
  })

  /** Forward navigation requests from presentation window to main window. */
  ipcMain.on('presentation:navigate', (event, direction: string) => {
    const owner = getOwnerForSender(event.sender.id)
    if (owner) sendToEditor(owner, 'presentation:navigate-request', direction)
  })

  /** Forward exit request from presentation window to main window. */
  ipcMain.on('presentation:exit', (event) => {
    const owner = getOwnerForSender(event.sender.id)
    const presentationWindow = owner ? editorWindows.getAuxiliary(owner, 'presentation') : null
    if (presentationWindow && !presentationWindow.isDestroyed()) {
      presentationWindow.close()
    }
  })

  /** Presentation window signals it's ready — forward to main window so it sends initial state. */
  ipcMain.on('presentation:ready', (event) => {
    const owner = getOwnerForSender(event.sender.id)
    if (owner) sendToEditor(owner, 'presentation:window-ready')
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
      for (const record of editorWindows.getEditors()) {
        sendToEditor(record.window, 'app:update-downloaded', version)
      }
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
let allowNativeQuit = false
let quitSequence: Promise<void> | null = null

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
    let closeFailed = false
    // Close all database connections with full WAL checkpoint. Iterate both
    // RW and RO caches (RO close skips the checkpoint internally).
    for (const filePath of getOpenConnectionPaths()) {
      try {
        closeDbConnection(filePath, 'truncate')
      } catch (error) {
        closeFailed = true
        safeLog(
          `Preserving temp/recovery files because ${filePath} could not be safely closed: ${formatError(error)}`,
          'error'
        )
      }
    }

    if (!closeFailed) {
      cleanupAllTempFiles()
      removeTempDir()
    }

    // Release all security-scoped resource access (MAS builds only)
    bookmarksService.stopAccessingAllBookmarks()
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
app.on('before-quit', (event) => {
  if (allowNativeQuit) return
  event.preventDefault()
  if (quitSequence) return

  isQuitting = true
  quitSequence = (async () => {
    const controllers = editorWindows
      .getEditors()
      .map((record) => editorCloseControllers.get(record.window.id))
      .filter((controller): controller is ReturnType<typeof createWindowCloseController> =>
        Boolean(controller)
      )
    if (!(await closeWindowsSequentially(controllers))) {
      isQuitting = false
      return
    }

    await cleanupResources()
    allowNativeQuit = true
    app.quit()
  })().finally(() => {
    quitSequence = null
  })
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
