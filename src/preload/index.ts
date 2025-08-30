import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  saveDeck: (presentationJSON: string, filePath: string) =>
    ipcRenderer.invoke('save-deck', presentationJSON, filePath),
  saveAsDeck: (presentationJSON: string) => ipcRenderer.invoke('save-as-deck', presentationJSON),
  openDeck: () => ipcRenderer.invoke('open-deck'),
  onUndo: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('undo', listener)
    return () => ipcRenderer.removeListener('undo', listener)
  },
  onRedo: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('redo', listener)
    return () => ipcRenderer.removeListener('redo', listener)
  },
  onSave: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('save', listener)
    return () => ipcRenderer.removeListener('save', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
