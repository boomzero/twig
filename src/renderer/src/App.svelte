<!--
  Main Application Component - App.svelte

  This is the main UI component for Deckhand. It manages:
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
  - Objects use center origin (originX/Y = 'center')
  - Objects are extended with an 'id' property to link them to state
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { v4 as uuid_v4 } from 'uuid'
  import { appState, loadPresentation, loadSlide, loadingState } from './lib/state.svelte'
  import type { DeckElement, SelectionState, Slide } from './lib/state.svelte'
  import {
    Canvas,
    type FabricObject,
    IText,
    Rect,
    FabricImage,
    ActiveSelection,
    util,
    BaseFabricObject
  } from 'fabric'
  import PropertiesPanel from './components/PropertiesPanel.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import PresentationView from './components/PresentationView.svelte'
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

  // Rich text editor state
  let showRichTextControls = $state(false)
  let isSelectionBold = $state(false)
  let isSelectionItalic = $state(false)
  let isSelectionUnderlined = $state(false)
  let selectionFontSize = $state(40)
  let selectionFontFamily = $state('Arial')
  let selectionRangeToRestore: { start: number; end: number } | null = null
  let wasEditing = false

  // Font management state
  let systemFonts: { family: string; path: string; format: string }[] = []
  let availableFonts = $state(['Arial', 'Helvetica', 'Times New Roman', 'Courier New']) // Default fallbacks
  let loadedFonts = new Set<string>() // Track which fonts have been loaded via @font-face
  let pendingFontsToEmbed = new Set<string>() // Track fonts that need to be embedded on next save

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

  // Save operation state to prevent concurrent saves
  let isSaving = false

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
  onMount(async () => {
    await loadSystemFonts()
    handleNewPresentation()
  })

  /**
   * Reactive effect that tracks changes to the current slide.
   * Marks the presentation as "dirty" (unsaved) when the slide is modified.
   * Tracks the last loaded slide ID to avoid marking as dirty when switching slides.
   */
  let lastLoadedSlideId: string | null = null
  $effect(() => {
    if (appState.currentSlide) {
      if (lastLoadedSlideId === appState.currentSlide.id) {
        // Same slide reloading - mark as dirty (user made changes)
        appState.isDirty = true
      } else {
        // Different slide loaded - don't mark dirty (just switching slides)
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
      fabCanvas?.clear()
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
          renderCanvasFromState()
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

    // Step 2: Create canvas if it doesn't exist yet
    if (!fabCanvas) {
      fabCanvas = new Canvas(canvasEl)
    }

    // Step 3: Re-render all objects from state
    renderCanvasFromState()

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
  // fabric.js Configuration and Canvas Rendering
  // ============================================================================

  /**
   * Configure fabric.js defaults to use center origin for all objects.
   * This makes rotation and scaling more intuitive.
   */



  BaseFabricObject.ownDefaults.originY = 'center'
  BaseFabricObject.ownDefaults.originX = 'center'

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
  function renderCanvasFromState(): void {
    if (!fabCanvas || !appState.currentSlide) return
    const currentSlide = appState.currentSlide

    // Remove old event listeners to prevent duplicate handlers
    fabCanvas.off('object:modified', handleObjectModified)
    fabCanvas.off('selection:created', handleSelection)
    fabCanvas.off('selection:updated', handleSelection)
    fabCanvas.off('selection:cleared', handleSelectionCleared)

    // Clear the canvas and re-create all objects from state
    fabCanvas.clear()

    // Process elements - images need async loading, so handle separately
    const imageElements: DeckElement[] = []
    const nonImageElements: DeckElement[] = []

    currentSlide.elements.forEach((element) => {
      if (element.type === 'image') {
        imageElements.push(element)
      } else {
        nonImageElements.push(element)
      }
    })

    // Add non-image elements synchronously
    nonImageElements.forEach((element) => {
      let fabObj: FabricObject | undefined

      // Create fabric.js object based on element type
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
        fabObj = new IText(element.text || 'Hello', {
          left: element.x,
          top: element.y,
          angle: element.angle,
          id: element.id,
          fill: element.fill,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          styles: element.styles || {}
        })
      }

      if (fabObj) {
        fabCanvas.add(fabObj)
      }
    })

    // Add image elements asynchronously
    imageElements.forEach((element) => {
      if (element.src) {
        FabricImage.fromURL(element.src, {
          crossOrigin: 'anonymous'
        }).then((img) => {
          // Calculate scale to match the stored width/height
          const scaleX = element.width / (img.width || 1)
          const scaleY = element.height / (img.height || 1)

          img.set({
            left: element.x,
            top: element.y,
            angle: element.angle,
            scaleX: scaleX,
            scaleY: scaleY,
            id: element.id
          })

          fabCanvas.add(img)
          fabCanvas.renderAll()
        }).catch((error) => {
          console.error('Failed to load image:', error)
        })
      }
    })

    fabCanvas.renderAll()

    // Re-attach event listeners
    fabCanvas.on('object:modified', handleObjectModified)
    fabCanvas.on('selection:created', handleSelection)
    fabCanvas.on('selection:updated', handleSelection)
    fabCanvas.on('selection:cleared', handleSelectionCleared)
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
      elementInState.styles = obj.styles
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
    console.log('🎯 handleSelection called', { selectedCount: event.selected?.length })
    if (event.selected && event.selected.length === 1) {
      appState.selectedObjectId = event.selected[0].id || null
    } else {
      appState.selectedObjectId = null
    }

    // Remove old text selection change listener
    activeTextObject?.off('selection:changed', handleTextSelectionChange)

    const selection = event.selected?.[0]
    if (selection instanceof IText) {
      console.log('📝 Text object selected', {
        isEditing: selection.isEditing,
        wasEditing,
        text: selection.text
      })
      // Text object selected - enable rich text controls
      activeTextObject = selection
      showRichTextControls = true

      // Update formatting button states based on the selected text object
      handleTextSelectionChange()

      // If user was editing before, restore editing mode
      if (wasEditing) {
        console.log('🔄 Restoring editing mode')
        activeTextObject.enterEditing()
        wasEditing = false
      }

      // Listen for text selection changes to update formatting buttons
      activeTextObject.on('selection:changed', handleTextSelectionChange)
      handleTextSelectionChange()

      // Restore text cursor position if saved
      if (selectionRangeToRestore) {
        const range = { ...selectionRangeToRestore }
        selectionRangeToRestore = null
        setTimeout(() => {
          if (activeTextObject) {
            activeTextObject.setSelectionStart(range.start)
            activeTextObject.setSelectionEnd(range.end)
            fabCanvas?.requestRenderAll()
            handleTextSelectionChange()
          }
        }, 10)
      }
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
    activeTextObject?.off('selection:changed', handleTextSelectionChange)
    appState.selectedObjectId = null
    activeTextObject = null
    showRichTextControls = false
    isSelectionBold = false
    isSelectionItalic = false
    isSelectionUnderlined = false
    selectionFontSize = 40
    wasEditing = false
  }

  // ============================================================================
  // Rich Text Formatting
  // ============================================================================

  /**
   * Applies a style to the currently selected text range.
   * If no text is selected, applies the style to the entire text object.
   */
  function applyStyleToSelection(style: Record<string, string | number | boolean>): void {
    console.log('🎨 applyStyleToSelection called', { style, hasActiveText: !!activeTextObject })
    if (!activeTextObject) return

    const hasSelection = activeTextObject.selectionStart !== activeTextObject.selectionEnd
    console.log('📝 Text state before apply:', {
      hasSelection,
      isEditing: activeTextObject.isEditing,
      selectionStart: activeTextObject.selectionStart,
      selectionEnd: activeTextObject.selectionEnd,
      text: activeTextObject.text
    })

    if (hasSelection) {
      // Apply to selected text range
      activeTextObject.setSelectionStyles(style)
      handleTextSelectionChange()
    } else {
      // No selection - apply to entire text object
      // First select all text temporarily
      activeTextObject.selectAll()
      // Apply the style to all characters
      activeTextObject.setSelectionStyles(style)

      // Also apply to object's base properties so new characters inherit the style
      Object.keys(style).forEach(key => {
        activeTextObject[key] = style[key]
      })

      // Restore no selection state
      activeTextObject.selectionStart = 0
      activeTextObject.selectionEnd = 0

      // Update UI state to match what we just applied
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
    }

    console.log('📝 Text state after apply:', {
      isEditing: activeTextObject.isEditing,
      selectionStart: activeTextObject.selectionStart,
      selectionEnd: activeTextObject.selectionEnd,
      hasHiddenTextarea: !!activeTextObject.hiddenTextarea
    })

    fabCanvas?.renderAll()
    // Note: Do NOT call updateStateFromObject() here - it causes the canvas to re-render,
    // which loses the text selection and input focus. The state will be updated when the
    // user finishes editing via the object:modified event handler.
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

  /** Changes the color of the selected text */
  function changeSelectionColor(event: Event): void {
    const color = (event.target as HTMLInputElement).value
    applyStyleToSelection({ fill: color })
  }

  /** Changes the font size of the selected text */
  function changeFontSize(event: Event): void {
    const size = parseInt((event.target as HTMLInputElement).value)
    console.log('📏 changeFontSize called', { size, hasActiveText: !!activeTextObject })
    if (!isNaN(size) && size > 0 && activeTextObject) {
      applyStyleToSelection({ fontSize: size })
      // Note: Do NOT call updateStateFromObject() here - it would re-render and lose cursor
    }
  }

  /** Changes the font family of the selected text */
  async function changeFontFamily(event: Event): Promise<void> {
    const family = (event.target as HTMLSelectElement).value
    console.log('🔤 changeFontFamily called', { family, hasActiveText: !!activeTextObject })
    if (!family || !activeTextObject) return

    // Embed the font if needed
    await embedFontIfNeeded(family)

    // Apply to selection
    applyStyleToSelection({ fontFamily: family })
    // Note: Do NOT call updateStateFromObject() here - it would re-render and lose cursor
  }

  /**
   * Updates the formatting button states based on the current text selection.
   * Checks if the selected text has bold, italic, underline, font size, and font family.
   */
  function handleTextSelectionChange(): void {
    console.log('🔄 handleTextSelectionChange called')
    if (!activeTextObject) return

    const hasSelection = activeTextObject.selectionStart !== activeTextObject.selectionEnd
    console.log('📍 Selection state:', {
      hasSelection,
      isEditing: activeTextObject.isEditing,
      selectionStart: activeTextObject.selectionStart,
      selectionEnd: activeTextObject.selectionEnd
    })

    const textLength = activeTextObject.text?.length ?? 0

    if (hasSelection) {
      // Has text selection - check character-level styles
      const styles = activeTextObject.getSelectionStyles(
        activeTextObject.selectionStart,
        activeTextObject.selectionEnd
      )
      isSelectionBold = styles.length > 0 && styles.every((style) => style.fontWeight === 'bold')
      isSelectionItalic = styles.length > 0 && styles.every((style) => style.fontStyle === 'italic')
      isSelectionUnderlined = styles.length > 0 && styles.every((style) => style.underline === true)

      // Get font size from first character in selection
      if (styles.length > 0 && styles[0].fontSize) {
        selectionFontSize = styles[0].fontSize
      } else if (activeTextObject.fontSize) {
        selectionFontSize = activeTextObject.fontSize
      }

      // Get font family - check if selection has mixed fonts
      const fontFamilies = new Set(styles.map(style => style.fontFamily || activeTextObject.fontFamily))

      if (fontFamilies.size > 1) {
        selectionFontFamily = 'Multiple'
      } else if (styles.length > 0 && styles[0].fontFamily) {
        selectionFontFamily = styles[0].fontFamily
      } else if (activeTextObject.fontFamily) {
        selectionFontFamily = activeTextObject.fontFamily
      }
    } else {
      // No text selection - check if ALL characters have the same style without mutating the cursor
      const allStyles = textLength > 0 ? activeTextObject.getSelectionStyles(0, textLength) : []

      // Button lights up only if ALL characters have that style
      isSelectionBold = allStyles.length > 0 && allStyles.every((style) => style.fontWeight === 'bold')
      isSelectionItalic = allStyles.length > 0 && allStyles.every((style) => style.fontStyle === 'italic')
      isSelectionUnderlined = allStyles.length > 0 && allStyles.every((style) => style.underline === true)

      // Get font size - use first character or object default
      if (allStyles.length > 0 && allStyles[0].fontSize) {
        selectionFontSize = allStyles[0].fontSize
      } else if (activeTextObject.fontSize) {
        selectionFontSize = activeTextObject.fontSize
      }

      // Check for mixed fonts
      const fontFamilies = new Set(allStyles.map(style => style.fontFamily || activeTextObject.fontFamily))

      if (fontFamilies.size > 1) {
        selectionFontFamily = 'Multiple'
      } else if (allStyles.length > 0 && allStyles[0].fontFamily) {
        selectionFontFamily = allStyles[0].fontFamily
      } else if (activeTextObject.fontFamily) {
        selectionFontFamily = activeTextObject.fontFamily
      }

    }
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  /**
   * Creates a new, unsaved presentation with one blank slide.
   * Checks for unsaved changes before proceeding.
   */
  function handleNewPresentation(): void {
    // Check for unsaved changes before proceeding
    if (appState.isDirty) {
      const shouldProceed = confirm(
        'You have unsaved changes. Do you want to discard them and create a new presentation?'
      )
      if (!shouldProceed) return
    }

    // Create the new slide BEFORE resetting to prevent UI flicker
    const newSlide: Slide = { id: uuid_v4(), elements: [] }

    // Reset state and immediately assign the new slide
    // This ensures currentSlide is never null during the transition
    appState.slideIds = [newSlide.id]
    appState.currentSlide = newSlide
    appState.inMemorySlides = [newSlide]
    appState.currentSlideIndex = 0
    appState.currentFilePath = null
    appState.selectedObjectId = null
    appState.isDirty = false
  }

  /**
   * Opens a file dialog and loads the selected presentation.
   * Checks for unsaved changes before proceeding.
   */
  async function handleOpen(): Promise<void> {
    // Check for unsaved changes before proceeding
    if (appState.isDirty) {
      const shouldProceed = confirm(
        'You have unsaved changes. Do you want to discard them and open a different file?'
      )
      if (!shouldProceed) return
    }

    const filePath = await window.api.dialog.showOpenDialog()
    if (filePath) {
      try {
        await loadPresentation(filePath)
      } catch (error) {
        console.error('Failed to open presentation:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        alert(`Failed to open presentation: ${errorMessage}`)
      }
    }
  }

  /**
   * Saves the current slide to the existing file.
   * If no file is open, triggers Save As instead.
   * Prevents concurrent save operations using the isSaving flag.
   */
  async function handleSave(): Promise<void> {
    // If no file path, delegate to Save As (it will handle the isSaving flag)
    if (!appState.currentFilePath) {
      await handleSaveAs()
      return
    }

    // Prevent concurrent saves
    if (isSaving) return
    isSaving = true

    try {
      if (!appState.currentSlide || !appState.isDirty) return

      // Convert the reactive Svelte state to a plain JS object before sending to IPC
      const plainSlide = JSON.parse(JSON.stringify(appState.currentSlide))

      // Debug: Log what we're saving
      console.log('Saving slide with elements:', plainSlide.elements.length)
      plainSlide.elements.forEach((el: DeckElement) => {
        if (el.type === 'image') {
          console.log(`  Image ${el.id}: src length = ${el.src?.length || 0}`)
        }
      })

      // Save just the current slide to the existing file
      await window.api.db.saveSlide(appState.currentFilePath, plainSlide)

      // Reset the dirty flag
      appState.isDirty = false
      console.log('Saved to', appState.currentFilePath)
    } catch (error) {
      console.error('Save failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to save: ${errorMessage}`)
    } finally {
      isSaving = false
    }
  }

  /**
   * Opens a save dialog and saves all slides to a new file.
   * Works for both saved and unsaved presentations.
   * Prevents concurrent save operations using the isSaving flag.
   */
  async function handleSaveAs(): Promise<void> {
    // Prevent concurrent saves
    if (isSaving) return
    isSaving = true

    // Save original state in case we need to recover from an error
    const originalFilePath = appState.currentFilePath
    const originalSlideId = appState.currentSlide?.id

    try {
      const newPath = await window.api.dialog.showSaveDialog()
      if (!newPath) return

      // Remember which slide we're currently viewing so we can restore it
      const currentSlideId = appState.currentSlide?.id

      // If the target file already exists, close its connection first
      await window.api.db.closeConnection(newPath)

      // Collect all slides to save
      let slidesToSave: Slide[] = []
      if (appState.currentFilePath) {
        // Saved presentation: Load all slides from the database
        for (const slideId of appState.slideIds) {
          if (slideId === appState.currentSlide?.id) {
            // Use the current slide (with latest edits, even if unsaved)
            slidesToSave.push(appState.currentSlide)
          } else {
            // Load from database
            const slide = await window.api.db.getSlide(appState.currentFilePath, slideId)
            if (slide) {
              slidesToSave.push(slide)
            } else {
              console.error(`Failed to load slide ${slideId} from database during Save As`)
              throw new Error(`Failed to load slide ${slideId}. The database may be corrupted.`)
            }
          }
        }
      } else {
        // Unsaved presentation: First save current slide back to inMemorySlides to prevent data loss
        if (appState.currentSlide) {
          const currentIndex = appState.inMemorySlides.findIndex(
            (s) => s.id === appState.currentSlide!.id
          )
          if (currentIndex !== -1) {
            appState.inMemorySlides[currentIndex] = appState.currentSlide
          } else {
            // Slide not found in memory - add it to prevent data loss
            console.warn(`Current slide ${appState.currentSlide.id} not found in inMemorySlides, adding it`)
            appState.inMemorySlides.push(appState.currentSlide)
          }
        }

        // Build slides array manually to ensure current slide is included
        for (const slideId of appState.slideIds) {
          if (slideId === appState.currentSlide?.id) {
            // Use the current slide (with latest edits)
            slidesToSave.push(appState.currentSlide)
          } else {
            // Load from inMemorySlides
            const slide = appState.inMemorySlides.find((s) => s.id === slideId)
            if (slide) {
              slidesToSave.push(slide)
            } else {
              console.error(`Slide ${slideId} not found in inMemorySlides during Save As`)
              throw new Error(`Failed to find slide ${slideId} in memory. State may be corrupted.`)
            }
          }
        }
      }

      // Validate we have slides to save
      if (slidesToSave.length === 0) {
        throw new Error('No slides to save')
      }

      // Convert reactive Svelte state to plain JS objects for IPC
      let plainSlides: Slide[]
      try {
        plainSlides = JSON.parse(JSON.stringify(slidesToSave))
      } catch (serializationError) {
        console.error('Failed to serialize slides:', serializationError)
        throw new Error('Failed to serialize presentation data. Some elements may contain invalid data.')
      }

      // Debug: Log what we're saving
      console.log('Save As: Saving', plainSlides.length, 'slides')
      plainSlides.forEach((slide, i) => {
        console.log(`  Slide ${i}: ${slide.elements.length} elements`)
        slide.elements.forEach((el) => {
          if (el.type === 'image') {
            console.log(`    Image ${el.id}: src length = ${el.src?.length || 0}`)
          }
        })
      })

      // Save to new file
      try {
        await window.api.db.saveAs(newPath, plainSlides)
      } catch (saveError) {
        console.error('Failed to save to file:', saveError)
        const errorMessage = saveError instanceof Error ? saveError.message : 'Unknown error'
        throw new Error(`Failed to save presentation: ${errorMessage}`)
      }

      // Embed any pending fonts (from unsaved presentation) before reloading
      try {
        await embedPendingFonts(newPath)
      } catch (fontError) {
        console.error('Failed to embed fonts:', fontError)
        // Don't throw - fonts are non-critical, presentation is saved
      }

      // Reload the presentation from the new file
      try {
        await loadPresentation(newPath)
      } catch (loadError) {
        console.error('Failed to reload presentation after Save As:', loadError)
        // The file was saved successfully, but we failed to reload it
        // Try to recover by reloading the original file
        if (originalFilePath) {
          try {
            await loadPresentation(originalFilePath)
            alert(
              `Presentation was saved to ${newPath}, but failed to load the new file. Your original file has been reloaded.`
            )
            return
          } catch (recoveryError) {
            console.error('Failed to recover original file:', recoveryError)
          }
        }
        throw new Error('Presentation was saved, but failed to load the new file. Please try opening it manually.')
      }

      // Restore the slide the user was viewing
      if (currentSlideId && appState.slideIds.includes(currentSlideId)) {
        try {
          await loadSlide(currentSlideId)
        } catch (slideLoadError) {
          console.error('Failed to restore original slide:', slideLoadError)
          // Not critical - the presentation was saved successfully
          // Just log the error and continue
        }
      }
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
    } finally {
      isSaving = false
    }
  }

  /**
   * Keyboard shortcut handler for Cmd/Ctrl+S (Save)
   */
  keys.onKeys(['meta', 's'], async () => {
    if (!isSaving) await handleSave()
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
    if (family.startsWith('STIX') &&
        !['STIX Two Math', 'STIX Two Text'].includes(family)) return true

    // Symbol and dingbat fonts (cross-platform)
    const symbolFonts = [
      'Webdings', 'Wingdings', 'Wingdings 2', 'Wingdings 3',
      'Zapf Dingbats', 'Symbol',
      'Apple Symbols', 'Apple Braille',
      'OpenSymbol', 'Standard Symbols'
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
      const families = Array.from(new Set(systemFonts.map((f) => f.family)))
        .filter((family) => !shouldExcludeFont(family))
      availableFonts = [...new Set([...availableFonts, ...families])].sort()
      console.log(`Loaded ${families.length} system fonts (${systemFonts.length - families.length} filtered out)`)
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

      if (embeddedFonts.length > 0) {
        console.log(`Loaded ${embeddedFonts.length} embedded fonts from presentation (${embeddedFamilies.length} families)`)
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

  type FontBytes =
    | Buffer
    | ArrayBuffer
    | Uint8Array
    | { data: number[] }
    | { data: Uint8Array }

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
      console.log(`Injected font: ${fontFamily} (${variant})`)
    } catch (error) {
      console.error(`Failed to inject font ${fontFamily}:`, error)
    }
  }

  /**
   * Embeds a font file into the database.
   * Called when a user selects a font that hasn't been embedded yet.
   *
   * @param fontFamily - The font family name to embed
   */
  async function embedFontIfNeeded(fontFamily: string): Promise<void> {
    // For unsaved presentations, track fonts that need to be embedded later
    if (!appState.currentFilePath) {
      pendingFontsToEmbed.add(fontFamily)
      console.log(`Font ${fontFamily} will be embedded when presentation is saved`)
      // Still load the font for preview
      await loadFontForPreview(fontFamily)
      return
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
        await injectFontFace(fontData.fontFamily, fontData.fontData, fontData.format, fontData.variant)
        console.log(`Embedded and loaded font: ${fontFamily}`)
      }
    } catch (error) {
      console.error(`Failed to embed font ${fontFamily}:`, error)
    }
  }

  /**
   * Embeds all pending fonts into the database after a file is saved.
   * Called after Save As to embed fonts that were used in unsaved presentations.
   *
   * @param filePath - The path to the database file
   */
  async function embedPendingFonts(filePath: string): Promise<void> {
    if (pendingFontsToEmbed.size === 0) return

    console.log(`Embedding ${pendingFontsToEmbed.size} pending fonts...`)

    for (const fontFamily of pendingFontsToEmbed) {
      try {
        // Find the system font
        const systemFont = systemFonts.find((f) => f.family === fontFamily)
        if (!systemFont) {
          console.warn(`Font ${fontFamily} not found in system fonts, skipping embed`)
          continue
        }

        // Embed the font
        await window.api.fonts.embedFont(
          filePath,
          systemFont.path,
          fontFamily,
          'normal-normal'
        )
        console.log(`Embedded pending font: ${fontFamily}`)
      } catch (error) {
        console.error(`Failed to embed pending font ${fontFamily}:`, error)
      }
    }

    // Clear the pending list
    pendingFontsToEmbed.clear()
  }

  /**
   * Loads a system font for preview in the font dropdown (without embedding in DB).
   *
   * @param fontFamily - The font family name to load for preview
   */
  async function loadFontForPreview(fontFamily: string): Promise<void> {
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
      await new Promise(resolve => setTimeout(resolve, 10))
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
      fontSearchQuery = ''
      // Load the currently selected font and a few common ones
      if (selectionFontFamily !== 'Multiple') {
        queueFontForLoading(selectionFontFamily)
      }
      const commonFonts = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana']
      commonFonts.forEach(font => queueFontForLoading(font))
    }
  }

  /**
   * Selects a font from the custom dropdown
   */
  async function selectFontFromDropdown(fontFamily: string): Promise<void> {
    console.log('🎯 selectFontFromDropdown called', { fontFamily, hasActiveText: !!activeTextObject })
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
    return availableFonts.filter(font => font.toLowerCase().includes(query))
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
      fill: '#333333'
    }
    appState.currentSlide.elements.push(newText)
    appState.isDirty = true
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
      fill: '#FF6F61'
    }
    appState.currentSlide.elements.push(newRect)
    appState.isDirty = true
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
        filename: imageData.filename
      }

      appState.currentSlide.elements.push(newImage)
      appState.isDirty = true
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
    const newSlide: Slide = { id: uuid_v4(), elements: [] }
    if (appState.currentFilePath) {
      // Saved presentation: save slide to database with error handling
      try {
        // Save the new slide to the database
        await window.api.db.saveSlide(appState.currentFilePath, newSlide)

        // Update slideIds only after successful save
        appState.slideIds = [...appState.slideIds, newSlide.id]

        // Load the new slide
        await loadSlide(newSlide.id)
      } catch (error) {
        console.error('Failed to create new slide:', error)

        // Roll back slideIds if it was added but loading failed
        appState.slideIds = appState.slideIds.filter((id) => id !== newSlide.id)

        // Show user-friendly error message
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        alert(`Failed to create new slide: ${errorMessage}`)
      }
    } else {
      // Unsaved presentation: save current slide back to memory before switching
      if (appState.currentSlide) {
        const currentIndex = appState.inMemorySlides.findIndex(
          (s) => s.id === appState.currentSlide!.id
        )
        if (currentIndex !== -1) {
          // Deep copy to prevent reference issues
          appState.inMemorySlides[currentIndex] = JSON.parse(JSON.stringify(appState.currentSlide))
        }
      }

      // Add new slide to in-memory array
      appState.inMemorySlides.push(newSlide)
      appState.slideIds = [...appState.slideIds, newSlide.id]
      appState.currentSlide = newSlide
      appState.currentSlideIndex = appState.slideIds.length - 1
    }
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
    }
  }

  // ============================================================================
  // Keyboard and Mouse Event Handlers
  // ============================================================================

  /**
   * Global keyboard event handler for shortcuts.
   * Handles Cmd/Ctrl+A (Select All) and Delete/Backspace (Delete object).
   */
  function handleKeyDown(event: KeyboardEvent): void {
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
  function handleContextMenu(event: MouseEvent): void {
    event.preventDefault()
    if (!fabCanvas) return

    const target = fabCanvas.findTarget(event)
    if (target) {
      // Object was clicked - select it and show context menu
      if (!fabCanvas.getActiveObjects().includes(target)) {
        fabCanvas.discardActiveObject()
        fabCanvas.setActiveObject(target)
        fabCanvas.requestRenderAll()
      }
      contextMenuPosition = { x: event.clientX, y: event.clientY }
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
   * Preserves the current slide state for unsaved presentations.
   */
  async function enterPresentationMode(): Promise<void> {
    // Save a snapshot of current slide state (for unsaved presentations)
    if (appState.currentSlide) {
      slideStateBeforePresentation = {
        slideId: appState.currentSlide.id,
        elements: JSON.parse(JSON.stringify(appState.currentSlide.elements))
      }
    }

    // For unsaved presentations, sync current slide to inMemorySlides before presenting
    if (!appState.currentFilePath && appState.currentSlide) {
      const currentIndex = appState.inMemorySlides.findIndex(
        (s) => s.id === appState.currentSlide!.id
      )
      if (currentIndex !== -1) {
        appState.inMemorySlides[currentIndex] = JSON.parse(JSON.stringify(appState.currentSlide))
      }
    }

    // Save to file if dirty and has file path
    if (appState.isDirty && appState.currentFilePath) {
      await handleSave()
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
</script>

<svelte:window onkeydown={handleKeyDown} onclick={hideContextMenu} />

{#if appState.isPresentingMode}
  <!-- Presentation Mode (Fullscreen) -->
  <PresentationView onExit={exitPresentationMode} />
{:else if appState.currentSlide}
  <div
    class="flex flex-col h-screen font-sans"
    oncontextmenu={handleContextMenu}
    role="application"
  >
    {#if contextMenuVisible}
      <ContextMenu
        x={contextMenuPosition.x}
        y={contextMenuPosition.y}
        onDelete={() => {
          deleteSelectedObject()
          hideContextMenu()
        }}
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
        disabled={!appState.isDirty && appState.currentFilePath !== null}
      >
        Save
      </button>
      <button
        onclick={handleSaveAs}
        class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
      >
        Save As
      </button>
      <div class="h-6 w-px bg-gray-300 mx-2"></div>
      <button
        onclick={enterPresentationMode}
        class="px-3 py-1 mr-2 text-sm font-medium text-white bg-indigo-600 border border-indigo-600 rounded-md hover:bg-indigo-700"
        title="Start presentation (F5)"
      >
        Present
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
            style={selectionFontFamily !== 'Multiple' ? `font-family: ${selectionFontFamily}` : ''}
          >
            <span class="truncate" class:italic={selectionFontFamily === 'Multiple'} class:text-gray-500={selectionFontFamily === 'Multiple'}>
              {selectionFontFamily}
            </span>
            <svg class="w-4 h-4 absolute right-1 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
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
                    style="font-family: '{font}'; contain: layout style;"
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
          oninput={changeSelectionColor}
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
            onclick={async () => await loadSlide(slideId)}
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
      <PropertiesPanel />
    </div>
  </div>
{:else}
  <div class="flex items-center justify-center h-screen">
    <p class="text-lg text-gray-500">Starting...</p>
  </div>
{/if}
