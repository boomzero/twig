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
    ActiveSelection,
    util,
    BaseFabricObject
  } from 'fabric'
  import PropertiesPanel from './components/PropertiesPanel.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
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
  let selectionRangeToRestore: { start: number; end: number } | null = null
  let wasEditing = false

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
  onMount(() => {
    handleNewPresentation()
  })

  /**
   * Reactive effect that tracks changes to the current slide.
   * Marks the presentation as "dirty" (unsaved) when the slide is modified.
   * Uses a flag to avoid marking as dirty during initial render.
   */
  let isInitialSlideLoad = true
  $effect(() => {
    if (appState.currentSlide) {
      if (isInitialSlideLoad) {
        isInitialSlideLoad = false
        // Don't mark dirty on initial render
      } else {
        appState.isDirty = true
      }
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
    if (!appState.currentSlide) {
      fabCanvas?.clear()
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
    currentSlide.elements.forEach((element) => {
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
    if (event.selected && event.selected.length === 1) {
      appState.selectedObjectId = event.selected[0].id || null
    } else {
      appState.selectedObjectId = null
    }

    // Remove old text selection change listener
    activeTextObject?.off('selection:changed', handleTextSelectionChange)

    const selection = event.selected?.[0]
    if (selection instanceof IText) {
      // Text object selected - enable rich text controls
      activeTextObject = selection
      showRichTextControls = true

      // If user was editing before, restore editing mode
      if (wasEditing) {
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
    wasEditing = false
  }

  // ============================================================================
  // Rich Text Formatting
  // ============================================================================

  /**
   * Applies a style to the currently selected text range.
   */
  function applyStyleToSelection(style: Record<string, string | number | boolean>): void {
    if (activeTextObject) {
      activeTextObject.setSelectionStyles(style)
      handleTextSelectionChange()
      fabCanvas?.renderAll()
      updateStateFromObject(activeTextObject)
    }
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

  /**
   * Updates the formatting button states based on the current text selection.
   * Checks if the selected text has bold, italic, or underline formatting.
   */
  function handleTextSelectionChange(): void {
    if (activeTextObject) {
      const styles = activeTextObject.getSelectionStyles()
      isSelectionBold = styles.length > 0 && styles.some((style) => style.fontWeight === 'bold')
      isSelectionItalic = styles.length > 0 && styles.some((style) => style.fontStyle === 'italic')
      isSelectionUnderlined = styles.length > 0 && styles.some((style) => style.underline === true)
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
    // Prevent concurrent saves
    if (isSaving) return
    isSaving = true

    try {
      if (!appState.currentFilePath) {
        await handleSaveAs()
        return
      }
      if (!appState.currentSlide || !appState.isDirty) return

      // Convert the reactive Svelte state to a plain JS object before sending to IPC
      const plainSlide = JSON.parse(JSON.stringify(appState.currentSlide))

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

      // Save to new file
      try {
        await window.api.db.saveAs(newPath, plainSlides)
      } catch (saveError) {
        console.error('Failed to save to file:', saveError)
        const errorMessage = saveError instanceof Error ? saveError.message : 'Unknown error'
        throw new Error(`Failed to save presentation: ${errorMessage}`)
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
      fontFamily: 'Inter',
      fill: '#333333'
    }
    appState.currentSlide.elements.push(newText)
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
          appState.inMemorySlides[currentIndex] = appState.currentSlide
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
</script>

<svelte:window onkeydown={handleKeyDown} onclick={hideContextMenu} />

{#if appState.currentSlide}
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
        disabled={!appState.isDirty}
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
