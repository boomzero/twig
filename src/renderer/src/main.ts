import { mount } from 'svelte'
import { ipcMain, dialog } from 'electron'
import AdmZip from 'adm-zip'

import './assets/main.css'

import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app

// Handler to save a .deck file
ipcMain.handle('save-deck', async (_event, presentationJSON: string) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Save Deckhand Presentation',
    defaultPath: 'presentation.deck',
    filters: [{ name: 'Deckhand Files', extensions: ['deck'] }]
  })

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
      return { success: false, error: error.message }
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
        return { success: true, data: presentationJSON }
      } else {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error('presentation.json not found in the .deck file.')
      }
    } catch (error) {
      console.error('Failed to open deck file:', error)
      return { success: false, error: error.message }
    }
  }
  return { success: false, error: 'Open was cancelled.' }
})
