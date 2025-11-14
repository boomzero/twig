import { ElectronAPI } from '@electron-toolkit/preload'
import type { Slide } from '../renderer/src/lib/state.svelte'

/**
 * Represents a system font with its family name and file path
 */
export interface SystemFont {
  /** Font family name */
  family: string
  /** Absolute path to the font file */
  path: string
  /** Font file format (ttf, otf, woff, woff2) */
  format: string
}

/**
 * Represents an embedded font stored in the database
 */
export interface FontData {
  /** Unique identifier */
  id: string
  /** Font family name */
  fontFamily: string
  /** Binary font file data */
  fontData: Buffer
  /** Font file format */
  format: string
  /** Font variant (e.g., "normal-normal", "bold-italic") */
  variant: string
}

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
      fonts: {
        getSystemFonts: () => Promise<SystemFont[]>
        embedFont: (
          filePath: string,
          fontPath: string,
          fontFamily: string,
          variant?: string
        ) => Promise<void>
        getEmbeddedFonts: (filePath: string) => Promise<FontData[]>
        getFontData: (filePath: string, fontFamily: string, variant?: string) => Promise<FontData | null>
        loadFontFile: (fontPath: string) => Promise<Buffer>
      }
    }
  }
}
