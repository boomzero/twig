import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import AdmZip from 'adm-zip'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS, it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

// Handler to save a .deck file and the user gets to choose the path
ipcMain.handle('save-as-deck', async (_event, presentationJSON: string) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save Deckhand Presentation',
    defaultPath: 'presentation.deck',
    filters: [{ name: 'Deckhand Files', extensions: ['deck'] }]
  })
  // noinspection DuplicatedCode
  if (filePath) {
    try {
      const zip = new AdmZip()
      // Add the presentation.json file to the root of the zip
      zip.addFile('presentation.json', Buffer.from(presentationJSON))
      // In the future, you would also add fonts and images here
      zip.writeZip(filePath)
      return { success: true, path: filePath }
    } catch (error) {
      console.error('Failed to save deck file:', error)
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
      return { success: false, error: errorMessage }
    }
  }
  return { success: false, error: 'Save was cancelled.' }
})

// Handler to save a .deck file, but we choose the path
ipcMain.handle('save-deck', async (_event, presentationJSON: string, filePath: string) => {
  // noinspection DuplicatedCode
  if (filePath) {
    try {
      const zip = new AdmZip()
      // Add the presentation.json file to the root of the zip
      zip.addFile('presentation.json', Buffer.from(presentationJSON))
      // In the future, you would also add fonts and images here
      zip.writeZip(filePath)
      return { success: true, path: filePath }
    } catch (error) {
      console.error('Failed to save deck file:', error)
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
      return { success: false, error: errorMessage }
    }
  }
  return { success: false, error: 'Save was cancelled.' }
})

// Handler to open a .deck file
ipcMain.handle('open-deck', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Open Deckhand Presentation',
    properties: ['openFile'],
    filters: [{ name: 'Deckhand Files', extensions: ['deck'] }]
  })

  if (filePaths && filePaths.length > 0) {
    const filePath = filePaths[0]
    try {
      const zip = new AdmZip(filePath)
      const zipEntry = zip.getEntry('presentation.json')
      if (zipEntry) {
        const presentationJSON = zipEntry.getData().toString('utf8')
        return { success: true, data: presentationJSON, path: filePath }
      } else {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error('presentation.json not found in the .deck file.')
      }
    } catch (error) {
      console.error('Failed to open deck file:', error)
      const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred'
      return { success: false, error: errorMessage }
    }
  }
  return { success: false, error: 'Open was cancelled.' }
})
