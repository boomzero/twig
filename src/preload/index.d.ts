import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      saveDeck: (
        presentationJSON: string,
        filePath: string
      ) => Promise<{ success: boolean; path?: string; error?: string }>
      saveAsDeck: (
        presentationJSON: string
      ) => Promise<{ success: boolean; path?: string; error?: string }>
      openDeck: () => Promise<{ success: boolean; data?: string; error?: string; path?: string }>
      onUndo: (callback: () => void) => () => void
      onRedo: (callback: () => void) => () => void
      onSave: (callback: () => void) => () => void
    }
  }
}
