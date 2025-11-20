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

import type { Slide } from './db'

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
 * Re-export Slide type for convenience.
 * A slide contains an ID and an array of DeckElements.
 */
export type { Slide } from './db'

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
 * - currentFilePath !== null: Saved presentation (slides loaded from DB on-demand)
 * - currentFilePath === null: Unsaved presentation (all slides in inMemorySlides)
 */
export const appState = $state({
  /** IDs of all slides in the presentation, in display order */
  slideIds: [] as string[],

  /** Currently displayed slide with all its elements */
  currentSlide: null as Slide | null,

  /** All slides for unsaved presentations (when currentFilePath is null) */
  inMemorySlides: [] as Slide[],

  /** Index of the current slide in slideIds array */
  currentSlideIndex: -1,

  /** Absolute path to the .db file, or null for unsaved presentations */
  currentFilePath: null as string | null,

  /** ID of the currently selected object on the canvas, or null */
  selectedObjectId: null as string | null,

  /** Whether there are unsaved changes to the current slide */
  isDirty: false,

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
  appState.inMemorySlides = []
  appState.currentSlideIndex = -1
  appState.currentFilePath = null
  appState.selectedObjectId = null
  appState.isDirty = false
}

/**
 * Loads a presentation from a database file.
 *
 * This function:
 * 1. Reads all slide IDs from the file
 * 2. Sets currentFilePath to enable file-based persistence mode
 * 3. Loads the first slide (or creates one if the file is empty)
 *
 * @param filePath - Absolute path to the .db file to load
 */
export async function loadPresentation(filePath: string): Promise<void> {
  const ids = await window.api.db.getSlideIds(filePath)

  // Switch to file-based mode
  appState.currentFilePath = filePath
  appState.inMemorySlides = [] // Clear in-memory slides when loading from a file
  appState.slideIds = ids
  appState.isDirty = false
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
 * The slide is loaded from either:
 * - The database (if currentFilePath is set)
 * - The inMemorySlides array (if currentFilePath is null)
 *
 * Important: For unsaved presentations, this saves the current slide back to inMemorySlides
 * before switching to ensure no changes are lost.
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
    // For unsaved presentations, save current slide back to inMemorySlides before switching
    if (!appState.currentFilePath && appState.currentSlide) {
      const currentIndex = appState.inMemorySlides.findIndex(
        (s) => s.id === appState.currentSlide!.id
      )
      if (currentIndex !== -1) {
        appState.inMemorySlides[currentIndex] = appState.currentSlide
      } else {
        console.warn(`Current slide ${appState.currentSlide.id} not found in inMemorySlides, adding it`)
        appState.inMemorySlides.push(appState.currentSlide)
      }
    }

    // Load the new slide
    let newSlide: Slide | null = null

    if (appState.currentFilePath) {
      // File-based mode: load from database
      newSlide = await window.api.db.getSlide(appState.currentFilePath, slideId)
      if (!newSlide) {
        console.error(`Failed to load slide ${slideId} from database`)
        return
      }
    } else {
      // In-memory mode: load from memory
      newSlide = appState.inMemorySlides.find((s) => s.id === slideId) || null
      if (!newSlide) {
        console.error(`Failed to find slide ${slideId} in memory`)
        return
      }
    }

    // Only update state if we successfully loaded the slide
    appState.currentSlide = newSlide
    appState.currentSlideIndex = slideIndex
  } finally {
    loadingState.isLoadingSlide = false
  }
}
