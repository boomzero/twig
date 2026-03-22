/**
 * Preload script for twig.
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
    showSaveDialog: () => ipcRenderer.invoke('dialog:show-save-dialog'),

    /** Show an image file dialog and return the image as base64 data URI */
    showImageDialog: () => ipcRenderer.invoke('dialog:show-image-dialog')
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
    closeConnection: (filePath) => ipcRenderer.invoke('db:close-connection', filePath),

    /** Create a new temporary database for unsaved presentations */
    createTemp: () => ipcRenderer.invoke('db:create-temp'),

    /** Check if a file path is a temporary file */
    isTempFile: (filePath) => ipcRenderer.invoke('db:is-temp-file', filePath),

    /** Move a temp database to a user-chosen location (Save) */
    saveToLocation: (sourcePath, destPath) =>
      ipcRenderer.invoke('db:save-to-location', sourcePath, destPath),

    /** Copy a database to a new location (Save As) */
    copyToLocation: (sourcePath, destPath) =>
      ipcRenderer.invoke('db:copy-to-location', sourcePath, destPath),

    /** Delete a temporary database file */
    deleteTemp: (filePath) => ipcRenderer.invoke('db:delete-temp', filePath),

    /** Save a thumbnail for a specific slide */
    saveThumbnail: (filePath: string, slideId: string, thumbnail: string) =>
      ipcRenderer.invoke('db:save-thumbnail', filePath, slideId, thumbnail),

    /** Retrieve all stored thumbnails for a presentation */
    getThumbnails: (filePath: string) => ipcRenderer.invoke('db:get-thumbnails', filePath),

    /** Retrieve a per-presentation setting value */
    getSetting: (filePath: string, key: string) =>
      ipcRenderer.invoke('db:get-setting', filePath, key),

    /** Persist a per-presentation setting value (null removes it) */
    setSetting: (filePath: string, key: string, value: string | null) =>
      ipcRenderer.invoke('db:set-setting', filePath, key, value),

    /** Set the same background on every slide in the presentation */
    applyBackgroundToAll: (filePath: string, background: object | null) =>
      ipcRenderer.invoke('db:apply-background-to-all', filePath, background),

    /** Delete a slide and all its elements from the database */
    deleteSlide: (filePath: string, slideId: string) =>
      ipcRenderer.invoke('db:delete-slide', filePath, slideId),

    /** Update slide ordering to match the provided ID sequence */
    reorderSlides: (filePath: string, orderedIds: string[]) =>
      ipcRenderer.invoke('db:reorder-slides', filePath, orderedIds)
  },

  // Font operations
  fonts: {
    /** Get all available system fonts */
    getSystemFonts: () => ipcRenderer.invoke('fonts:get-system-fonts'),

    /** Embed a font file into the database */
    embedFont: (filePath, fontPath, fontFamily, variant) =>
      ipcRenderer.invoke('fonts:embed-font', filePath, fontPath, fontFamily, variant),

    /** Get all embedded fonts from the database */
    getEmbeddedFonts: (filePath) => ipcRenderer.invoke('fonts:get-embedded-fonts', filePath),

    /** Get a specific font from the database */
    getFontData: (filePath, fontFamily, variant) =>
      ipcRenderer.invoke('fonts:get-font-data', filePath, fontFamily, variant),

    /** Load a font file directly from the filesystem for preview */
    loadFontFile: (fontPath) => ipcRenderer.invoke('fonts:load-font-file', fontPath)
  },

  // Debug window operations
  debug: {
    /** Open the debug window */
    openWindow: () => ipcRenderer.invoke('debug:open-window'),

    /** Send state update to debug window */
    sendStateUpdate: (state) => ipcRenderer.send('debug:state-update', state),

    /** Listen for state updates (for debug window) */
    onStateUpdate: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown): void =>
        callback(state as Parameters<typeof callback>[0])
      ipcRenderer.on('debug:state-changed', handler)
      return (): void => {
        ipcRenderer.removeListener('debug:state-changed', handler)
      }
    },

    /** Request current state (for debug window) */
    requestState: () => ipcRenderer.send('debug:request-state'),

    /** Listen for state requests from debug window (for main window) */
    onStateRequest: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('debug:request-state-from-main', handler)
      return (): void => {
        ipcRenderer.removeListener('debug:request-state-from-main', handler)
      }
    }
  },

  // Presentation window operations
  presentation: {
    /** Open the fullscreen presentation window (fire-and-forget, no await) */
    openWindow: () => ipcRenderer.send('presentation:open-window'),

    /** Close the presentation window */
    closeWindow: () => ipcRenderer.invoke('presentation:close-window'),

    /** Send current slide state to the presentation window (called from main window) */
    sendStateUpdate: (state) => ipcRenderer.send('presentation:state-update', state),

    /** Listen for navigation requests from the presentation window (received in main window) */
    onNavigateRequest: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, direction: unknown): void =>
        callback(direction as Parameters<typeof callback>[0])
      ipcRenderer.on('presentation:navigate-request', handler)
      return (): void => {
        ipcRenderer.removeListener('presentation:navigate-request', handler)
      }
    },

    /** Listen for the presentation window being closed (received in main window) */
    onWindowClosed: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('presentation:window-closed', handler)
      return (): void => {
        ipcRenderer.removeListener('presentation:window-closed', handler)
      }
    },

    /** Send navigation request to main window (called from presentation window) */
    navigate: (direction) => ipcRenderer.send('presentation:navigate', direction),

    /** Exit presentation (called from presentation window) */
    exit: () => ipcRenderer.send('presentation:exit'),

    /** Listen for slide state updates (received in presentation window) */
    onStateChanged: (callback) => {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown): void =>
        callback(state as Parameters<typeof callback>[0])
      ipcRenderer.on('presentation:state-changed', handler)
      return (): void => {
        ipcRenderer.removeListener('presentation:state-changed', handler)
      }
    },

    /** Signal to main process that this presentation window is ready (called from presentation window) */
    signalReady: () => ipcRenderer.send('presentation:ready'),

    /** Listen for presentation window ready signal (received in main window) */
    onWindowReady: (callback) => {
      const handler = (): void => callback()
      ipcRenderer.on('presentation:window-ready', handler)
      return (): void => {
        ipcRenderer.removeListener('presentation:window-ready', handler)
      }
    }
  },

  // File association
  app: {
    /** Returns the .tb file path passed via OS file association (consumed once) */
    getFileToOpen: () => ipcRenderer.invoke('app:get-file-to-open'),

    /** Listen for open-file events sent while the app is already running */
    onOpenFile: (callback: (filePath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, filePath: string): void =>
        callback(filePath)
      ipcRenderer.on('app:open-file', handler)
      return (): void => {
        ipcRenderer.removeListener('app:open-file', handler)
      }
    }
  },

  // Window lifecycle
  lifecycle: {
    /** Called by main process before window closes to flush pending saves */
    onBeforeClose: (callback) => {
      const listener = (): void => callback()
      ipcRenderer.on('lifecycle:before-close', listener)
      return (): void => {
        ipcRenderer.removeListener('lifecycle:before-close', listener)
      }
    },

    /** Notify main process that flush is complete */
    flushComplete: () => ipcRenderer.send('lifecycle:flush-complete')
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
