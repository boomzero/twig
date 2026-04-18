import { ElectronAPI } from '@electron-toolkit/preload'
import type { ArrowShape, Slide, SlideBackground } from '../renderer/src/lib/types'

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

/**
 * Represents image data returned from the image dialog
 */
export interface ImageData {
  /** Image data as base64 data URI */
  src: string
  /** Original filename */
  filename: string
}

/**
 * Represents a snapshot of the application state for debugging
 */
export interface DebugState {
  currentFilePath: string | null
  slideIds: string[]
  currentSlideIndex: number
  currentSlideId: string | null
  currentSlideElementCount: number
  selectedObjectId: string | null
  isPresentingMode: boolean
  isTempFile: boolean
  isLoadingSlide: boolean
  currentSlide: {
    id: string
    elements: Array<{
      type: 'rect' | 'ellipse' | 'triangle' | 'star' | 'arrow' | 'text' | 'image'
      id: string
      x: number
      y: number
      width: number
      height: number
      angle: number
      fill?: string
      text?: string
      fontSize?: number
      fontFamily?: string
      styles?: Record<string, Record<string, unknown>>
      src?: string
      filename?: string
      zIndex: number
      arrowShape?: ArrowShape
    }>
  } | null
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      dialog: {
        showOpenDialog: () => Promise<string | null>
        showSaveDialog: () => Promise<string | null>
        showImageDialog: () => Promise<ImageData | null>
      }
      db: {
        getSlideIds: (filePath: string) => Promise<string[]>
        getSlide: (filePath: string, slideId: string) => Promise<Slide | null>
        createSlide: (filePath: string) => Promise<Slide>
        saveSlide: (filePath: string, slide: Slide) => Promise<void>
        saveAs: (filePath: string, slides: Slide[]) => Promise<void>
        closeConnection: (filePath: string) => Promise<void>
        createTemp: () => Promise<string>
        isTempFile: (filePath: string) => Promise<boolean>
        isBootstrapPresentation: (filePath: string) => Promise<boolean>
        saveToLocation: (sourcePath: string, destPath: string) => Promise<string>
        copyToLocation: (sourcePath: string, destPath: string) => Promise<string>
        deleteTemp: (filePath: string) => Promise<void>
        saveThumbnail: (filePath: string, slideId: string, thumbnail: string) => Promise<void>
        getThumbnails: (filePath: string) => Promise<Record<string, string>>
        getSetting: (filePath: string, key: string) => Promise<string | null>
        setSetting: (filePath: string, key: string, value: string | null) => Promise<void>
        applyBackgroundToAll: (
          filePath: string,
          background: SlideBackground | null
        ) => Promise<void>
        deleteSlide: (filePath: string, slideId: string) => Promise<void>
        reorderSlides: (filePath: string, orderedIds: string[]) => Promise<void>
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
        getFontData: (
          filePath: string,
          fontFamily: string,
          variant?: string
        ) => Promise<FontData | null>
        loadFontFile: (fontPath: string) => Promise<Buffer>
      }
      presentation: {
        openWindow: () => void
        closeWindow: () => Promise<void>
        sendStateUpdate: (state: {
          slideId: string | null
          slideIndex: number
          slideCount: number
          filePath: string | null
        }) => void
        onNavigateRequest: (callback: (direction: 'next' | 'prev') => void) => () => void
        onWindowClosed: (callback: () => void) => () => void
        navigate: (direction: 'next' | 'prev') => void
        exit: () => void
        onStateChanged: (
          callback: (state: {
            slideId: string | null
            slideIndex: number
            slideCount: number
            filePath: string | null
          }) => void
        ) => () => void
        signalReady: () => void
        onWindowReady: (callback: () => void) => () => void
      }
      debug: {
        openWindow: () => Promise<void>
        sendStateUpdate: (state: DebugState) => void
        onStateUpdate: (callback: (state: DebugState) => void) => () => void
        requestState: () => void
        onStateRequest: (callback: () => void) => () => void
      }
      app: {
        getFileToOpen: () => Promise<string | null>
        onOpenSettings: (callback: () => void) => () => void
        onOpenFile: (callback: (filePath: string) => void) => () => void
        checkForUpdates: () => Promise<'checking' | 'up-to-date' | 'error'>
        installUpdate: () => Promise<void>
        checkForUpdateManual: () => Promise<{
          available: boolean
          version?: string
          error?: boolean
        }>
        downloadAndInstall: () => Promise<void>
        openPrivacyPolicy: () => Promise<void>
        isMAS: boolean
        isStoreBuild: boolean
        onLocaleChanged: (callback: (locale: string) => void) => () => void
        onUpdateDownloaded: (callback: (version: string) => void) => () => void
        onSnapChanged: (callback: (enabled: boolean) => void) => () => void
      }
      prefs: {
        get: (
          key: 'locale' | 'autoUpdate' | 'snapToGuides'
        ) => Promise<string | boolean | null>
        set: (
          key: 'locale' | 'autoUpdate' | 'snapToGuides',
          value: string | boolean
        ) => Promise<void>
      }
      lifecycle: {
        signalCloseReady: () => void
        onCloseRequested: (callback: (requestId: number) => void) => () => void
        respondToCloseRequest: (requestId: number, decision: 'proceed' | 'cancel') => void
      }
    }
  }
}
