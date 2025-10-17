import { ElectronAPI } from '@electron-toolkit/preload'
import type { Slide } from '../renderer/src/lib/state.svelte'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      dialog: {
        showOpenDialog: () => Promise<string | null>
        showSaveDialog: () => Promise<string | null>
      }
      db: {
        getSlideIds: (filePath: string) => Promise<string[]>
        getSlide: (filePath: string, slideId: string) => Promise<Slide | null>
        createSlide: (filePath: string) => Promise<Slide>
        saveSlide: (filePath: string, slide: Slide) => Promise<void>
        saveAs: (filePath: string, slides: Slide[]) => Promise<void>
        closeConnection: (filePath: string) => Promise<void>
      }
    }
  }
}
