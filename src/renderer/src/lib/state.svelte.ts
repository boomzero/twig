/**
 * Global application state management for Deckhand.
 *
 * This file uses Svelte 5's $state rune to create reactive state that
 * automatically triggers re-renders when modified.
 *
 * Key concepts:
 * - Dual-mode persistence: Presentations can be saved (file-based) or unsaved (in-memory)
 * - When currentFilePath is set: slides are loaded from database on-demand
 * - When currentFilePath is null: all slides are kept in inMemorySlides array
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a single element (shape, text, or image) on a slide.
 * This is a renderer-side copy of the DeckElement type from the main process.
 */
export interface DeckElement {
  /** Type of element - rectangle shape, text, or image */
  type: 'rect' | 'text' | 'image'

  /** Unique identifier for this element */
  id: string

  /** X coordinate (center point) */
  x: number

  /** Y coordinate (center point) */
  y: number

  /** Width in pixels */
  width: number

  /** Height in pixels */
  height: number

  /** Rotation angle in degrees */
  angle: number

  /** Fill color (hex or rgba string) */
  fill?: string

  /** Text content (only for text elements) */
  text?: string

  /** Font size in pixels (only for text elements) */
  fontSize?: number

  /** Font family name (only for text elements) */
  fontFamily?: string

  /** Rich text styles from fabric.js (only for text elements) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles?: Record<string, any>

  /** Image data as base64 data URI (only for image elements) */
  src?: string

  /** Original image filename (only for image elements) */
  filename?: string
}

/**
 * Represents a single slide containing multiple elements.
 */
export interface Slide {
  /** Unique identifier for this slide */
  id: string

  /** Array of elements (shapes, text, images) on this slide */
  elements: DeckElement[]
}

/**
 * Tracks which objects are selected on the canvas and their text selection ranges.
 * Used to restore selection state after canvas re-renders.
 */
export interface SelectionState {
  /** IDs of selected objects on the canvas */
  selectedObjectIds: string[]

  /** Start position of text cursor/selection (for text elements) */
  selectionStart?: number

  /** End position of text cursor/selection (for text elements) */
  selectionEnd?: number
}

// ============================================================================
// Global Application State
// ============================================================================

/**
 * Reactive application state using Svelte 5's $state rune.
 *
 * This state is automatically tracked by Svelte and triggers re-renders
 * when any property changes. It serves as the single source of truth for
 * the entire application.
 *
 * Persistence model:
 * - All presentations are backed by a SQLite database
 * - isTempFile = true: Unsaved presentation (temp DB that will be moved on Save)
 * - isTempFile = false: Saved presentation (user-chosen location)
 */
export const appState = $state({
  /** IDs of all slides in the presentation, in display order */
  slideIds: [] as string[],

  /** Currently displayed slide with all its elements */
  currentSlide: null as Slide | null,

  /** Index of the current slide in slideIds array */
  currentSlideIndex: -1,

  /** Absolute path to the .db file (can be temp or user-chosen) */
  currentFilePath: null as string | null,

  /** Whether the current file is a temporary file (unsaved presentation) */
  isTempFile: false,

  /** ID of the currently selected object on the canvas, or null */
  selectedObjectId: null as string | null,

  /** Whether the presentation is in presenting mode (fullscreen slideshow) */
  isPresentingMode: false
})

/**
 * Lock flag to prevent concurrent loadSlide operations.
 * This prevents race conditions when users rapidly switch between slides.
 */
export const loadingState = $state({
  isLoadingSlide: false
})

// ============================================================================
// State Management Functions
// ============================================================================

/**
 * Resets all application state to initial values.
 * Called when creating a new presentation.
 */
export function resetState(): void {
  appState.slideIds = []
  appState.currentSlide = null
  appState.currentSlideIndex = -1
  appState.currentFilePath = null
  appState.isTempFile = false
  appState.selectedObjectId = null
}

/**
 * Loads a presentation from a database file.
 *
 * This function:
 * 1. Reads all slide IDs from the file
 * 2. Sets currentFilePath and checks if it's a temp file
 * 3. Loads the first slide (or creates one if the file is empty)
 *
 * @param filePath - Absolute path to the .db file to load
 */
export async function loadPresentation(filePath: string): Promise<void> {
  const ids = await window.api.db.getSlideIds(filePath)

  // Set file path and check if it's temporary
  appState.currentFilePath = filePath
  appState.isTempFile = await window.api.db.isTempFile(filePath)
  appState.slideIds = ids
  appState.selectedObjectId = null

  // Load the first slide, or create one if the file is empty
  if (ids.length > 0) {
    await loadSlide(ids[0])
  } else {
    // Empty file - create the first slide with error handling
    try {
      const newSlide = await window.api.db.createSlide(filePath)
      appState.slideIds = [newSlide.id]
      appState.currentSlide = newSlide
      appState.currentSlideIndex = 0
    } catch (error) {
      console.error('Failed to create initial slide for empty presentation:', error)
      alert(
        'Failed to initialize the presentation file. The file may be corrupted or you may not have write permissions.'
      )
      // Reset state to prevent inconsistent state
      resetState()
      throw error
    }
  }
}

/**
 * Loads a specific slide and makes it the current slide.
 *
 * The slide is always loaded from the database (which may be a temp file for unsaved presentations).
 *
 * Important: Before switching slides, this function auto-saves the current slide to the database
 * to prevent data loss.
 *
 * @param slideId - The ID of the slide to load
 */
export async function loadSlide(slideId: string): Promise<void> {
  // Prevent concurrent loadSlide operations
  if (loadingState.isLoadingSlide) {
    console.warn('loadSlide already in progress, ignoring concurrent call')
    return
  }

  const slideIndex = appState.slideIds.indexOf(slideId)
  if (slideIndex === -1) {
    console.error(`Slide ${slideId} not found in slideIds`)
    return
  }

  loadingState.isLoadingSlide = true
  try {
    // Flush any pending auto-save to prevent duplicate saves
    // This cancels the debounced save and saves immediately if needed
    const flushSave = (window as any).__DECKHAND_FLUSH_SAVE__
    if (typeof flushSave === 'function') {
      try {
        await flushSave()
      } catch (error) {
        console.error('Failed to flush pending save before navigation:', error)
        // Continue with navigation despite save failure
      }
    }

    // Load the new slide from database
    if (!appState.currentFilePath) {
      console.error('Cannot load slide: no current file path')
      return
    }

    const newSlide = await window.api.db.getSlide(appState.currentFilePath, slideId)
    if (!newSlide) {
      console.error(`Failed to load slide ${slideId} from database`)
      return
    }

    // Update state
    appState.currentSlide = newSlide
    appState.currentSlideIndex = slideIndex
  } finally {
    loadingState.isLoadingSlide = false
  }
}
