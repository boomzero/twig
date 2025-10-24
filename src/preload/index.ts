/**
 * Preload script for Deckhand.
 *
 * This script runs in a privileged context and safely exposes IPC APIs
 * to the renderer process via contextBridge. It acts as a secure bridge
 * between the main process (Node.js) and the renderer (browser).
 *
 * The renderer can access these APIs via:
 * - window.api.dialog.showOpenDialog()
 * - window.api.db.getSlideIds(filePath)
 * etc.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// ============================================================================
// API Definitions
// ============================================================================

/**
 * Custom APIs exposed to the renderer process.
 * These wrap IPC calls to the main process for file dialogs and database operations.
 */
const api = {
  // File dialog operations
  dialog: {
    /** Show a file open dialog and return the selected path */
    showOpenDialog: () => ipcRenderer.invoke('dialog:show-open-dialog'),

    /** Show a file save dialog and return the selected path */
    showSaveDialog: () => ipcRenderer.invoke('dialog:show-save-dialog')
  },

  // Database operations
  db: {
    /** Get all slide IDs from a presentation file */
    getSlideIds: (filePath) => ipcRenderer.invoke('db:get-slide-ids', filePath),

    /** Load a specific slide with all its elements */
    getSlide: (filePath, slideId) => ipcRenderer.invoke('db:get-slide', filePath, slideId),

    /** Create a new blank slide in the database */
    createSlide: (filePath) => ipcRenderer.invoke('db:create-slide', filePath),

    /** Save a slide to the database */
    saveSlide: (filePath, slide) => ipcRenderer.invoke('db:save-slide', filePath, slide),

    /** Save all slides to a new file (Save As) */
    saveAs: (filePath, slides) => ipcRenderer.invoke('db:save-as', filePath, slides),

    /** Close a database connection (used before overwriting files) */
    closeConnection: (filePath) => ipcRenderer.invoke('db:close-connection', filePath)
  }
}

// ============================================================================
// Context Bridge Setup
// ============================================================================

/**
 * Expose APIs to the renderer process safely via contextBridge.
 * If context isolation is disabled (not recommended), fall back to window global.
 */
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // Fallback for when context isolation is disabled (not recommended for security)
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
