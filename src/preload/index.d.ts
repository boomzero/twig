import { ElectronAPI } from '@electron-toolkit/preload'
import type { Presentation, Slide, DeckElement } from '../types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      openDeck: () => Promise<{
        success: boolean
        data?: { slides: Pick<Slide, 'id' | 'slideNumber'>[]; filePath: string }
        error?: string
      }>
      saveAs: (
        presentation: Presentation | null
      ) => Promise<{ success: boolean; path?: string; error?: string }>
      getElementsForSlide: (slideId: string) => Promise<{
        success: boolean
        data?: DeckElement[]
        error?: string
      }>
      createSlide: (
        id: string,
        slideNumber: number
      ) => Promise<{ success: boolean; error?: string }>
      createElement: (
        slideId: string,
        element: DeckElement
      ) => Promise<{ success: boolean; error?: string }>
      updateElement: (
        elementId: string,
        updates: Partial<DeckElement>
      ) => Promise<{ success: boolean; error?: string }>
      deleteElements: (elementIds: string[]) => Promise<{ success: boolean; error?: string }>
      deleteSlide: (slideId: string) => Promise<{ success: boolean; error?: string }>
    }
  }
}
