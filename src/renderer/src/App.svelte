<!--
  Main Application Component - App.svelte

  This is the main UI component for twig. It manages:
  - The fabric.js canvas for rendering and editing slides
  - Bi-directional sync between application state and canvas objects
  - Rich text editing capabilities
  - File operations (new, open, save, save as)
  - Keyboard shortcuts and context menus

  Key Architecture Patterns:
  1. State is the source of truth - canvas reflects state
  2. When state changes → canvas re-renders (via $effect)
  3. When canvas objects are modified → state is updated
  4. Selection state is preserved across re-renders when possible

  fabric.js Customization:
  - Objects use center origin (fabric.js v7 default)
  - Objects are extended with an 'id' property to link them to state
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { v4 as uuid_v4 } from 'uuid'
  import { appState, loadPresentation, loadSlide, loadingState } from './lib/state.svelte'
  import { registerFlushSave, unregisterFlushSave } from './lib/saveCallbacks'
  import type { DeckElement, SelectionState } from './lib/state.svelte'
  import {
    Canvas,
    type FabricObject,
    IText,
    Rect,
    FabricImage,
    ActiveSelection,
    util,
    cache
  } from 'fabric'
  import PropertiesPanel from './components/PropertiesPanel.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import PresentationView from './components/PresentationView.svelte'
  import StackPanel from './components/StackPanel.svelte'
  import { PressedKeys } from 'runed'

  // ============================================================================
  // Component State
  // ============================================================================

  // Canvas element reference (bound to the <canvas> element in the template)
  let canvasEl: HTMLCanvasElement

  // fabric.js Canvas instance (initialized in $effect)
  let fabCanvas: Canvas | undefined

  // Currently active text object (for rich text editing)
  let activeTextObject: IText | null = null
  let lastTextSelectionRange: { start: number; end: number } | null = null
  let suppressSelectionTracking = false

  // Layers panel visibility and width
  let showStackPanel = $state(false)
  let stackPanelWidth = $state(240)

  function startStackPanelResize(e: MouseEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = stackPanelWidth

    function onMove(ev: MouseEvent): void {
      // Drag handle is on the LEFT edge — dragging left increases width
      const delta = startX - ev.clientX
      stackPanelWidth = Math.max(120, Math.min(600, startWidth + delta))
    }

    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Rich text editor state
  let showRichTextControls = $state(false)
  let isSelectionBold = $state(false)
  let isSelectionItalic = $state(false)
  let isSelectionUnderlined = $state(false)
  let selectionFontSize = $state(40)
  let selectionFontFamily = $state('Arial')
  let selectionFillColor = $state('#333333')
  let selectionRangeToRestore: { start: number; end: number } | null = null
  let wasEditing = false

  // Font management state
  let systemFonts: { family: string; path: string; format: string }[] = []
  let availableFonts = $state(['Arial', 'Helvetica', 'Times New Roman', 'Courier New']) // Default fallbacks
  let loadedFonts = new Set<string>() // Track which fonts have been loaded via @font-face

  // Custom font dropdown state
  let fontDropdownOpen = $state(false)
  let fontDropdownRef: HTMLDivElement | null = null
  let fontSearchQuery = $state('')
  let fontLoadingQueue: Set<string> = new Set()
  let isLoadingFonts = false

  // Keyboard shortcut handler
  const keys = new PressedKeys()

  // Context menu state
  let contextMenuVisible = $state(false)
  let contextMenuPosition = $state({ x: 0, y: 0 })

  // Boundary flags for disabling layer buttons when already at front/back.
  // When there are no elements, selectedIsAtFront/Back both default to false
  // (no element is selected, so neither boundary applies).
  const selectedElementZIndex = $derived(
    appState.currentSlide?.elements.find((e) => e.id === appState.selectedObjectId)?.zIndex ?? null
  )
  const canvasMaxZ = $derived(
    appState.currentSlide?.elements.length
      ? appState.currentSlide.elements.reduce((m, e) => Math.max(m, e.zIndex), -Infinity)
      : null
  )
  const canvasMinZ = $derived(
    appState.currentSlide?.elements.length
      ? appState.currentSlide.elements.reduce((m, e) => Math.min(m, e.zIndex), Infinity)
      : null
  )
  const selectedIsAtFront = $derived(
    selectedElementZIndex !== null && canvasMaxZ !== null && selectedElementZIndex >= canvasMaxZ
  )
  const selectedIsAtBack = $derived(
    selectedElementZIndex !== null && canvasMinZ !== null && selectedElementZIndex <= canvasMinZ
  )

  // Generation counter incremented on each renderCanvasFromState() call.
  // Async image load callbacks capture their generation and bail out if a newer
  // render has started (e.g. the user navigated to another slide), preventing
  // stale images from landing on the wrong canvas and causing duplicates.
  let renderGeneration = 0

  // Cache of decoded image elements keyed by src (base64 data URI).
  // Allows synchronous FabricImage construction on re-renders, preventing flicker.
  const imageElementCache = new Map<string, HTMLImageElement>()

  /**
   * Auto-save debounce delay in milliseconds.
   * 300ms is fast enough to feel instant while batching rapid changes
   * (e.g., dragging objects, typing in text boxes).
   */
  const AUTO_SAVE_DEBOUNCE_MS = 300

  /**
   * Delay between retry attempts when creating a new presentation fails.
   */
  const NEW_PRESENTATION_RETRY_DELAY_MS = 500

  // Promise-based lock to prevent concurrent saves
  let savePromise: Promise<void> | null = null

  // Debounced auto-save
  let saveTimeoutId: ReturnType<typeof setTimeout> | null = null

  // Auto-save status indicator
  // 'idle'   — data is persisted, no recent activity (shows relative timestamp)
  // 'pending' — unsaved changes exist, debounced save queued
  // 'saving'  — save in flight
  // 'saved'   — just saved (green flash for 2s, then transitions to 'idle')
  // 'error'   — last save failed
  type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  let saveStatus = $state<SaveStatus>('idle')
  let savedResetTimeoutId: ReturnType<typeof setTimeout> | null = null

  // Timestamp of the last successful save, used to render "Saved Xs ago" in idle state.
  // Starts as null (no save has occurred yet). The toolbar is only rendered when
  // appState.currentSlide is set, which happens after handleNewPresentation/handleOpen
  // complete — both call setSaveStatus('saved'), so lastSavedAt is set before the
  // idle indicator ever appears.
  let lastSavedAt: number | null = null

  // Reactive clock for updating the relative timestamp in idle state.
  // Only ticks once a save has occurred (interval started lazily in setSaveStatus).
  let now = $state(Date.now())
  let nowTickId: ReturnType<typeof setInterval> | null = null

  function setSaveStatus(status: SaveStatus): void {
    saveStatus = status
    if (savedResetTimeoutId) {
      clearTimeout(savedResetTimeoutId)
      savedResetTimeoutId = null
    }
    if (status === 'saved') {
      lastSavedAt = Date.now()
      // Stop the tick during the 2s green-flash; it will restart on idle entry
      if (nowTickId) { clearInterval(nowTickId); nowTickId = null }
      savedResetTimeoutId = setTimeout(() => {
        savedResetTimeoutId = null
        setSaveStatus('idle')
      }, 2000)
    } else if (status === 'idle') {
      // Sync 'now' immediately so the relative timestamp is accurate on entry,
      // then tick every 10s to keep it fresh.
      now = Date.now()
      if (!nowTickId) {
        nowTickId = setInterval(() => { now = Date.now() }, 10_000)
      }
    } else {
      // pending / saving / error — relative timestamp not shown, stop the ticker
      if (nowTickId) { clearInterval(nowTickId); nowTickId = null }
    }
  }

  function formatRelativeTime(ts: number): string {
    const secs = Math.floor((now - ts) / 1000)
    if (secs < 10) return 'just now'
    if (secs < 60) return `${secs}s ago`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    return `${Math.floor(mins / 60)}h ago`
  }

  /**
   * Performs the actual save operation with promise-based locking.
   * This is the single source of truth for all save operations.
   *
   * @param rethrowErrors - If true, errors are re-thrown to the caller. If false, errors are logged only.
   */
  async function performSave(rethrowErrors: boolean = false): Promise<void> {
    // Wait for any in-flight save to complete
    while (savePromise) {
      await savePromise
    }

    // Snapshot state before any async operation to prevent race conditions
    // (currentFilePath could change while we're awaiting savePromise)
    const filePath = appState.currentFilePath
    const slide = appState.currentSlide

    // Check if we have valid state to save.
    // Don't change saveStatus here — if status is 'pending', the changes are still
    // unwritten; leaving it as-is avoids a false 'idle' flash. The transition
    // handlers (handleNewPresentation, handleOpen) call setSaveStatus('saved') once
    // valid state is established, which normalises the indicator.
    if (!slide || !filePath) {
      return
    }

    // Start new save operation with promise lock
    setSaveStatus('saving')
    savePromise = (async () => {
      try {
        const plainSlide = JSON.parse(JSON.stringify(slide))
        await window.api.db.saveSlide(filePath, plainSlide)
        setSaveStatus('saved')
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('Save operation failed:', errorMessage)
        setSaveStatus('error')
        if (rethrowErrors) {
          throw error
        }
      }
    })()

    try {
      await savePromise
    } finally {
      savePromise = null
      // Safety net: if status is still 'saving' here, something bypassed both
      // setSaveStatus('saved') and setSaveStatus('error') — reset to avoid a
      // permanently stuck indicator.
      if (saveStatus === 'saving') {
        setSaveStatus('error')
      }
    }
  }

  function scheduleSave(): void {
    // Always mark as pending — a queued debounced save IS pending, even if
    // a save is currently in-flight. This prevents a false "Saved" indicator
    // during the window between an in-flight save completing and the next
    // debounced save starting.
    setSaveStatus('pending')
    if (saveTimeoutId) clearTimeout(saveTimeoutId)
    saveTimeoutId = setTimeout(async () => {
      saveTimeoutId = null
      await performSave(false) // Log errors but don't throw
    }, AUTO_SAVE_DEBOUNCE_MS)
  }

  /**
   * Flushes any pending auto-save immediately.
   * Called before critical operations like navigation, closing, or presenting.
   */
  async function flushPendingSave(): Promise<void> {
    // Cancel pending debounced save
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId)
      saveTimeoutId = null
    }

    // If a text object is actively being edited, sync its current content to
    // state before saving (normally this only happens on deselection via object:modified)
    if (activeTextObject?.id) {
      updateStateFromObject(activeTextObject as DeckFabricObject)
    }

    await performSave(true) // Re-throw errors for caller to handle
  }

  /**
   * Extended fabric.js object type that includes our custom 'id' property.
   * The id links canvas objects back to their corresponding state elements.
   */
  type DeckFabricObject = FabricObject & { id?: string }

  // ============================================================================
  // Lifecycle and Reactive Effects
  // ============================================================================

  /**
   * Initialize the app on mount by creating a new presentation.
   */
  let unsubscribeBeforeClose: (() => void) | undefined
  let unsubscribeStateRequest: (() => void) | undefined

  onMount(async () => {
    await loadSystemFonts()
    await handleNewPresentation()

    // Expose state and utility functions to window for console debugging
    if (typeof window !== 'undefined') {
      ;(window as any).__TWIG_STATE__ = {
        appState,
        loadingState
      }
      registerFlushSave(flushPendingSave)
    }

    // Listen for state requests from the debug window
    unsubscribeStateRequest = window.api?.debug?.onStateRequest(() => {
      sendStateToDebugWindow()
    })

    // Listen for window close event - flush pending saves before closing
    unsubscribeBeforeClose = window.api?.lifecycle?.onBeforeClose(async () => {
      await flushPendingSave()
      window.api?.lifecycle?.flushComplete()
    })
  })

  /**
   * Clean up pending auto-save timeout and event listeners on component unmount.
   * Prevents memory leaks from dangling timeouts and IPC listeners.
   */
  onDestroy(() => {
    // Clear pending auto-save timeout
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId)
      saveTimeoutId = null
    }
    if (savedResetTimeoutId) {
      clearTimeout(savedResetTimeoutId)
      savedResetTimeoutId = null
    }
    if (nowTickId) {
      clearInterval(nowTickId)
      nowTickId = null
    }

    // Unsubscribe from IPC event listeners
    unsubscribeBeforeClose?.()
    unsubscribeStateRequest?.()

    // Unregister flush save callback
    unregisterFlushSave()
  })

  /**
   * Reactive effect that broadcasts state changes to the debug window.
   * Runs whenever any tracked state changes.
   */
  $effect(() => {
    // Track all relevant state
    const _ = [
      appState.currentFilePath,
      appState.slideIds,
      appState.currentSlideIndex,
      appState.currentSlide,
      appState.selectedObjectId,
      appState.isPresentingMode,
      loadingState.isLoadingSlide
    ]

    // Send state update to debug window (if open)
    sendStateToDebugWindow()
  })

  /**
   * Sends the current application state to the debug window.
   */
  function sendStateToDebugWindow(): void {
    const stateSnapshot = {
      currentFilePath: appState.currentFilePath,
      slideIds: [...appState.slideIds],
      currentSlideIndex: appState.currentSlideIndex,
      currentSlideId: appState.currentSlide?.id || null,
      currentSlideElementCount: appState.currentSlide?.elements.length || 0,
      selectedObjectId: appState.selectedObjectId,
      isPresentingMode: appState.isPresentingMode,
      isTempFile: appState.isTempFile,
      isLoadingSlide: loadingState.isLoadingSlide,
      currentSlide: appState.currentSlide ? JSON.parse(JSON.stringify(appState.currentSlide)) : null
    }

    window.api?.debug?.sendStateUpdate(stateSnapshot)
  }

  /**
   * Opens the debug window.
   */
  function openDebugWindow(): void {
    window.api?.debug?.openWindow()
  }

  /**
   * Reactive effect that auto-saves the current slide when it changes.
   * Tracks the last loaded slide ID to avoid saving when switching slides.
   */
  let lastLoadedSlideId: string | null = null
  $effect(() => {
    if (appState.currentSlide) {
      if (lastLoadedSlideId === appState.currentSlide.id) {
        // Same slide updated — schedule auto-save
        scheduleSave()
      } else {
        // Different slide loaded — just track it
        lastLoadedSlideId = appState.currentSlide.id
      }
    }
  })

  /**
   * Reactive effect that loads embedded fonts when a presentation file is opened.
   */
  $effect(() => {
    if (appState.currentFilePath) {
      loadEmbeddedFonts()
    }
  })

  /**
   * Main rendering effect - runs whenever the current slide changes.
   *
   * This effect:
   * 1. Captures current selection state (to restore after re-render)
   * 2. Creates the fabric.js canvas if needed
   * 3. Re-renders all canvas objects from state
   * 4. Restores the previous selection state
   *
   * This ensures the canvas always reflects the current state while preserving
   * user selections across state updates.
   */
  $effect(() => {
    // Skip canvas operations during presentation mode - the edit canvas is not rendered
    if (appState.isPresentingMode) {
      return
    }

    if (!appState.currentSlide) {
      // Dispose the canvas instance when there's no slide
      // This ensures a fresh canvas is created when a new slide loads
      // (The UI is destroyed when currentSlide is null, so we need to dispose the old canvas)
      if (fabCanvas) {
        fabCanvas.dispose()
        fabCanvas = undefined
      }
      return
    }

    // canvasEl binding might not be ready yet after exiting presentation mode
    // Use requestAnimationFrame to defer to the next frame when DOM is ready
    if (!canvasEl) {
      requestAnimationFrame(() => {
        if (canvasEl && appState.currentSlide && !appState.isPresentingMode) {
          if (!fabCanvas) {
            fabCanvas = new Canvas(canvasEl)
          }
          renderCanvasFromState().catch((err) => console.error('Canvas render failed:', err))
        }
      })
      return
    }

    // Step 1: Capture current selection state before re-rendering
    let selectionStateToRestore: SelectionState | null = null
    if (fabCanvas) {
      const activeObject = fabCanvas.getActiveObject()
      if (activeObject) {
        // Handle both single selection and multi-selection
        const selectedObjectIds =
          activeObject.type === 'activeselection'
            ? (activeObject as ActiveSelection).getObjects().map((o) => (o as DeckFabricObject).id!)
            : [(activeObject as DeckFabricObject).id!]

        selectionStateToRestore = {
          selectedObjectIds: selectedObjectIds
        }

        // For text objects, also save cursor/selection position
        if (activeObject instanceof IText) {
          selectionRangeToRestore = {
            start: activeObject.selectionStart!,
            end: activeObject.selectionEnd!
          }
          wasEditing = activeObject.isEditing
        }
      }
    }

    // Step 2: Create canvas if it doesn't exist yet OR if it's not connected to the current canvas element
    // This handles cases where the DOM element was recreated but fabCanvas still exists
    if (!fabCanvas || fabCanvas.getElement() !== canvasEl) {
      if (fabCanvas) {
        fabCanvas.dispose()
      }
      fabCanvas = new Canvas(canvasEl)
    }

    // Step 3: Re-render all objects from state
    renderCanvasFromState().catch((err) => console.error('Canvas render failed:', err))

    // Step 4: Restore previous selection if it existed
    if (selectionStateToRestore && fabCanvas) {
      const objectsToSelect = fabCanvas
        .getObjects()
        .filter((o) =>
          selectionStateToRestore!.selectedObjectIds.includes((o as DeckFabricObject).id!)
        )

      if (objectsToSelect.length > 0) {
        let selection
        if (objectsToSelect.length === 1) {
          selection = objectsToSelect[0]
        } else {
          selection = new ActiveSelection(objectsToSelect, { canvas: fabCanvas })
        }
        fabCanvas.setActiveObject(selection)
        fabCanvas.renderAll()

        // Restore text cursor/selection position if this is a text object
        if (selectionRangeToRestore && selection instanceof IText) {
          const range = { ...selectionRangeToRestore }
          selectionRangeToRestore = null
          setTimeout(() => {
            if (selection && selection instanceof IText) {
              selection.setSelectionStart(range.start)
              selection.setSelectionEnd(range.end)
              fabCanvas?.requestRenderAll()
              handleTextSelectionChange()
            }
          }, 10)
        }
      }
    }

  })

  /**
   * Effect to handle click outside for closing font dropdown
   */
  $effect(() => {
    if (typeof window !== 'undefined') {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  })

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Removes unwanted "transparent" values from fabric.js character styles.
   * fabric.js sometimes adds transparent values for fill, stroke, and textBackgroundColor
   * which we don't want to persist in the state.
   */
  function cleanStylesObject(styles: Record<string, any>): Record<string, any> {
    const cleaned: Record<string, any> = {}

    Object.keys(styles).forEach((lineIndex) => {
      const lineStyles = styles[lineIndex]
      if (!lineStyles || typeof lineStyles !== 'object') return

      cleaned[lineIndex] = {}

      Object.keys(lineStyles).forEach((charIndex) => {
        const charStyle = lineStyles[charIndex]
        if (!charStyle || typeof charStyle !== 'object') return

        const cleanedCharStyle: Record<string, any> = {}

        Object.keys(charStyle).forEach((key) => {
          const value = charStyle[key]
          // Skip transparent values for these properties
          if (
            (key === 'fill' || key === 'stroke' || key === 'textBackgroundColor') &&
            value === 'transparent'
          ) {
            return
          }
          cleanedCharStyle[key] = value
        })

        // Only keep character style if it has properties
        if (Object.keys(cleanedCharStyle).length > 0) {
          cleaned[lineIndex][charIndex] = cleanedCharStyle
        }
      })

      // Only keep line if it has character styles
      if (Object.keys(cleaned[lineIndex]).length === 0) {
        delete cleaned[lineIndex]
      }
    })

    return cleaned
  }

  /**
   * Escapes a font family name for use in CSS.
   * Handles special characters like quotes and backslashes.
   */
  function escapeCssFontFamily(fontFamily: string): string {
    // If the font name contains spaces or special characters, wrap in quotes
    // and escape any existing quotes or backslashes
    if (/["\\\s,]/.test(fontFamily)) {
      return `"${fontFamily.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return fontFamily
  }

  // ============================================================================
  // fabric.js Configuration and Canvas Rendering
  // ============================================================================

  /**
   * Renders the current slide's elements onto the fabric.js canvas.
   *
   * This function:
   * 1. Removes old event listeners
   * 2. Clears the canvas
   * 3. Creates fabric.js objects for each element in state
   * 4. Adds event listeners for object modifications
   *
   * Called whenever the current slide changes (via $effect).
   */
  function renderCanvasFromState(): Promise<void> {
    if (!fabCanvas || !appState.currentSlide) {
      return Promise.resolve()
    }

    // Stamp this render so async callbacks can detect staleness
    const generation = ++renderGeneration

    const currentSlide = appState.currentSlide

    // Null out the stale text object reference before clearing the canvas.
    // When selection is restored after re-render, handleSelection fires and would call
    // updateStateFromObject(activeTextObject) on the now-destroyed old fabric object.
    // That state mutation re-triggers this $effect, causing an infinite reactive loop.
    // Nulling here breaks the cycle: handleSelection's guard `if (activeTextObject)` is false.
    activeTextObject = null

    // Remove old event listeners to prevent duplicate handlers
    fabCanvas.off('object:modified', handleObjectModified)
    fabCanvas.off('text:changed', handleTextChanged)
    fabCanvas.off('selection:created', handleSelection)
    fabCanvas.off('selection:updated', handleSelection)
    fabCanvas.off('selection:cleared', handleSelectionCleared)
    fabCanvas.off('contextmenu', handleContextMenu)

    // Clear the canvas and re-create all objects from state
    fabCanvas.clear()

    // Sort elements by zIndex (ascending = back-to-front).
    // getSlide() already returns elements ORDER BY z_index ASC, so in normal
    // flow this is a no-op. The defensive sort guards against in-memory
    // reorder mutations (e.g. compactZIndexes) that occur between load and render.
    const sortedElements = [...currentSlide.elements].sort((a, b) => a.zIndex - b.zIndex)

    // Build a lookup of element id → zIndex for use by async image insertions
    const zIndexById = new Map(sortedElements.map((el) => [el.id, el.zIndex]))

    // Add non-image elements synchronously in z-order
    sortedElements.forEach((element) => {
      if (element.type === 'image') return

      let fabObj: FabricObject | undefined
      if (element.type === 'rect') {
        fabObj = new Rect({
          left: element.x,
          top: element.y,
          width: element.width,
          height: element.height,
          angle: element.angle,
          fill: element.fill,
          id: element.id
        })
      } else if (element.type === 'text') {
        const cleanedStyles = element.styles ? cleanStylesObject(element.styles) : {}
        fabObj = new IText(element.text || 'Hello', {
          left: element.x,
          top: element.y,
          angle: element.angle,
          id: element.id,
          fill: element.fill,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          styles: cleanedStyles
        })
      }
      if (fabObj) fabCanvas.add(fabObj)
    })

    // Add image elements asynchronously, inserting at the correct z-position.
    // When each image resolves, we count how many currently-present canvas objects
    // have a lower zIndex (via ID lookup) to find the right insertAt index.
    // insertAt gives correct intermediate rendering as each image arrives.
    // A Promise.allSettled correction pass below fixes any ordering errors that
    // occur when two images resolve in the same microtask and see identical state.
    const imageLoads: Promise<void>[] = []

    const applyImageElement = (
      htmlImg: HTMLImageElement,
      element: DeckElement,
      imageZIndex: number
    ) => {
      if (!fabCanvas || renderGeneration !== generation) return
      const img = new FabricImage(htmlImg)
      const scaleX = element.width / (img.width || 1)
      const scaleY = element.height / (img.height || 1)
      img.set({
        left: element.x,
        top: element.y,
        angle: element.angle,
        scaleX,
        scaleY,
        id: element.id
      })
      const insertIndex = (fabCanvas.getObjects() as DeckFabricObject[]).filter(
        (obj) => (obj.id ? (zIndexById.get(obj.id) ?? 0) : 0) < imageZIndex
      ).length
      fabCanvas.insertAt(insertIndex, img)
    }

    sortedElements.forEach((element) => {
      if (element.type !== 'image' || !element.src) return
      const imageZIndex = element.zIndex
      const cached = imageElementCache.get(element.src)

      if (cached) {
        // Synchronous path — cached element, no flicker
        applyImageElement(cached, element, imageZIndex)
      } else {
        // Async path — first load only
        const load = FabricImage.fromURL(element.src, { crossOrigin: 'anonymous' })
          .then((img) => {
            // Cache the underlying HTMLImageElement for future renders
            const el = img.getElement()
            if (el instanceof HTMLImageElement) {
              imageElementCache.set(element.src!, el)
            }
            if (!fabCanvas || renderGeneration !== generation) return
            const scaleX = element.width / (img.width || 1)
            const scaleY = element.height / (img.height || 1)
            img.set({
              left: element.x,
              top: element.y,
              angle: element.angle,
              scaleX,
              scaleY,
              id: element.id
            })

            // Count objects already on the canvas whose zIndex is lower than ours
            const insertIndex = (fabCanvas.getObjects() as DeckFabricObject[]).filter(
              (obj) => (obj.id ? (zIndexById.get(obj.id) ?? 0) : 0) < imageZIndex
            ).length

            fabCanvas.insertAt(insertIndex, img)
            fabCanvas.renderAll()
          })
          .catch((error) => {
            console.error('Failed to load image:', error)
          })

        imageLoads.push(load)
      }
    })

    fabCanvas.renderAll()

    // Re-attach event listeners
    fabCanvas.on('object:modified', handleObjectModified)
    fabCanvas.on('text:changed', handleTextChanged)
    fabCanvas.on('selection:created', handleSelection)
    fabCanvas.on('selection:updated', handleSelection)
    fabCanvas.on('selection:cleared', handleSelectionCleared)
    fabCanvas.on('contextmenu', handleContextMenu)

    if (imageLoads.length === 0) return Promise.resolve()

    // Once all images have settled, correct any ordering errors that occurred when
    // two images resolved simultaneously and computed the same insertAt index.
    // Uses the public moveTo() API (remove + splice at target index) in ascending
    // z-order so each placement is stable without triggering selection events.
    // The generation guard ensures this is a no-op if the slide changed while loading.
    return Promise.allSettled(imageLoads).then(() => {
      if (!fabCanvas || renderGeneration !== generation) return
      if (imageLoads.length > 1) {
        const sorted = (fabCanvas.getObjects() as DeckFabricObject[])
          .slice()
          .sort((a, b) => (zIndexById.get(a.id ?? '') ?? 0) - (zIndexById.get(b.id ?? '') ?? 0))
        sorted.forEach((obj, targetIndex) => fabCanvas.moveTo(obj, targetIndex))
      }
      fabCanvas.renderAll()
    })
  }

  /**
   * Handles the 'object:modified' event from fabric.js.
   * Syncs changes from the canvas back to the application state.
   */
  function handleObjectModified(event: { target?: DeckFabricObject | ActiveSelection }): void {
    if (!appState.currentSlide) return
    const target = event.target
    if (!target) return

    // Handle both single and multi-selection modifications
    if (target.type === 'activeselection') {
      const selection = target as ActiveSelection
      selection.getObjects().forEach((obj) => {
        updateStateFromObject(obj as DeckFabricObject)
      })
    } else {
      updateStateFromObject(target as DeckFabricObject)
    }

    // Trigger auto-save directly — the $effect doesn't subscribe to deep element
    // property changes, so we must call scheduleSave() explicitly here.
    scheduleSave()
  }

  /**
   * Updates the application state to match a modified canvas object.
   *
   * This is the reverse direction of renderCanvasFromState():
   * Canvas changes → State updates
   *
   * Uses fabric.js's qrDecompose to extract position, rotation, and scale
   * from the object's transform matrix.
   */
  function updateStateFromObject(obj: DeckFabricObject): void {
    if (!obj.id || typeof obj.width !== 'number' || !appState.currentSlide) return

    const elementInState = appState.currentSlide.elements.find((el) => el.id === obj.id)
    if (!elementInState) return

    // Decompose the transform matrix to get position, rotation, and scale
    const transform = util.qrDecompose(obj.calcTransformMatrix())

    // Update state with the new transform values
    elementInState.x = transform.translateX
    elementInState.y = transform.translateY
    elementInState.angle = transform.angle
    elementInState.width = obj.width * transform.scaleX
    elementInState.height = obj.height * transform.scaleY

    // For text objects, also update text content and styling
    if (elementInState.type === 'text' && obj instanceof IText) {
      elementInState.text = obj.text
      elementInState.fontSize = obj.fontSize
      elementInState.fontFamily = obj.fontFamily
      elementInState.fill = obj.fill as string
      // Clean up any unwanted transparent values before saving to state
      elementInState.styles = obj.styles ? cleanStylesObject(obj.styles) : undefined
    }
  }

  // ============================================================================
  // Selection Handling
  // ============================================================================

  /**
   * Handles selection creation and update events from fabric.js.
   * Updates app state and manages rich text editor visibility.
   */
  function handleSelection(event: { selected?: DeckFabricObject[] }): void {
    if (event.selected && event.selected.length === 1) {
      appState.selectedObjectId = event.selected[0].id || null
    } else {
      appState.selectedObjectId = null
    }

    // Sync previous text object state before switching - object:modified doesn't always fire
    if (activeTextObject) {
      updateStateFromObject(activeTextObject as DeckFabricObject)
      // Explicit call: $effect doesn't subscribe to deep element property changes
      scheduleSave()
    }

    // Remove old text selection change listener
    activeTextObject?.off('selection:changed', handleTextSelectionChange)

    const selection = event.selected?.[0]
    if (selection instanceof IText) {
      // Text object selected - enable rich text controls
      activeTextObject = selection
      showRichTextControls = true

      // Update formatting button states based on the selected text object
      handleTextSelectionChange()

      // If user was editing before, restore editing mode
      if (wasEditing) {
        activeTextObject.enterEditing()
        wasEditing = false
      }

      // Listen for text selection changes to update formatting buttons
      activeTextObject.on('selection:changed', handleTextSelectionChange)
      handleTextSelectionChange()
    } else {
      // Non-text object selected - hide rich text controls
      activeTextObject = null
      showRichTextControls = false
      isSelectionBold = false
      isSelectionItalic = false
      isSelectionUnderlined = false
      wasEditing = false
    }
  }

  /**
   * Handles selection cleared event - resets selection state.
   */
  function handleSelectionCleared(): void {
    // Sync state before clearing - object:modified doesn't always fire reliably
    if (activeTextObject) {
      updateStateFromObject(activeTextObject as DeckFabricObject)
      // Explicit call: $effect doesn't subscribe to deep element property changes
      scheduleSave()
    }
    activeTextObject?.off('selection:changed', handleTextSelectionChange)
    appState.selectedObjectId = null
    activeTextObject = null
    showRichTextControls = false
    isSelectionBold = false
    isSelectionItalic = false
    isSelectionUnderlined = false
    selectionFontSize = 40
    selectionFillColor = '#333333'
    wasEditing = false
    lastTextSelectionRange = null
    suppressSelectionTracking = false
  }

  function handleTextChanged(event: { target?: DeckFabricObject }): void {
    const target = event.target
    if (!(target instanceof IText)) return
    // Text changed - no special handling needed
  }

  // ============================================================================
  // Rich Text Formatting
  // ============================================================================

  /**
   * Applies a style to the currently selected text range.
   * If no text is selected, applies the style to the entire text object.
   */
  function applyStyleToSelection(style: Record<string, string | number | boolean>): void {
    if (!activeTextObject) return

    const hasSelection = activeTextObject.selectionStart !== activeTextObject.selectionEnd

    if (hasSelection) {
      // Apply to selected text range
      // Instead of using setSelectionStyles (which can accumulate styles incorrectly),
      // manually manage character-level styles to avoid corruption
      const start = activeTextObject.selectionStart ?? 0
      const end = activeTextObject.selectionEnd ?? 0

      for (let i = start; i < end; i++) {
        const loc = activeTextObject.get2DCursorLocation(i, true)
        const lineIndex = loc.lineIndex
        const charIndex = loc.charIndex

        // Ensure the styles structure exists
        if (!activeTextObject.styles[lineIndex]) {
          activeTextObject.styles[lineIndex] = {}
        }
        if (!activeTextObject.styles[lineIndex][charIndex]) {
          activeTextObject.styles[lineIndex][charIndex] = {}
        }

        // Apply each style property
        Object.keys(style).forEach((key) => {
          const newValue = style[key]
          const baseValue = activeTextObject[key]

          if (newValue === baseValue) {
            // New value matches base - remove character-level override
            delete activeTextObject.styles[lineIndex][charIndex][key]
          } else {
            // New value differs from base - set character-level style
            activeTextObject.styles[lineIndex][charIndex][key] = newValue
          }
        })

        // Clean up empty style objects
        if (Object.keys(activeTextObject.styles[lineIndex][charIndex]).length === 0) {
          delete activeTextObject.styles[lineIndex][charIndex]
        }
        if (Object.keys(activeTextObject.styles[lineIndex]).length === 0) {
          delete activeTextObject.styles[lineIndex]
        }
      }

      activeTextObject.dirty = true
      activeTextObject.initDimensions()

      // Clean up any transparent values that fabric.js might have added during initDimensions
      if (activeTextObject.styles) {
        activeTextObject.styles = cleanStylesObject(activeTextObject.styles)
      }

      handleTextSelectionChange()
    } else {
      // No selection - apply style to the entire text object
      // Just update the base properties - do NOT use setSelectionStyles which creates
      // character-level overrides that accumulate as the user types
      Object.keys(style).forEach((key) => {
        activeTextObject[key] = style[key]
      })

      // Update any character-level overrides with the new values
      // This ensures all characters use the new font/color/etc, even if they have other formatting
      if (activeTextObject.styles) {
        const styleKeys = Object.keys(style)
        Object.keys(activeTextObject.styles).forEach((lineIndex) => {
          const lineNum = parseInt(lineIndex)
          if (!activeTextObject.styles[lineNum]) return
          Object.keys(activeTextObject.styles[lineNum]).forEach((charIndex) => {
            const charNum = parseInt(charIndex)
            const charStyles = activeTextObject.styles[lineNum][charNum]
            if (!charStyles) return

            // Update the properties we're changing at the base level
            // This is important for properties like fontFamily - if a character has
            // { fontFamily: 'Arial', fontWeight: 'bold' } and we change the whole text
            // to 'Helvetica', we want { fontFamily: 'Helvetica', fontWeight: 'bold' }
            styleKeys.forEach((key) => {
              if (charStyles[key] !== undefined) {
                charStyles[key] = style[key]
              }
            })

            // If no styles left, remove the character entry
            if (Object.keys(charStyles).length === 0) {
              delete activeTextObject.styles[lineNum][charNum]
            }
          })
          // If no characters left in line, remove line entry
          if (Object.keys(activeTextObject.styles[lineNum]).length === 0) {
            delete activeTextObject.styles[lineNum]
          }
        })
      }

      // Mark as dirty so fabric.js re-renders
      activeTextObject.dirty = true
      activeTextObject.initDimensions()

      // Clean up any transparent values that fabric.js might have added during initDimensions
      if (activeTextObject.styles) {
        activeTextObject.styles = cleanStylesObject(activeTextObject.styles)
      }

      // Update UI state
      if (style.fontWeight !== undefined) {
        isSelectionBold = style.fontWeight === 'bold'
      }
      if (style.fontStyle !== undefined) {
        isSelectionItalic = style.fontStyle === 'italic'
      }
      if (style.underline !== undefined) {
        isSelectionUnderlined = style.underline === true
      }
      if (style.fontSize !== undefined) {
        selectionFontSize = style.fontSize as number
      }
      if (style.fontFamily !== undefined) {
        selectionFontFamily = style.fontFamily as string
      }

      // Update button states based on actual text state (not just what we applied)
      handleTextSelectionChange()
    }

    fabCanvas?.renderAll()

    // Note: Do NOT update state here - it triggers the $effect which re-renders the canvas
    // and loses the text selection/cursor. State is synced when editing finishes via the
    // object:modified event handler, which calls updateStateFromObject().
  }

  /** Toggles bold formatting on the selected text */
  function toggleBold(): void {
    applyStyleToSelection({ fontWeight: isSelectionBold ? 'normal' : 'bold' })
  }

  /** Toggles italic formatting on the selected text */
  function toggleItalic(): void {
    applyStyleToSelection({ fontStyle: isSelectionItalic ? 'normal' : 'italic' })
  }

  /** Toggles underline formatting on the selected text */
  function toggleUnderline(): void {
    applyStyleToSelection({ underline: !isSelectionUnderlined })
  }

  /** Changes the font size of the selected text */
  function changeFontSize(event: Event): void {
    const size = parseInt((event.target as HTMLInputElement).value)
    if (!isNaN(size) && size > 0 && activeTextObject) {
      applyStyleToSelection({ fontSize: size })
      // Note: Do NOT call updateStateFromObject() here - it would re-render and lose cursor
    }
  }

  /**
   * Updates the formatting button states based on the current text selection.
   * Checks if the selected text has bold, italic, underline, font size, and font family.
   */
  function handleTextSelectionChange(): void {
    if (!activeTextObject) return

    const hasSelection = activeTextObject.selectionStart !== activeTextObject.selectionEnd
    const textLength = activeTextObject.text?.length ?? 0

    // Helper to get effective style value using fabric's getValueOfPropertyAt
    // which properly handles base + character-level style inheritance
    type StyleProperty = 'fontWeight' | 'fontStyle' | 'underline' | 'fontFamily' | 'fontSize' | 'fill'
    const getEffectiveStyle = (charIndex: number, property: StyleProperty): unknown => {
      const loc = activeTextObject.get2DCursorLocation(charIndex, true)
      return activeTextObject.getValueOfPropertyAt(loc.lineIndex, loc.charIndex, property)
    }

    if (hasSelection) {
      if (!suppressSelectionTracking) {
        lastTextSelectionRange = {
          start: activeTextObject.selectionStart ?? 0,
          end: activeTextObject.selectionEnd ?? 0
        }
      }

      const start = activeTextObject.selectionStart ?? 0
      const end = activeTextObject.selectionEnd ?? 0

      // Check effective styles for all characters in selection
      let allBold = true
      let allItalic = true
      let allUnderlined = true
      const fontFamilies = new Set<string>()
      let firstFontSize: number | null = null

      for (let i = start; i < end; i++) {
        if (getEffectiveStyle(i, 'fontWeight') !== 'bold') allBold = false
        if (getEffectiveStyle(i, 'fontStyle') !== 'italic') allItalic = false
        if (getEffectiveStyle(i, 'underline') !== true) allUnderlined = false
        fontFamilies.add(String(getEffectiveStyle(i, 'fontFamily') || activeTextObject.fontFamily))
        if (firstFontSize === null) {
          firstFontSize = (getEffectiveStyle(i, 'fontSize') as number) || activeTextObject.fontSize
        }
      }

      isSelectionBold = end > start && allBold
      isSelectionItalic = end > start && allItalic
      isSelectionUnderlined = end > start && allUnderlined

      if (firstFontSize !== null) {
        selectionFontSize = firstFontSize
      } else if (activeTextObject.fontSize) {
        selectionFontSize = activeTextObject.fontSize
      }

      if (fontFamilies.size > 1) {
        selectionFontFamily = 'Multiple'
      } else if (fontFamilies.size === 1) {
        selectionFontFamily = fontFamilies.values().next().value
      } else if (activeTextObject.fontFamily) {
        selectionFontFamily = activeTextObject.fontFamily
      }

      // Read fill color from first selected character
      if (end > start) {
        selectionFillColor = (getEffectiveStyle(start, 'fill') as string) || activeTextObject.fill as string || '#333333'
      }
    } else {
      if (!suppressSelectionTracking) {
        lastTextSelectionRange = null
      }

      // No text selection - check effective styles for ALL characters
      let allBold = true
      let allItalic = true
      let allUnderlined = true
      const fontFamilies = new Set<string>()
      let firstFontSize: number | null = null

      for (let i = 0; i < textLength; i++) {
        if (getEffectiveStyle(i, 'fontWeight') !== 'bold') allBold = false
        if (getEffectiveStyle(i, 'fontStyle') !== 'italic') allItalic = false
        if (getEffectiveStyle(i, 'underline') !== true) allUnderlined = false
        fontFamilies.add(String(getEffectiveStyle(i, 'fontFamily') || activeTextObject.fontFamily))
        if (firstFontSize === null) {
          firstFontSize = (getEffectiveStyle(i, 'fontSize') as number) || activeTextObject.fontSize
        }
      }

      isSelectionBold = textLength > 0 && allBold
      isSelectionItalic = textLength > 0 && allItalic
      isSelectionUnderlined = textLength > 0 && allUnderlined

      if (firstFontSize !== null) {
        selectionFontSize = firstFontSize
      } else if (activeTextObject.fontSize) {
        selectionFontSize = activeTextObject.fontSize
      }

      if (fontFamilies.size > 1) {
        selectionFontFamily = 'Multiple'
      } else if (fontFamilies.size === 1) {
        selectionFontFamily = fontFamilies.values().next().value
      } else if (activeTextObject.fontFamily) {
        selectionFontFamily = activeTextObject.fontFamily
      }

      // Read fill color from first character
      if (textLength > 0) {
        selectionFillColor =
          (getEffectiveStyle(0, 'fill') as string) ||
          (activeTextObject.fill as string) ||
          '#333333'
      }
    }
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Creates a new, unsaved presentation with one blank slide in a temp database.
   * Checks for unsaved changes before proceeding.
   */
  async function handleNewPresentation(): Promise<void> {
    let retryCount = 0
    const maxRetries = 3
    let userInitiatedRetries = 0
    const maxUserRetries = 2 // Cap user-initiated retries to prevent infinite loops

    while (retryCount < maxRetries) {
      let tempPath: string | null = null

      try {
        // Flush any pending saves before switching presentations
        await flushPendingSave()

        // Clear current slide to prevent any accidental saves to new database
        appState.currentSlide = null
        appState.currentSlideIndex = -1
        imageElementCache.clear()

        // Close any existing database connection
        if (appState.currentFilePath) {
          await window.api.db.closeConnection(appState.currentFilePath)
        }

        // Create a new temp database
        tempPath = await window.api.db.createTemp()

        // Create the first slide in the temp database
        const newSlide = await window.api.db.createSlide(tempPath)

        // Update state
        appState.currentFilePath = tempPath
        appState.isTempFile = true
        appState.slideIds = [newSlide.id]
        appState.currentSlide = newSlide
        appState.currentSlideIndex = 0
        appState.selectedObjectId = null

        console.log('Created new presentation with temp database:', tempPath)
        setSaveStatus('saved')
        return // Success!
      } catch (error) {
        console.error(`Failed to create new presentation (attempt ${retryCount + 1}/${maxRetries}):`, error)

        // Clean up the temp file if it was created
        if (tempPath) {
          try {
            await window.api.db.deleteTemp(tempPath)
            console.log(`Cleaned up failed temp file: ${tempPath}`)
          } catch (cleanupError) {
            console.error('Failed to clean up temp file:', cleanupError)
            // If cleanup fails, the file will be cleaned up by the 24-hour orphan cleanup
            // This is non-fatal, so we continue with the retry
          }
        }

        retryCount++

        if (retryCount >= maxRetries) {
          // All retries failed - show error and offer recovery
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          const retry = confirm(
            `Failed to create new presentation after ${maxRetries} attempts: ${errorMessage}\n\n` +
            'This might be due to:\n' +
            '• Insufficient disk space\n' +
            '• Permission issues\n' +
            '• Corrupted temp directory\n\n' +
            'Would you like to try again?'
          )

          if (retry) {
            // Cap user-initiated retries to prevent infinite looping
            userInitiatedRetries++
            if (userInitiatedRetries > maxUserRetries) {
              alert(
                'Unable to create a new presentation after multiple attempts. ' +
                'Please check your system resources and try again later.'
              )
              return
            }
            retryCount = 0 // Reset and try again
          } else {
            // User gave up - leave them with current state (if any)
            return
          }
        } else {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, NEW_PRESENTATION_RETRY_DELAY_MS))
        }
      }
    }
  }

  /**
   * Opens a file dialog and loads the selected presentation.
   * Checks for unsaved changes before proceeding.
   */
  async function handleOpen(): Promise<void> {
    const filePath = await window.api.dialog.showOpenDialog()
    if (filePath) {
      try {
        // Flush any pending saves before switching presentations
        await flushPendingSave()

        imageElementCache.clear()
        await loadPresentation(filePath)
        setSaveStatus('saved')
      } catch (error) {
        console.error('Failed to open presentation:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        alert(`Failed to open presentation: ${errorMessage}`)
      }
    }
  }

  /**
   * Saves the current slide to the existing file.
   * If this is a temp file, triggers Save As instead.
   * Uses promise lock to prevent concurrent save operations.
   */
  async function handleSave(): Promise<void> {
    // If this is a temp file (unsaved presentation), delegate to Save As
    if (appState.isTempFile) {
      await handleSaveAs()
      return
    }

    // Flush any pending auto-save immediately
    await flushPendingSave()
    console.log('Saved to', appState.currentFilePath)
  }

  /**
   * Opens a save dialog and saves the presentation to a new file.
   * For temp files, moves the database. For saved files, copies the database.
   * Prevents concurrent save operations using promise lock.
   */
  async function handleSaveAs(): Promise<void> {
    // Save original state in case we need to recover from an error
    const originalFilePath = appState.currentFilePath
    const originalSlideId = appState.currentSlide?.id

    try {
      if (!appState.currentFilePath) {
        throw new Error('No current file path')
      }

      // Save current slide to database first to flush all edits
      await performSave(true)

      // Show save dialog
      const newPath = await window.api.dialog.showSaveDialog()
      if (!newPath) return

      // Remember which slide we're currently viewing so we can restore it
      const currentSlideId = appState.currentSlide?.id

      // Move or copy the database depending on whether it's a temp file
      let resultPath: string
      if (appState.isTempFile) {
        // For temp files, move the database to the new location
        resultPath = await window.api.db.saveToLocation(appState.currentFilePath, newPath)
      } else {
        // For saved files, copy the database to the new location
        resultPath = await window.api.db.copyToLocation(appState.currentFilePath, newPath)
      }

      // Update state
      appState.currentFilePath = resultPath
      appState.isTempFile = false

      // Reload slide IDs from the new file
      const ids = await window.api.db.getSlideIds(resultPath)
      appState.slideIds = ids

      // Restore the slide the user was viewing
      if (currentSlideId && appState.slideIds.includes(currentSlideId)) {
        try {
          await loadSlide(currentSlideId)
        } catch (slideLoadError) {
          console.error('Failed to restore original slide:', slideLoadError)
          // Not critical - load the first slide instead
          if (ids.length > 0) {
            await loadSlide(ids[0])
          }
        }
      }

      console.log(`Saved presentation to ${resultPath}`)
    } catch (error) {
      console.error('Save As operation failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      alert(`Failed to save presentation: ${errorMessage}`)

      // Try to recover original state if we changed files
      if (originalFilePath && appState.currentFilePath !== originalFilePath) {
        try {
          await loadPresentation(originalFilePath)
          if (originalSlideId) {
            await loadSlide(originalSlideId)
          }
        } catch (recoveryError) {
          console.error('Failed to recover original state:', recoveryError)
        }
      }
    }
  }

  /**
   * Keyboard shortcut handler for Cmd/Ctrl+S (Save)
   */
  keys.onKeys(['meta', 's'], async () => {
    await handleSave()
  })

  // ============================================================================
  // Font Management
  // ============================================================================

  /**
   * Loads system fonts and initializes the available fonts list.
   * Called once on mount.
   */
  /**
   * Determines if a font should be excluded from the user-facing font list.
   * Based on common patterns used by professional software like LibreOffice.
   */
  function shouldExcludeFont(family: string): boolean {
    // Filter out private system fonts (starting with .)
    if (family.startsWith('.')) return true

    // Filter out Noto variants for specialized scripts
    // Keep base "Noto Sans" and "Noto Serif" (without space after)
    if (family.startsWith('Noto Sans ') || family.startsWith('Noto Serif ')) return true

    // Filter out STIX math symbol variants
    // Keep only main STIX Two variants
    if (family.startsWith('STIX') && !['STIX Two Math', 'STIX Two Text'].includes(family))
      return true

    // Symbol and dingbat fonts (cross-platform)
    const symbolFonts = [
      'Webdings',
      'Wingdings',
      'Wingdings 2',
      'Wingdings 3',
      'Zapf Dingbats',
      'Symbol',
      'Apple Symbols',
      'Apple Braille',
      'OpenSymbol',
      'Standard Symbols'
    ]
    if (symbolFonts.includes(family)) return true

    // Ornamental and decorative variants
    if (family.includes('Ornaments')) return true
    if (family.includes('Dingbats')) return true

    // Bitmap fonts (often low quality)
    if (family.includes('Bitmap')) return true

    // Filter out font variants that are for internal use
    if (family.includes('UI Font')) return true
    if (family.includes('System Font')) return true

    return false
  }

  async function loadSystemFonts(): Promise<void> {
    try {
      systemFonts = await window.api.fonts.getSystemFonts()
      // Extract unique font families, filtering out unwanted fonts
      const families = Array.from(new Set(systemFonts.map((f) => f.family))).filter(
        (family) => !shouldExcludeFont(family)
      )
      availableFonts = [...new Set([...availableFonts, ...families])].sort()
      console.log(
        `Loaded ${families.length} system fonts (${systemFonts.length - families.length} filtered out)`
      )
    } catch (error) {
      console.error('Failed to load system fonts:', error)
      // Continue with default fonts
    }
  }

  /**
   * Loads embedded fonts from the database and injects them via CSS @font-face.
   * Should be called after opening a presentation file.
   */
  async function loadEmbeddedFonts(): Promise<void> {
    if (!appState.currentFilePath) return

    try {
      const embeddedFonts = await window.api.fonts.getEmbeddedFonts(appState.currentFilePath)

      // Get unique font families from embedded fonts
      const embeddedFamilies = Array.from(new Set(embeddedFonts.map((f) => f.fontFamily)))

      // Add embedded fonts to available fonts list if not already present
      for (const family of embeddedFamilies) {
        if (!availableFonts.includes(family)) {
          availableFonts = [...availableFonts, family].sort()
        }
      }

      // Inject the fonts into the page
      for (const font of embeddedFonts) {
        await injectFontFace(font.fontFamily, font.fontData, font.format, font.variant)
      }

      if (document?.fonts?.ready) {
        await document.fonts.ready
      }

      if (embeddedFonts.length > 0) {
        console.log(
          `Loaded ${embeddedFonts.length} embedded fonts from presentation (${embeddedFamilies.length} families)`
        )
        refreshTextRendering()
      }
    } catch (error) {
      console.error('Failed to load embedded fonts:', error)
    }
  }

  function refreshTextRendering(): void {
    if (!fabCanvas) return
    fabCanvas.getObjects().forEach((obj) => {
      if (obj instanceof IText) {
        obj.dirty = true
        obj.initDimensions()
      }
    })
    fabCanvas.requestRenderAll()
  }

  type FontBytes = Buffer | ArrayBuffer | Uint8Array | { data: number[] } | { data: Uint8Array }

  function fontDataToBase64(fontData: FontBytes): string {
    const bytes = normalizeFontBytes(fontData)
    if (!bytes) {
      throw new Error('Unsupported font data type')
    }

    try {
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64')
      }
    } catch {
      // Fall back to manual base64 conversion.
    }

    const chunkSize = 0x8000
    let binary = ''

    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }

    return btoa(binary)
  }

  function normalizeFontBytes(fontData: FontBytes): Uint8Array | null {
    if (fontData instanceof Uint8Array) {
      return fontData
    }

    if (fontData instanceof ArrayBuffer) {
      return new Uint8Array(fontData)
    }

    if (typeof Buffer !== 'undefined' && fontData instanceof Buffer) {
      return new Uint8Array(fontData)
    }

    if (fontData && typeof fontData === 'object' && 'data' in fontData) {
      const data = fontData.data
      if (data instanceof Uint8Array) {
        return data
      }
      if (Array.isArray(data)) {
        return new Uint8Array(data)
      }
    }

    return null
  }

  async function ensureFontReady(fontFamily: string, weight: string, style: string): Promise<void> {
    if (!document?.fonts?.load) return

    const normalizedStyle = style === 'italic' ? 'italic' : 'normal'
    const normalizedWeight = weight === 'bold' ? 'bold' : 'normal'

    try {
      await document.fonts.load(`${normalizedStyle} ${normalizedWeight} 16px '${fontFamily}'`)
    } catch (error) {
      console.warn(`Failed to load font via FontFaceSet: ${fontFamily}`, error)
    }
  }

  /**
   * Injects a font into the page using CSS @font-face.
   *
   * @param fontFamily - The font family name
   * @param fontData - Binary font data as Buffer
   * @param format - Font format (ttf, otf, woff, woff2)
   * @param variant - Font variant (e.g., "normal-normal", "bold-italic")
   */
  async function injectFontFace(
    fontFamily: string,
    fontData: Buffer,
    format: string,
    variant: string = 'normal-normal'
  ): Promise<void> {
    const key = `${fontFamily}-${variant}`
    if (loadedFonts.has(key)) {
      return // Already loaded
    }

    try {
      // Convert Buffer to base64 for data URI
      const base64 = fontDataToBase64(fontData)

      // Determine font format for @font-face
      const normalizedFormat = format === 'ttc' ? 'ttf' : format
      let fontFormat = normalizedFormat
      if (normalizedFormat === 'ttf') fontFormat = 'truetype'
      else if (normalizedFormat === 'otf') fontFormat = 'opentype'

      // Parse variant to get weight and style
      const [weight, style] = variant.split('-')

      // Create @font-face CSS rule
      const fontFaceRule = `
        @font-face {
          font-family: '${fontFamily}';
          src: url(data:font/${normalizedFormat};base64,${base64}) format('${fontFormat}');
          font-weight: ${weight};
          font-style: ${style};
        }
      `

      // Inject into document
      const styleEl = document.createElement('style')
      styleEl.textContent = fontFaceRule
      document.head.appendChild(styleEl)

      loadedFonts.add(key)
      await ensureFontReady(fontFamily, weight, style)
      cache.clearFontCache(fontFamily)
      console.log(`Injected font: ${fontFamily} (${variant})`)
    } catch (error) {
      console.error(`Failed to inject font ${fontFamily}:`, error)
    }
  }

  /**
   * List of web-safe fonts that are available in browsers by default.
   * These fonts don't need to be embedded or loaded via @font-face.
   */
  const WEB_SAFE_FONTS = [
    'Arial',
    'Helvetica',
    'Times New Roman',
    'Times',
    'Courier New',
    'Courier',
    'Verdana',
    'Georgia',
    'Palatino',
    'Garamond',
    'Bookman',
    'Comic Sans MS',
    'Trebuchet MS',
    'Impact'
  ]

  /**
   * Embeds a font file into the database.
   * Called when a user selects a font that hasn't been embedded yet.
   *
   * @param fontFamily - The font family name to embed
   */
  async function embedFontIfNeeded(fontFamily: string): Promise<void> {
    // Skip embedding for web-safe fonts that are already available in browsers
    if (WEB_SAFE_FONTS.includes(fontFamily)) {
      console.log(`Skipping embed for web-safe font: ${fontFamily}`)
      return
    }

    // All presentations now have a currentFilePath (can be temp or saved)
    // If this check fails, it indicates a programming error
    if (!appState.currentFilePath) {
      throw new Error('Invariant violation: no currentFilePath when embedding font')
    }

    try {
      // Check if font is already embedded
      const existingFont = await window.api.fonts.getFontData(
        appState.currentFilePath,
        fontFamily,
        'normal-normal'
      )

      if (existingFont) {
        return // Already embedded
      }

      // Find the system font
      const systemFont = systemFonts.find((f) => f.family === fontFamily)
      if (!systemFont) {
        console.warn(`Font ${fontFamily} not found in system fonts`)
        return
      }

      // Embed the font
      await window.api.fonts.embedFont(
        appState.currentFilePath,
        systemFont.path,
        fontFamily,
        'normal-normal'
      )

      // Load the embedded font
      const fontData = await window.api.fonts.getFontData(
        appState.currentFilePath,
        fontFamily,
        'normal-normal'
      )

      if (fontData) {
        await injectFontFace(
          fontData.fontFamily,
          fontData.fontData,
          fontData.format,
          fontData.variant
        )
        console.log(`Embedded and loaded font: ${fontFamily}`)
      }
    } catch (error) {
      console.error(`Failed to embed font ${fontFamily}:`, error)
    }
  }

  /**
   * Loads a system font for preview in the font dropdown (without embedding in DB).
   *
   * @param fontFamily - The font family name to load for preview
   */
  async function loadFontForPreview(fontFamily: string): Promise<void> {
    // Skip loading for web-safe fonts that are already available in browsers
    if (WEB_SAFE_FONTS.includes(fontFamily)) {
      return
    }

    const key = `${fontFamily}-normal-normal`
    if (loadedFonts.has(key)) {
      return // Already loaded
    }

    try {
      // Find the system font
      const systemFont = systemFonts.find((f) => f.family === fontFamily)
      if (!systemFont) {
        return // Font not found
      }

      // Load font data directly from system path
      const fontData = await window.api.fonts.loadFontFile(systemFont.path)
      if (fontData) {
        await injectFontFace(fontFamily, fontData, systemFont.format, 'normal-normal')
      }
    } catch (error) {
      console.error(`Failed to load font for preview ${fontFamily}:`, error)
    }
  }

  /**
   * Queues a font for lazy loading and processes the queue in batches
   */
  function queueFontForLoading(fontFamily: string): void {
    fontLoadingQueue.add(fontFamily)
    processFontQueue()
  }

  /**
   * Processes the font loading queue in batches to avoid blocking the UI
   */
  async function processFontQueue(): Promise<void> {
    if (isLoadingFonts || fontLoadingQueue.size === 0) {
      return
    }

    isLoadingFonts = true

    // Process in small batches with breaks between
    const batch = Array.from(fontLoadingQueue).slice(0, 5)
    fontLoadingQueue = new Set(Array.from(fontLoadingQueue).slice(5))

    for (const font of batch) {
      await loadFontForPreview(font)
      // Small delay to prevent blocking the UI
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    isLoadingFonts = false

    // Continue processing if there are more fonts
    if (fontLoadingQueue.size > 0) {
      setTimeout(() => processFontQueue(), 50)
    }
  }

  /**
   * Toggles the custom font dropdown open/closed
   */
  function toggleFontDropdown(): void {
    fontDropdownOpen = !fontDropdownOpen
    if (fontDropdownOpen) {
      if (activeTextObject) {
        suppressSelectionTracking = true
        lastTextSelectionRange = {
          start: activeTextObject.selectionStart ?? 0,
          end: activeTextObject.selectionEnd ?? 0
        }
        const restoreStart = lastTextSelectionRange.start
        const restoreEnd = lastTextSelectionRange.end

        setTimeout(() => {
          if (!activeTextObject) {
            suppressSelectionTracking = false
            return
          }
          if (wasEditing || activeTextObject.isEditing) {
            activeTextObject.enterEditing()
          }
          activeTextObject.setSelectionStart(restoreStart)
          activeTextObject.setSelectionEnd(restoreEnd)
          fabCanvas?.requestRenderAll()
          suppressSelectionTracking = false
        }, 0)
      }
      fontSearchQuery = ''
      // Load the currently selected font and a few common ones
      if (selectionFontFamily !== 'Multiple') {
        queueFontForLoading(selectionFontFamily)
      }
      const commonFonts = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana']
      commonFonts.forEach((font) => queueFontForLoading(font))
    } else {
      suppressSelectionTracking = false
    }
  }

  /**
   * Selects a font from the custom dropdown
   */
  async function selectFontFromDropdown(fontFamily: string): Promise<void> {
    fontDropdownOpen = false
    selectionFontFamily = fontFamily

    if (!activeTextObject) return

    // Embed the font if needed
    await embedFontIfNeeded(fontFamily)

    // Apply to selection
    applyStyleToSelection({ fontFamily })
    // Note: Do NOT call updateStateFromObject() here - it would re-render and lose cursor
  }

  /**
   * Filters fonts based on search query
   */
  function getFilteredFonts(): string[] {
    if (!fontSearchQuery) return availableFonts
    const query = fontSearchQuery.toLowerCase()
    return availableFonts.filter((font) => font.toLowerCase().includes(query))
  }

  /**
   * Handles click outside to close font dropdown
   */
  function handleClickOutside(event: MouseEvent): void {
    if (fontDropdownOpen && fontDropdownRef && !fontDropdownRef.contains(event.target as Node)) {
      fontDropdownOpen = false
    }
  }

  // ============================================================================
  // Slide and Element Creation
  // ============================================================================

  /**
   * Adds a new text element to the current slide at a default position.
   */
  function nextZIndex(): number {
    if (!appState.currentSlide || appState.currentSlide.elements.length === 0) return 0
    return appState.currentSlide.elements.reduce((m, e) => Math.max(m, e.zIndex), -Infinity) + 1
  }

  function addText(): void {
    if (!appState.currentSlide) return
    const newText: DeckElement = {
      type: 'text',
      id: `text_${uuid_v4()}`,
      x: 250,
      y: 150,
      width: 200,
      height: 50,
      angle: 0,
      text: 'Double-click to edit',
      fontSize: 40,
      fontFamily: 'Arial',
      fill: '#333333',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(newText)
    scheduleSave()
  }

  /**
   * Adds a new rectangle element to the current slide at a default position.
   */
  function addRectangle(): void {
    if (!appState.currentSlide) return
    const newRect: DeckElement = {
      type: 'rect',
      id: `rect_${uuid_v4()}`,
      x: 100,
      y: 100,
      width: 150,
      height: 100,
      angle: 0,
      fill: '#FF6F61',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(newRect)
    scheduleSave()
  }

  /**
   * Opens an image file dialog and adds the selected image to the current slide.
   * The image is loaded as a base64 data URI and stored in the slide data.
   */
  async function addImage(): Promise<void> {
    if (!appState.currentSlide) return

    try {
      const imageData = await window.api.dialog.showImageDialog()

      if (!imageData) {
        return // User cancelled
      }

      // Create a temporary image element to get the natural dimensions
      const tempImg = new Image()
      tempImg.src = imageData.src

      await new Promise<void>((resolve, reject) => {
        tempImg.onload = () => resolve()
        tempImg.onerror = () => reject(new Error('Failed to load image'))
      })

      // Calculate default size (max 400px while maintaining aspect ratio)
      const maxSize = 400
      let width = tempImg.naturalWidth
      let height = tempImg.naturalHeight

      if (width > maxSize || height > maxSize) {
        const aspectRatio = width / height
        if (width > height) {
          width = maxSize
          height = maxSize / aspectRatio
        } else {
          height = maxSize
          width = maxSize * aspectRatio
        }
      }

      // Create the image element
      const newImage: DeckElement = {
        type: 'image',
        id: `image_${uuid_v4()}`,
        x: 400, // Center of default 800px canvas
        y: 300, // Center of default 600px canvas
        width: width,
        height: height,
        angle: 0,
        src: imageData.src,
        filename: imageData.filename,
        zIndex: nextZIndex()
      }

      appState.currentSlide.elements.push(newImage)
      scheduleSave()
    } catch (error) {
      console.error('Failed to add image:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to add image: ${errorMessage}`)
    }
  }

  /**
   * Creates a new blank slide and adds it to the presentation.
   * Handles both saved (file-based) and unsaved (in-memory) presentations.
   */
  async function addNewSlide(): Promise<void> {
    if (!appState.currentFilePath) {
      console.error('Cannot add slide: no current file path')
      return
    }

    let newSlideId: string | null = null
    try {
      // Create new slide in the database (works for both temp and saved files)
      const newSlide = await window.api.db.createSlide(appState.currentFilePath)
      newSlideId = newSlide.id

      // Update slideIds
      appState.slideIds = [...appState.slideIds, newSlide.id]

      // Load the new slide
      await loadSlide(newSlide.id)
    } catch (error) {
      console.error('Failed to create new slide:', error)

      // Roll back slideIds if it was added but loading failed
      if (newSlideId) {
        appState.slideIds = appState.slideIds.filter((id) => id !== newSlideId)
      }

      // Show user-friendly error message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to create new slide: ${errorMessage}`)
    }
  }

  /**
   * Flush any pending save for the current slide then navigate to the target slide.
   * This prevents stale status carrying over to the new slide's view.
   */
  async function handleSlideSelect(slideId: string): Promise<void> {
    if (slideId === appState.currentSlide?.id) return
    await flushPendingSave()
    await loadSlide(slideId)
  }

  /**
   * Deletes the currently selected object(s) from the canvas and state.
   * Supports deleting multiple objects when a multi-selection is active.
   */
  function deleteSelectedObject(): void {
    if (!fabCanvas || !appState.currentSlide) return

    const activeObjects = fabCanvas.getActiveObjects()
    if (activeObjects.length === 0) return

    // Collect IDs of objects to delete
    const idsToDelete = activeObjects.map((obj) => (obj as DeckFabricObject).id).filter((id) => id)

    if (idsToDelete.length > 0) {
      // Remove elements from state
      appState.currentSlide.elements = appState.currentSlide.elements.filter(
        (el) => !idsToDelete.includes(el.id)
      )
      // Clear the canvas selection
      fabCanvas.discardActiveObject()
      scheduleSave()
    }
  }

  // ============================================================================
  // Layer Reorder Helpers (used by StackPanel and ContextMenu)
  // ============================================================================

  /**
   * Compact all element zIndex values to sequential integers 0..n-1 after any
   * reorder operation. Mutates elements in-place on appState. Keeps DB values clean.
   */
  function compactZIndexes(): void {
    if (!appState.currentSlide) return
    const sorted = [...appState.currentSlide.elements].sort((a, b) => a.zIndex - b.zIndex)
    sorted.forEach((el, i) => { el.zIndex = i })
  }

  /**
   * Reorders existing canvas objects to match the current zIndex values in state
   * without clearing or reloading the canvas. Used by all layer reorder operations
   * (buttons and drag) to avoid triggering async image reloads and flicker.
   *
   * All objects are already on the canvas when this runs, so selection restore is
   * synchronous — no Promise needed and no generation guard required.
   */
  function applyZOrderToCanvas(): void {
    if (!fabCanvas || !appState.currentSlide) return
    const sorted = [...appState.currentSlide.elements].sort((a, b) => a.zIndex - b.zIndex)
    const objs = fabCanvas.getObjects() as DeckFabricObject[]
    sorted.forEach((el, targetIndex) => {
      const obj = objs.find((o) => o.id === el.id)
      if (obj) fabCanvas.moveTo(obj, targetIndex)
    })
    const savedId = appState.selectedObjectId
    if (savedId) {
      const obj = (fabCanvas.getObjects() as DeckFabricObject[]).find((o) => o.id === savedId)
      if (obj) fabCanvas.setActiveObject(obj)
    }
    fabCanvas.requestRenderAll()
  }

  /**
   * Re-renders the canvas then restores the previously active object.
   * Used only for slide navigation and initial load, not for layer reorders
   * (which use the lighter applyZOrderToCanvas instead).
   * Waits for async image loads to settle before restoring, so image elements are
   * re-selected correctly even when they land on the canvas asynchronously.
   */
  function renderCanvasAndRestoreSelection(): void {
    const savedId = appState.selectedObjectId
    // Capture the generation that renderCanvasFromState() is about to stamp.
    // Checked in .then() to bail out if a newer render started before ours settled.
    const expectedGeneration = renderGeneration + 1
    renderCanvasFromState()
      .then(() => {
        if (!savedId || !fabCanvas) return
        if (renderGeneration !== expectedGeneration) return
        const obj = fabCanvas.getObjects().find((o) => (o as DeckFabricObject).id === savedId)
        if (obj) {
          fabCanvas.setActiveObject(obj)
          fabCanvas.requestRenderAll()
        }
      })
      .catch((err) => console.error('Canvas render failed:', err))
  }

  function layerBringToFront(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    const max = appState.currentSlide.elements.reduce((m, e) => Math.max(m, e.zIndex), -Infinity)
    el.zIndex = max + 1
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
  }

  function layerSendToBack(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    const min = appState.currentSlide.elements.reduce((m, e) => Math.min(m, e.zIndex), Infinity)
    el.zIndex = min - 1
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
  }

  function layerMoveUp(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    const above = appState.currentSlide.elements
      .filter((e) => e.zIndex > el.zIndex)
      .sort((a, b) => a.zIndex - b.zIndex)[0]
    if (!above) return
    ;[el.zIndex, above.zIndex] = [above.zIndex, el.zIndex]
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
  }

  function layerMoveDown(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    const below = appState.currentSlide.elements
      .filter((e) => e.zIndex < el.zIndex)
      .sort((a, b) => b.zIndex - a.zIndex)[0]
    if (!below) return
    ;[el.zIndex, below.zIndex] = [below.zIndex, el.zIndex]
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
  }

  // ============================================================================
  // Keyboard and Mouse Event Handlers
  // ============================================================================

  /**
   * Global keyboard event handler for shortcuts.
   * Handles Cmd/Ctrl+A (Select All), Delete/Backspace (Delete object), and Cmd/Ctrl+Shift+D (Debug Window).
   */
  function handleKeyDown(event: KeyboardEvent): void {
    // Cmd/Ctrl+Shift+D: Open debug window
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      openDebugWindow()
      return
    }

    // Cmd/Ctrl+A: Select all objects on the canvas (unless editing text)
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      // Don't intercept if user is editing text - let them select text normally
      if (activeTextObject && activeTextObject.isEditing) {
        return
      }

      event.preventDefault()
      if (fabCanvas) {
        const allObjects = fabCanvas.getObjects()
        if (allObjects.length > 0) {
          const selection = new ActiveSelection(allObjects, { canvas: fabCanvas })
          fabCanvas.setActiveObject(selection)
          fabCanvas.renderAll()
        }
      }
      return
    }

    // Delete/Backspace: Delete selected object (but not while editing text)
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Don't delete object if user is editing text content
      if (activeTextObject && activeTextObject.isEditing) {
        return
      }
      event.preventDefault()
      deleteSelectedObject()
    }
  }

  /**
   * Handles right-click events on the canvas.
   * Shows a context menu if an object is clicked, hides it otherwise.
   */
  function handleContextMenu(opt: { e: MouseEvent; target?: FabricObject }): void {
    opt.e.preventDefault()
    if (!fabCanvas) return

    if (opt.target) {
      // Object was clicked - select it and show context menu
      if (!fabCanvas.getActiveObjects().includes(opt.target)) {
        fabCanvas.discardActiveObject()
        fabCanvas.setActiveObject(opt.target)
        fabCanvas.requestRenderAll()
      }
      contextMenuPosition = { x: opt.e.clientX, y: opt.e.clientY }
      contextMenuVisible = true
    } else {
      // Empty space was clicked - clear selection and hide menu
      fabCanvas.discardActiveObject()
      fabCanvas.requestRenderAll()
      contextMenuVisible = false
    }
  }

  /**
   * Hides the context menu.
   * Called when clicking anywhere outside the context menu.
   */
  function hideContextMenu(): void {
    contextMenuVisible = false
  }

  // ============================================================================
  // Presentation Mode
  // ============================================================================

  // Store the slide state before entering presentation mode
  let slideStateBeforePresentation: { slideId: string; elements: DeckElement[] } | null = null

  /**
   * Enters presentation mode (fullscreen slideshow).
   * Preserves the current slide state.
   */
  async function enterPresentationMode(): Promise<void> {
    // Save a snapshot of current slide state
    if (appState.currentSlide) {
      slideStateBeforePresentation = {
        slideId: appState.currentSlide.id,
        elements: JSON.parse(JSON.stringify(appState.currentSlide.elements))
      }
    }

    // Flush any pending auto-save before presenting
    try {
      await flushPendingSave()
    } catch (error) {
      console.error('Failed to save before presenting:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const proceed = confirm(
        `Failed to save recent changes: ${errorMessage}\n\n` +
        'Your presentation may show stale data. Continue to presentation mode anyway?'
      )
      if (!proceed) {
        return // Abort entering presentation mode
      }
    }

    // Dispose the edit canvas before entering presentation mode
    // This ensures a fresh canvas is created when we exit
    if (fabCanvas) {
      fabCanvas.dispose()
      fabCanvas = undefined
    }

    // Enter presentation mode
    appState.isPresentingMode = true
  }

  /**
   * Exits presentation mode and returns to edit mode.
   * Restores the slide state that was active before presenting.
   */
  function exitPresentationMode(): void {
    // Restore the slide state if we have a snapshot and we're on the same slide
    if (slideStateBeforePresentation && appState.currentSlide) {
      if (appState.currentSlide.id === slideStateBeforePresentation.slideId) {
        appState.currentSlide.elements = slideStateBeforePresentation.elements
      }
    }

    slideStateBeforePresentation = null

    // Exit presentation mode - this will trigger the main $effect to create
    // a new canvas and render the current slide
    appState.isPresentingMode = false
  }

  /**
   * Keyboard shortcut handler for F5 (Start Presentation)
   */
  keys.onKeys(['F5'], async (event) => {
    event.preventDefault()
    if (!appState.isPresentingMode) {
      await enterPresentationMode()
    }
  })

  /**
   * Keyboard shortcut handler for Cmd/Ctrl+Shift+D (Open Debug Window)
   */
  keys.onKeys(['meta', 'shift', 'd'], () => {
    openDebugWindow()
  })
