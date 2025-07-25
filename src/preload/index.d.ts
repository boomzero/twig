import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      saveDeck: (
        presentationJSON: string
      ) => Promise<{ success: boolean; path?: string; error?: string }>
      openDeck: () => Promise<{ success: boolean; data?: string; error?: string }>
    }
  }
}
