import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type { Database } from 'better-sqlite3'
import {
  openDb,
  initDb,
  getSlides,
  getElementsForSlide,
  createSlide,
  createElement,
  updateElement,
  deleteElements,
  deleteSlide,
  saveNewPresentation
} from './db'
import type { Presentation, DeckElement } from '../types'

let activeDb: Database | null = null
let activeDbPath: string | null = null

function closeActiveDb(): void {
  if (activeDb) {
    activeDb.close()
    activeDb = null
    activeDbPath = null
    console.log('Active database closed.')
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', () => {
    closeActiveDb()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // The 'close' event on the window will handle closing the DB.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC Handlers for granular database operations

ipcMain.handle('open-deck', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open Deckhand Presentation',
    properties: ['openFile'],
    filters: [{ name: 'Deckhand SQL Files', extensions: ['decksql'] }]
  })

  if (filePaths && filePaths.length > 0) {
    const filePath = filePaths[0]
    try {
      closeActiveDb() // Close any previously opened database
      activeDb = openDb(filePath)
      activeDbPath = filePath
      const slides = getSlides(activeDb)
      return { success: true, data: { slides, filePath } }
    } catch (error) {
      console.error('Failed to open deck file:', error)
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
      return { success: false, error: errorMessage }
    }
  }
  return { success: false, error: 'Open was cancelled.' }
})

ipcMain.handle('save-as', async (_event, presentation: Presentation | null) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save Deckhand Presentation',
    defaultPath: 'presentation.decksql',
    filters: [{ name: 'Deckhand SQL Files', extensions: ['decksql'] }]
  })

  if (!filePath) {
    return { success: false, error: 'Save was cancelled.' }
  }

  try {
    // Case 1: An existing file is open, and we are saving a copy.
    if (activeDbPath && activeDb) {
      activeDb.prepare(`VACUUM INTO ?`).run(filePath)
    }
    // Case 2: This is a new, unsaved presentation.
    else if (presentation) {
      const newDb = openDb(filePath)
      initDb(newDb)
      saveNewPresentation(newDb, presentation)
      newDb.close() // Close connection after saving
    } else {
      throw new Error('Invalid state for Save As operation.')
    }

    // After saving, make the new file the active database.
    closeActiveDb()
    activeDb = openDb(filePath)
    activeDbPath = filePath

    return { success: true, path: filePath }
  } catch (error) {
    console.error('Failed to save deck file:', error)
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('get-elements-for-slide', (_event, slideId: string) => {
  if (!activeDb) return { success: false, error: 'No active database.' }
  try {
    const elements = getElementsForSlide(activeDb, slideId)
    return { success: true, data: elements }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('create-slide', (_event, id: string, slideNumber: number) => {
  if (!activeDb) return { success: false, error: 'No active database.' }
  try {
    createSlide(activeDb, id, slideNumber)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('create-element', (_event, slideId: string, element: DeckElement) => {
  if (!activeDb) return { success: false, error: 'No active database.' }
  try {
    createElement(activeDb, slideId, element)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('update-element', (_event, elementId: string, updates: Partial<DeckElement>) => {
  if (!activeDb) return { success: false, error: 'No active database.' }
  try {
    updateElement(activeDb, elementId, updates)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('delete-elements', (_event, elementIds: string[]) => {
  if (!activeDb) return { success: false, error: 'No active database.' }
  try {
    deleteElements(activeDb, elementIds)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})

ipcMain.handle('delete-slide', (_event, slideId: string) => {
  if (!activeDb) return { success: false, error: 'No active database.' }
  try {
    deleteSlide(activeDb, slideId)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
    return { success: false, error: errorMessage }
  }
})
