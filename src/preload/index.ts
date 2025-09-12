import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Presentation, DeckElement } from '../types'

// Custom APIs for renderer
const api = {
  openDeck: () => ipcRenderer.invoke('open-deck'),
  saveAs: (presentation: Presentation | null) => ipcRenderer.invoke('save-as', presentation),
  getElementsForSlide: (slideId: string) =>
    ipcRenderer.invoke('get-elements-for-slide', slideId),
  createSlide: (id: string, slideNumber: number) =>
    ipcRenderer.invoke('create-slide', id, slideNumber),
  createElement: (slideId: string, element: DeckElement) =>
    ipcRenderer.invoke('create-element', slideId, element),
  updateElement: (elementId: string, updates: Partial<DeckElement>) =>
    ipcRenderer.invoke('update-element', elementId, updates),
  deleteElements: (elementIds: string[]) => ipcRenderer.invoke('delete-elements', elementIds),
  deleteSlide: (slideId: string) => ipcRenderer.invoke('delete-slide', slideId)
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
