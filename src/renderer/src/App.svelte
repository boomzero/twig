<script lang="ts">
  import {
    Canvas,
    type FabricObject,
    IText,
    Rect,
    ActiveSelection,
    util,
    BaseFabricObject
  } from 'fabric'
  import { appState } from './lib/state.svelte'
  import type { SelectionState } from './lib/state.svelte'
  import { v4 as uuid_v4 } from 'uuid'
  import PropertiesPanel from './components/PropertiesPanel.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import { PressedKeys } from 'runed'
  import type { DeckElement, Slide, Presentation } from '../../../types'
  import { onMount } from 'svelte'

  let canvasEl: HTMLCanvasElement
  let fabCanvas: Canvas | undefined
  let activeTextObject: IText | null = null
  let showRichTextControls = $state(false)
  let isSelectionBold = $state(false)
  let isSelectionItalic = $state(false)
  let isSelectionUnderlined = $state(false)
  let selectionRangeToRestore: { start: number; end: number } | null = null
  let wasEditing = false
  const keys = new PressedKeys()

  let contextMenuVisible = $state(false)
  let contextMenuPosition = $state({ x: 0, y: 0 })

  type DeckFabricObject = FabricObject & { id?: string }

  // Set the default origin for all Fabric objects to center
  BaseFabricObject.ownDefaults.originY = 'center'
  BaseFabricObject.ownDefaults.originX = 'center'

  // Initialize with a default empty slide
  function initializeNewPresentation(): void {
    const newSlideId = `slide_${uuid_v4()}`
    appState.slides = [{ id: newSlideId, slideNumber: 1 }]
    appState.activeSlide = { id: newSlideId, slideNumber: 1, elements: [] }
    appState.currentFilePath = null
  }

  onMount(() => {
    initializeNewPresentation()
  })

  // This function renders our state to the canvas
  function renderCanvasFromState(): void {
    if (!fabCanvas) return

    // Temporarily disable event listeners to prevent infinite loops
    fabCanvas.off('object:modified', handleObjectModified)
    fabCanvas.off('selection:created', handleSelection)
    fabCanvas.off('selection:updated', handleSelection)
    fabCanvas.off('selection:cleared', handleSelectionCleared)

    fabCanvas.clear()
    if (appState.activeSlide) {
      appState.activeSlide.elements.forEach((element) => {
        let fabObj: FabricObject | undefined
        if (element.type === 'rect') {
          fabObj = new Rect({ ...element, id: element.id })
        } else if (element.type === 'text') {
          fabObj = new IText(element.text || 'Hello', {
            ...element,
            id: element.id,
            styles: element.styles || {}
          })
        }
        if (fabObj) {
          fabCanvas.add(fabObj)
        }
      })
    }
    fabCanvas.renderAll()

    // Re-enable event listeners
    fabCanvas.on('object:modified', handleObjectModified)
    fabCanvas.on('selection:created', handleSelection)
    fabCanvas.on('selection:updated', handleSelection)
    fabCanvas.on('selection:cleared', handleSelectionCleared)
  }

  async function handleObjectModified(event: {
    target?: DeckFabricObject | ActiveSelection
  }): Promise<void> {
    const target = event.target
    if (!target) return

    const updatePromises: Promise<any>[] = []

    if (target.type === 'activeselection') {
      const selection = target as ActiveSelection
      selection.getObjects().forEach((obj) => {
        const modifiedObject = obj as DeckFabricObject
        const updates = getUpdatesFromObject(modifiedObject)
        if (updates) {
          // Optimistically update local state
          const elementInState = appState.activeSlide?.elements.find((el) => el.id === updates.id)
          if (elementInState) Object.assign(elementInState, updates)
          // Send update to main process
          updatePromises.push(window.api.updateElement(updates.id, updates))
        }
      })
    } else {
      const updates = getUpdatesFromObject(target as DeckFabricObject)
      if (updates) {
        // Optimistically update local state
        const elementInState = appState.activeSlide?.elements.find((el) => el.id === updates.id)
        if (elementInState) Object.assign(elementInState, updates)
        // Send update to main process
        updatePromises.push(window.api.updateElement(updates.id, updates))
      }
    }

    await Promise.all(updatePromises)
  }

  function getUpdatesFromObject(obj: DeckFabricObject): Partial<DeckElement> | null {
    if (!obj.id || !obj.width) return null

    const transform = util.qrDecompose(obj.calcTransformMatrix())
    const updates: Partial<DeckElement> = {
      id: obj.id,
      x: transform.translateX,
      y: transform.translateY,
      angle: transform.angle,
      width: obj.width * transform.scaleX,
      height: obj.height * transform.scaleY
    }

    if (obj instanceof IText) {
      updates.text = obj.text
      updates.fontSize = obj.fontSize
      updates.fontFamily = obj.fontFamily
      updates.styles = obj.styles
    }
    return updates
  }

  function handleSelection(event: { selected?: DeckFabricObject[] }): void {
    appState.selectedObjectId =
      event.selected && event.selected.length === 1 ? event.selected[0].id || null : null

    activeTextObject?.off('selection:changed', handleTextSelectionChange)
    const selection = event.selected?.[0]
    if (selection instanceof IText) {
      activeTextObject = selection
      showRichTextControls = true
      if (wasEditing) {
        activeTextObject.enterEditing()
        wasEditing = false
      }
      activeTextObject.on('selection:changed', handleTextSelectionChange)
      handleTextSelectionChange()
    } else {
      activeTextObject = null
      showRichTextControls = false
    }
  }

  function handleSelectionCleared(): void {
    appState.selectedObjectId = null
    activeTextObject = null
    showRichTextControls = false
  }

  $effect(() => {
    let selectionStateToRestore: SelectionState | null = null
    if (fabCanvas) {
      const activeObject = fabCanvas.getActiveObject()
      if (activeObject) {
        const selectedObjectIds =
          activeObject.type === 'activeselection'
            ? (activeObject as ActiveSelection).getObjects().map((o) => (o as DeckFabricObject).id!)
            : [(activeObject as DeckFabricObject).id!]
        selectionStateToRestore = { selectedObjectIds }
        if (activeObject instanceof IText) {
          selectionRangeToRestore = {
            start: activeObject.selectionStart!,
            end: activeObject.selectionEnd!
          }
          wasEditing = activeObject.isEditing
        }
      }
    }

    if (!fabCanvas) {
      fabCanvas = new Canvas(canvasEl)
    }
    renderCanvasFromState()

    if (selectionStateToRestore && fabCanvas) {
      const objectsToSelect = fabCanvas
        .getObjects()
        .filter((o) => selectionStateToRestore!.selectedObjectIds.includes((o as any).id!))
      if (objectsToSelect.length > 0) {
        fabCanvas.setActiveObject(
          objectsToSelect.length === 1
            ? objectsToSelect[0]
            : new ActiveSelection(objectsToSelect, { canvas: fabCanvas })
        )
        fabCanvas.renderAll()
      }
    }
  })

  async function applyStyleToSelection(style: Record<string, any>): Promise<void> {
    if (activeTextObject) {
      activeTextObject.setSelectionStyles(style)
      handleTextSelectionChange()
      fabCanvas?.renderAll()
      const updates = getUpdatesFromObject(activeTextObject)
      if (updates) {
        await window.api.updateElement(updates.id!, updates)
      }
    }
  }

  function toggleBold(): void {
    applyStyleToSelection({ fontWeight: isSelectionBold ? 'normal' : 'bold' })
  }

  function toggleItalic(): void {
    applyStyleToSelection({ fontStyle: isSelectionItalic ? 'normal' : 'italic' })
  }

  function toggleUnderline(): void {
    applyStyleToSelection({ underline: !isSelectionUnderlined })
  }

  function changeSelectionColor(event: Event): void {
    const color = (event.target as HTMLInputElement).value
    applyStyleToSelection({ fill: color })
  }

  function handleTextSelectionChange(): void {
    if (activeTextObject) {
      const styles = activeTextObject.getSelectionStyles()
      isSelectionBold = styles.some((s) => s.fontWeight === 'bold')
      isSelectionItalic = styles.some((s) => s.fontStyle === 'italic')
      isSelectionUnderlined = styles.some((s) => s.underline === true)
    }
  }

  async function addElement(type: 'rect' | 'text'): Promise<void> {
    if (!appState.activeSlide) return
    const newElement: DeckElement =
      type === 'rect'
        ? {
            type: 'rect',
            id: `rect_${uuid_v4()}`,
            x: 100,
            y: 100,
            width: 150,
            height: 100,
            angle: 0,
            fill: '#FF6F61'
          }
        : {
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

    // Optimistically update UI
    appState.activeSlide.elements.push(newElement)
    // Persist change
    await window.api.createElement(appState.activeSlide.id, newElement)
  }

  async function deleteSelectedObject(): Promise<void> {
    if (!fabCanvas || !appState.activeSlide) return
    const activeObjects = fabCanvas.getActiveObjects()
    if (activeObjects.length === 0) return

    const idsToDelete = activeObjects.map((obj) => (obj as DeckFabricObject).id).filter(Boolean)
    if (idsToDelete.length > 0) {
      appState.activeSlide.elements = appState.activeSlide.elements.filter(
        (el) => !idsToDelete.includes(el.id)
      )
      fabCanvas.discardActiveObject()
      await window.api.deleteElements(idsToDelete as string[])
    }
  }

  async function handleSaveAs(): Promise<void> {
    let presentationToSave: Presentation | null = null

    // If the file is new, we need to send the current state to be saved.
    if (!appState.currentFilePath) {
      const allSlides: Slide[] = []
      for (const slideInfo of appState.slides) {
        if (appState.activeSlide && appState.activeSlide.id === slideInfo.id) {
          allSlides.push(appState.activeSlide)
          continue
        }
        const result = await window.api.getElementsForSlide(slideInfo.id)
        if (result.success && result.data) {
          allSlides.push({ ...slideInfo, elements: result.data })
        }
      }
      presentationToSave = { slides: allSlides }
    }

    const result = await window.api.saveAs(presentationToSave)

    if (result.success && result.path) {
      appState.currentFilePath = result.path
      console.log('File saved to:', result.path)
    } else if (result.error !== 'Save was cancelled.') {
      console.error('Save As failed:', result.error)
    }
  }

  async function handleOpen(): Promise<void> {
    const result = await window.api.openDeck()
    if (result.success && result.data) {
      appState.slides = result.data.slides
      appState.currentFilePath = result.data.filePath
      if (appState.slides.length > 0) {
        await selectSlide(appState.slides[0].id)
      } else {
        appState.activeSlide = null // No slides in presentation
      }
    } else if (result.error) {
      console.error('Open failed:', result.error)
    }
  }

  async function selectSlide(slideId: string): Promise<void> {
    const result = await window.api.getElementsForSlide(slideId)
    if (result.success && result.data) {
      const slideInfo = appState.slides.find(s => s.id === slideId)
      if (slideInfo) {
        appState.activeSlide = { ...slideInfo, elements: result.data }
      }
    }
  }

  function handleContextMenu(event: MouseEvent): void {
    event.preventDefault()
    if (!fabCanvas) return

    const target = fabCanvas.findTarget(event)
    if (target) {
      if (!fabCanvas.getActiveObjects().includes(target)) {
        fabCanvas.discardActiveObject()
        fabCanvas.setActiveObject(target)
        fabCanvas.requestRenderAll()
      }
      contextMenuPosition = { x: event.clientX, y: event.clientY }
      contextMenuVisible = true
    } else {
      fabCanvas.discardActiveObject()
      fabCanvas.requestRenderAll()
      contextMenuVisible = false
    }
  }

  function hideContextMenu(): void {
    contextMenuVisible = false
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      event.preventDefault()
      if (fabCanvas) {
        const allObjects = fabCanvas.getObjects()
        if (allObjects.length > 0) {
          fabCanvas.setActiveObject(new ActiveSelection(allObjects, { canvas: fabCanvas }))
          fabCanvas.renderAll()
        }
      }
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (activeTextObject && activeTextObject.isEditing) return
      event.preventDefault()
      deleteSelectedObject()
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} onclick={hideContextMenu} />

<div class="flex flex-col h-screen font-sans" oncontextmenu={handleContextMenu} role="application">
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
      onclick={() => addElement('rect')}
      class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
    >
      Add Shape
    </button>
    <button
      onclick={() => addElement('text')}
      class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
    >
      Add Text
    </button>
    <button
      onclick={handleSaveAs}
      class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
    >
      Save As
    </button>
    <button
      onclick={handleOpen}
      class="px-3 py-1 mr-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
    >
      Open
    </button>
    {#if showRichTextControls}
      <div class="h-6 w-px bg-gray-300 mx-2"></div>
      <button
        onclick={toggleBold}
        class="w-8 h-8 flex items-center justify-center font-bold text-sm rounded-md border border-gray-300 mr-1"
        class:bg-indigo-200={isSelectionBold}
        class:text-white={isSelectionBold}
      >
        B
      </button>
      <button
        onclick={toggleItalic}
        class="w-8 h-8 flex items-center justify-center italic text-sm rounded-md border border-gray-300 mr-1"
        class:bg-indigo-200={isSelectionItalic}
        class:text-white={isSelectionItalic}
      >
        I
      </button>
      <button
        onclick={toggleUnderline}
        class="w-8 h-8 flex items-center justify-center underline text-sm rounded-md border border-gray-300 mr-1"
        class:bg-indigo-200={isSelectionUnderlined}
        class:text-white={isSelectionUnderlined}
      >
        U
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
      {#each appState.slides as slide, i (slide.id)}
        <button
          type="button"
          class="w-full p-2 mb-2 text-sm text-center bg-white border rounded-md shadow-md cursor-pointer"
          class:border-indigo-500={slide.id === appState.activeSlide?.id}
          class:border-gray-400={slide.id !== appState.activeSlide?.id}
          onclick={() => selectSlide(slide.id)}
        >
          Slide {i + 1}
        </button>
      {/each}
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