</script>

<svelte:window onkeydown={handleKeyDown} onclick={hideContextMenu} />

{#if appState.isPresentingMode}
  <!-- Presentation Mode (Fullscreen) -->
  <PresentationView onExit={exitPresentationMode} />
{:else if appState.currentSlide}
  <div
    class="flex flex-col h-screen font-sans"
    role="application"
  >
    {#if contextMenuVisible}
      <ContextMenu
        x={contextMenuPosition.x}
        y={contextMenuPosition.y}
        onDelete={() => { deleteSelectedObject(); hideContextMenu() }}
        onBringToFront={appState.selectedObjectId ? () => { layerBringToFront(appState.selectedObjectId!); hideContextMenu() } : undefined}
        onMoveUp={appState.selectedObjectId ? () => { layerMoveUp(appState.selectedObjectId!); hideContextMenu() } : undefined}
        onMoveDown={appState.selectedObjectId ? () => { layerMoveDown(appState.selectedObjectId!); hideContextMenu() } : undefined}
        onSendToBack={appState.selectedObjectId ? () => { layerSendToBack(appState.selectedObjectId!); hideContextMenu() } : undefined}
        isAtFront={selectedIsAtFront}
        isAtBack={selectedIsAtBack}
      />
    {/if}
    <div class="flex items-center p-2 bg-gray-100 border-b border-gray-300 shadow-sm">
      <button
        onclick={handleNewPresentation}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
      >
        New
      </button>
      <button
        onclick={handleOpen}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Open
      </button>
      <button
        onclick={handleSave}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Save
      </button>
      <button
        onclick={handleSaveAs}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Save As
      </button>
      <div class="flex items-center mr-2 w-28">
        {#if saveStatus === 'idle' && lastSavedAt !== null}
          <span class="flex items-center gap-1 text-xs text-gray-400">
            <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
              <polyline points="17 21 17 13 7 13 7 21"/>
              <polyline points="7 3 7 8 15 8"/>
            </svg>
            {formatRelativeTime(lastSavedAt)}
          </span>
        {:else if saveStatus === 'pending'}
          <span class="flex items-center gap-1 text-xs text-gray-400">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 8 8">
              <circle cx="4" cy="4" r="3" />
            </svg>
            Unsaved
          </span>
        {:else if saveStatus === 'saving'}
          <span class="flex items-center gap-1 text-xs text-blue-500">
            <svg class="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke-linecap="round"/>
            </svg>
            Saving...
          </span>
        {:else if saveStatus === 'saved'}
          <span class="flex items-center gap-1 text-xs text-green-600">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Saved
          </span>
        {:else if saveStatus === 'error'}
          <span class="flex items-center gap-1 text-xs text-red-500" title="Auto-save failed">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            Save failed
          </span>
        {/if}
      </div>
      {#if appState.isTempFile}
        <span
          class="flex items-center gap-1 px-2 py-0.5 mr-2 text-xs font-medium text-amber-700 bg-amber-100 border border-amber-300 rounded-md"
          title="This presentation hasn't been saved to a file yet. Click 'Save' to choose a location."
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          Temp file
        </span>
      {/if}
      <div class="h-6 w-px bg-gray-300 mx-2"></div>
      <button
        onclick={enterPresentationMode}
        class="px-3 py-1 mr-2 text-sm font-medium text-white bg-indigo-600 border border-indigo-600 rounded-md hover:bg-indigo-700"
        title="Start presentation (F5)"
      >
        Present
      </button>
      <button
        onclick={openDebugWindow}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        title="Open debug window (Cmd/Ctrl+Shift+D)"
      >
        Debug
      </button>
      <div class="h-6 w-px bg-gray-300 mx-2"></div>
      <button
        onclick={addRectangle}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
      >
        Add Shape
      </button>
      <button
        onclick={addText}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
      >
        Add Text
      </button>
      <button
        onclick={addImage}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
      >
        Add Image
      </button>
      <button
        onclick={() => (showStackPanel = !showStackPanel)}
        class="px-3 py-1 mr-2 text-sm font-medium border rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        class:bg-indigo-100={showStackPanel}
        class:border-indigo-400={showStackPanel}
        class:text-indigo-700={showStackPanel}
        class:bg-white={!showStackPanel}
        class:border-gray-300={!showStackPanel}
        class:text-gray-700={!showStackPanel}
        title="Toggle Layers panel"
      >
        Layers
      </button>
      {#if showRichTextControls}
        <div class="h-6 w-px bg-gray-300 mx-2"></div>
        <button
          onclick={toggleBold}
          class="w-8 h-8 flex items-center justify-center font-bold text-sm rounded-md border border-gray-300 mr-1"
          class:bg-indigo-200={isSelectionBold}
          class:text-white={isSelectionBold}
          >B
        </button>
        <button
          onclick={toggleItalic}
          class="w-8 h-8 flex items-center justify-center italic text-sm rounded-md border border-gray-300 mr-1"
          class:bg-indigo-200={isSelectionItalic}
          class:text-white={isSelectionItalic}
          >I
        </button>
        <button
          onclick={toggleUnderline}
          class="w-8 h-8 flex items-center justify-center underline text-sm rounded-md border border-gray-300 mr-1"
          class:bg-indigo-200={isSelectionUnderlined}
          class:text-white={isSelectionUnderlined}
          >U
        </button>
        <input
          type="number"
          bind:value={selectionFontSize}
          onchange={changeFontSize}
          onkeydown={(e) => e.stopPropagation()}
          min="1"
          max="500"
          class="w-16 h-8 px-2 text-sm border border-gray-300 rounded-md mr-1"
          placeholder="Size"
        />
        <!-- Custom font dropdown with previews -->
        <div bind:this={fontDropdownRef} class="relative mr-1">
          <button
            onclick={toggleFontDropdown}
            onkeydown={(e) => e.stopPropagation()}
            class="h-8 px-2 pr-6 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 flex items-center min-w-[120px] relative"
            style={selectionFontFamily !== 'Multiple'
              ? `font-family: ${escapeCssFontFamily(selectionFontFamily)}`
              : ''}
          >
            <span
              class="truncate"
              class:italic={selectionFontFamily === 'Multiple'}
              class:text-gray-500={selectionFontFamily === 'Multiple'}
            >
              {selectionFontFamily}
            </span>
            <svg
              class="w-4 h-4 absolute right-1 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              ></path>
            </svg>
          </button>

          {#if fontDropdownOpen}
            <div
              class="absolute z-50 mt-1 w-64 max-h-80 overflow-y-auto bg-white border border-gray-300 rounded-md shadow-lg"
              onkeydown={(e) => e.stopPropagation()}
              style="will-change: scroll-position; contain: layout style paint;"
            >
              <!-- Search input -->
              <div class="sticky top-0 bg-white p-2 border-b border-gray-200 z-10">
                <input
                  type="text"
                  bind:value={fontSearchQuery}
                  placeholder="Search fonts..."
                  class="w-full px-2 py-1 text-sm border border-gray-300 rounded bg-white"
                  onkeydown={(e) => e.stopPropagation()}
                />
              </div>

              <!-- Font list -->
              <div class="py-1">
                {#each getFilteredFonts() as font}
                  <button
                    onclick={() => selectFontFromDropdown(font)}
                    onmouseenter={() => queueFontForLoading(font)}
                    class="w-full px-3 py-2 text-left hover:bg-blue-50 flex items-center text-base"
                    class:bg-blue-100={font === selectionFontFamily}
                    style="font-family: {escapeCssFontFamily(font)}; contain: layout style;"
                  >
                    {font}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        <input
          type="color"
          bind:value={selectionFillColor}
          oninput={() => applyStyleToSelection({ fill: selectionFillColor })}
          class="w-8 h-8 p-0 border-none bg-transparent"
        />
      {/if}
    </div>
    <div class="flex flex-1 overflow-hidden">
      <div class="basis-48 p-2 overflow-y-auto bg-gray-50 border-r border-gray-300">
        {#each appState.slideIds as slideId, index (slideId)}
          <button
            class="p-2 mb-2 text-sm text-center bg-white border rounded-md shadow-md cursor-pointer hover:border-indigo-500 w-full"
            class:border-indigo-500={slideId === appState.currentSlide.id}
            class:bg-indigo-100={slideId === appState.currentSlide.id}
            onclick={async () => await handleSlideSelect(slideId)}
            disabled={loadingState.isLoadingSlide}
          >
            Slide {index + 1}
          </button>
        {/each}
        <button
          onclick={addNewSlide}
          class="w-full p-2 mt-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          New Slide
        </button>
      </div>
      <div class="flex-1 p-4 bg-gray-200">
        <div class="flex items-center justify-center h-full overflow-auto">
          <div class="bg-white shadow-lg">
            <canvas bind:this={canvasEl} width="800" height="600"></canvas>
          </div>
        </div>
      </div>
      {#if showStackPanel}
        <div
          class="bg-gray-50 border-l border-gray-300 overflow-hidden flex flex-col relative flex-shrink-0"
          style="width: {stackPanelWidth}px;"
        >
          <!-- Resize handle on the left edge -->
          <div
            class="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400 active:bg-indigo-500 z-10"
            onmousedown={startStackPanelResize}
            role="separator"
            aria-label="Resize layers panel"
          ></div>
          <!--
            onLayerChange is only called by the drag-to-reorder path in StackPanel.
            The button paths (onBringToFront etc.) call layerBringToFront/layerMoveUp/
            layerMoveDown/layerSendToBack directly, which already invoke
            applyZOrderToCanvas + scheduleSave internally, so they do NOT call
            onLayerChange to avoid a double canvas update.
          -->
          <StackPanel
            onLayerChange={() => { applyZOrderToCanvas(); scheduleSave() }}
            onSelect={(id) => {
              if (!fabCanvas) return
              const obj = fabCanvas.getObjects().find((o) => (o as DeckFabricObject).id === id)
              if (obj) {
                fabCanvas.discardActiveObject()
                fabCanvas.setActiveObject(obj)
                fabCanvas.requestRenderAll()
              }
            }}
            onBringToFront={layerBringToFront}
            onMoveUp={layerMoveUp}
            onMoveDown={layerMoveDown}
            onSendToBack={layerSendToBack}
          />
        </div>
      {/if}
      <PropertiesPanel onPropertyChange={scheduleSave} />
    </div>
  </div>
{:else}
  <div class="flex items-center justify-center h-screen">
    <p class="text-lg text-gray-500">Starting...</p>
  </div>
{/if}
