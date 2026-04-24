/**
 * Global application state management for twig.
 *
 * This file uses Svelte 5's $state rune to create reactive state that
 * automatically triggers re-renders when modified.
 *
 * Key concepts:
 * - Dual-mode persistence: Presentations can be saved (file-based) or unsaved (in-memory)
 * - When currentFilePath is set: slides are loaded from database on-demand
 * - When currentFilePath is null: all slides are kept in inMemorySlides array
 */

import { getFlushSave } from './saveCallbacks'
import type { TwigElement, Slide } from './types'
import { get } from 'svelte/store'
import { _ } from 'svelte-i18n'

// Re-export so existing importers (App.svelte, Debug.svelte, etc.) don't need
// to change their import paths.
export type { TwigElement, Slide }

// ============================================================================
// Type Definitions
// ============================================================================

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

  /** Absolute path to the .tb file (can be temp or user-chosen) */
  currentFilePath: null as string | null,

  /** Whether the current file is a temporary file (unsaved presentation) */
  isTempFile: false,

  /** ID of the currently selected object on the canvas, or null */
  selectedObjectId: null as string | null,

  /** Whether the presentation is in presenting mode (fullscreen slideshow) */
  isPresentingMode: false,

  /** Map of slideId → thumbnail data URI (JPEG, loaded from DB on startup) */
  thumbnails: {} as Record<string, string>,

  /** Whether alignment-guide snapping is enabled (mirrors main-owned `snapToGuides` pref) */
  snapEnabled: true,

  /**
   * Whether the current presentation was opened read-only because its format
   * is newer than this build supports. Gates all write paths in the UI; the
   * main process also refuses writes when a file is opened read-only.
   */
  readOnly: false,

  /** Raw compat_notes payload (possibly JSON) from a tooNew file, or '' */
  compatNotesRaw: '',

  /** File format version of a tooNew file, or null when not applicable. */
  fileVersion: null as number | null
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
  appState.thumbnails = {}
  appState.readOnly = false
  appState.compatNotesRaw = ''
  appState.fileVersion = null
}

/**
 * Information about a file that's newer than this build understands.
 * Passed to `onTooNewFile` so the caller (App.svelte) can show a modal.
 */
export interface TooNewFileInfo {
  filePath: string
  fileVersion: number
  compatNotesRaw: string
}

export type TooNewChoice = 'readonly' | 'cancel'

export interface LoadPresentationOptions {
  /**
   * Called when the file is newer than this build supports. Resolves to
   * `'readonly'` to open the file read-only, or `'cancel'` to abort.
   * When omitted, `loadPresentation` aborts on `tooNew`.
   */
  onTooNewFile?: (info: TooNewFileInfo) => Promise<TooNewChoice>
}

/**
 * Loads a presentation from a database file.
 *
 * This function:
 * 1. Reads all slide IDs from the file
 * 2. Sets currentFilePath and checks if it's a temp file
 * 3. Loads the first slide (or creates one if the file is empty)
 *
 * @param filePath - Absolute path to the .tb file to load
 */
export async function loadPresentation(
  filePath: string,
  options: LoadPresentationOptions = {}
): Promise<void> {
  // Probe first so we can branch without mutating anything on disk. The probe
  // opens a short-lived read-only connection and closes it.
  const probe = await window.api.db.probeFormat(filePath)

  if (probe.status === 'notTwig') {
    alert(get(_)('open.not_twig'))
    throw new Error('not a twig file')
  }

  let readOnly = false
  if (probe.status === 'tooNew') {
    const info: TooNewFileInfo = {
      filePath,
      fileVersion: probe.fileVersion ?? 0,
      compatNotesRaw: probe.compatNotes ?? ''
    }
    const choice = options.onTooNewFile ? await options.onTooNewFile(info) : 'cancel'
    if (choice === 'cancel') {
      throw new Error('user cancelled tooNew open')
    }
    readOnly = true
  }

  const ids = await window.api.db.openForEdit(filePath, { readOnly })

  // Clear current slide BEFORE changing currentFilePath to prevent
  // flushPendingSave() in loadSlide() from saving old slide into new database
  appState.currentSlide = null
  appState.currentSlideIndex = -1

  // Set file path and check if it's temporary
  appState.currentFilePath = filePath
  appState.isTempFile = readOnly ? false : await window.api.db.isTempFile(filePath)
  appState.slideIds = ids
  appState.selectedObjectId = null
  appState.thumbnails = await window.api.db.getThumbnails(filePath)
  appState.readOnly = readOnly
  appState.compatNotesRaw = readOnly ? probe.compatNotes ?? '' : ''
  appState.fileVersion = readOnly ? probe.fileVersion ?? null : null

  // Load the first slide, or create one if the file is empty
  if (ids.length > 0) {
    await loadSlide(ids[0])
  } else if (!readOnly) {
    // Empty file - create the first slide with error handling
    try {
      const newSlide = await window.api.db.createSlide(filePath)
      appState.slideIds = [newSlide.id]
      appState.currentSlide = newSlide
      appState.currentSlideIndex = 0
    } catch (error) {
      console.error('Failed to create initial slide for empty presentation:', error)
      alert(get(_)('state.init_error'))
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
    const flushSave = getFlushSave()
    if (flushSave) {
      let flushAttempts = 0
      const maxFlushAttempts = 3

      while (flushAttempts < maxFlushAttempts) {
        try {
          await flushSave()
          break // Success!
        } catch (error) {
          flushAttempts++
          console.error(
            `Failed to flush pending save before navigation (attempt ${flushAttempts}/${maxFlushAttempts}):`,
            error
          )

          if (flushAttempts >= maxFlushAttempts) {
            // All retries failed - ask user what to do
            const errorMessage = error instanceof Error ? error.message : 'Unknown error'
            const userChoice = confirm(
              get(_)('state.save_error_confirm', { values: { error: errorMessage } })
            )

            if (!userChoice) {
              // User cancelled - abort navigation
              return
            }
            // User chose to discard changes - continue with navigation
            break
          }

          // Wait a bit before retrying
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
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
