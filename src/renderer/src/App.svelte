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
  import type { DeckElement, SelectionState } from './lib/state.svelte'
  import { v4 as uuid_v4 } from 'uuid'
  import PropertiesPanel from './components/PropertiesPanel.svelte'

  let canvasEl: HTMLCanvasElement
  let fabCanvas: Canvas | undefined
  let activeTextObject: IText | null = null
  let showRichTextControls = $state(false)
  let isSelectionBold = $state(false)
  let selectionRangeToRestore: { start: number; end: number } | null = null
  let wasEditing = false

  type DeckFabricObject = FabricObject & { id?: string }

  //Set the default origin for all Fabric objects to center
  //Ref https://github.com/fabricjs/fabric.js/discussions/9736
  BaseFabricObject.ownDefaults.originY = 'center'
  BaseFabricObject.ownDefaults.originX = 'center'

  // This function renders our state to the canvas
  function renderCanvasFromState(): void {
    if (!fabCanvas) return
    const currentSlide = appState.presentation.slides[0]

    // Temporarily disable event listeners while we re-render from state
    // to prevent infinite loops.
    fabCanvas.off('object:modified', handleObjectModified)
    fabCanvas.off('selection:created', handleSelection)
    fabCanvas.off('selection:updated', handleSelection)
    fabCanvas.off('selection:cleared', handleSelectionCleared)

    fabCanvas.clear()
    if (currentSlide) {
      currentSlide.elements.forEach((element) => {
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
          fabObj = new IText(element.text || 'Hello', {
            left: element.x,
            top: element.y,
            angle: element.angle,
            id: element.id,
            fill: element.fill, // Default fill color
            fontFamily: element.fontFamily,
            fontSize: element.fontSize,
            styles: element.styles || {} // Apply the rich text styles object
          })
        }
        if (fabObj) {
          fabCanvas.add(fabObj)
        }
      })
    }
    fabCanvas.renderAll()

    // Re-enable the event listener after rendering is complete
    fabCanvas.on('object:modified', handleObjectModified)
    fabCanvas.on('selection:created', handleSelection)
    fabCanvas.on('selection:updated', handleSelection)
    fabCanvas.on('selection:cleared', handleSelectionCleared)
  }

  function handleObjectModified(event: { target?: DeckFabricObject | ActiveSelection }): void {
    const target = event.target
    if (!target) return
    //Check if the modified object is a group selection
    if (target.type === 'activeselection') {
      const selection = target as ActiveSelection
      // Iterate over each object in the group
      selection.getObjects().forEach((obj) => {
        const modifiedObject = obj as DeckFabricObject
        console.log(modifiedObject)
        updateStateFromObject(modifiedObject)
      })
    } else {
      // Otherwise, it's a single object
      updateStateFromObject(target as DeckFabricObject)
    }
  }

  function updateStateFromObject(obj: DeckFabricObject): void {
    if (!obj.id || !obj.width) return // Guard against objects without id or width

    const elementInState = appState.presentation.slides[0]?.elements.find((el) => el.id === obj.id)
    if (!elementInState) return

    // Use matrix decomposition to get absolute, final values
    const transform = util.qrDecompose(obj.calcTransformMatrix())

    // Update state with the decomposed values
    elementInState.x = transform.translateX
    elementInState.y = transform.translateY
    elementInState.angle = transform.angle
    // The original width/height must be multiplied by the new scale
    elementInState.width = obj.width * transform.scaleX
    elementInState.height = obj.height * transform.scaleY
    if (elementInState.type === 'text' && obj instanceof IText) {
      elementInState.text = obj.text
      elementInState.fontSize = obj.fontSize
      elementInState.fontFamily = obj.fontFamily
      elementInState.styles = obj.styles
    }
  }

  function handleSelection(event: { selected?: DeckFabricObject[] }): void {
    console.log('handleSelection. selectionRangeToRestore:', selectionRangeToRestore)
    //Only show properties if exactly ONE object is selected
    if (event.selected && event.selected.length === 1) {
      appState.selectedObjectId = event.selected[0].id || null
    } else {
      appState.selectedObjectId = null
    }

    activeTextObject?.off('selection:changed', handleTextSelectionChange)

    const selection = event.selected?.[0]
    if (selection instanceof IText) {
      activeTextObject = selection
      showRichTextControls = true
      if (wasEditing) {
        activeTextObject.enterEditing()
        wasEditing = false // Reset the flag
      }
      activeTextObject.on('selection:changed', handleTextSelectionChange)
      handleTextSelectionChange()
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
      activeTextObject = null
      showRichTextControls = false
      isSelectionBold = false
      wasEditing = false
    }
  }

  function handleSelectionCleared(): void {
    activeTextObject?.off('selection:changed', handleTextSelectionChange)
    appState.selectedObjectId = null
    activeTextObject = null
    showRichTextControls = false
    isSelectionBold = false
    wasEditing = false
  }

  $effect(() => {
    console.log('$effect running. selectionRangeToRestore:', selectionRangeToRestore)
    let selectionStateToRestore: SelectionState | null = null
    // Save selection
    if (fabCanvas) {
      const activeObject = fabCanvas.getActiveObject()
      if (activeObject) {
        const selectedObjectIds =
          activeObject.type === 'activeselection'
            ? (activeObject as ActiveSelection).getObjects().map((o) => o.id!)
            : [activeObject.id!]

        selectionStateToRestore = {
          selectedObjectIds: selectedObjectIds
        }

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

    // Restore selection
    if (selectionStateToRestore && fabCanvas) {
      const objectsToSelect = fabCanvas
        .getObjects()
        .filter((o) => selectionStateToRestore!.selectedObjectIds.includes(o.id!))

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyStyleToSelection(style: Record<string, any>): void {
    console.log('applyStyleToSelection called with', style)
    if (activeTextObject) {
      activeTextObject.setSelectionStyles(style)
      // After applying, immediately re-check the selection state
      handleTextSelectionChange()
      fabCanvas?.renderAll()
      updateStateFromObject(activeTextObject)
    }
  }
  function toggleBold(): void {
    console.log('toggleBold called')
    //The logic is now simpler: just toggle based on our reactive state variable
    applyStyleToSelection({ fontWeight: isSelectionBold ? 'normal' : 'bold' })
  }

  function changeSelectionColor(event: Event): void {
    const color = (event.target as HTMLInputElement).value
    applyStyleToSelection({ fill: color })
  }

  function handleTextSelectionChange(): void {
    if (activeTextObject) {
      console.log(
        'handleTextSelectionChange. Selection:',
        activeTextObject?.selectionStart,
        activeTextObject?.selectionEnd
      )
      const styles = activeTextObject.getSelectionStyles()
      // Check if fontWeight is bold. If multiple styles are selected, it might be partially bold.
      // Fabric returns an empty object for a simple cursor, so we default to false.
      isSelectionBold = styles.length > 0 && styles.some((style) => style.fontWeight === 'bold')
    }
  }

  function addText(): void {
    const newText: DeckElement = {
      type: 'text',
      id: `text_${uuid_v4()}`,
      x: 250,
      y: 150,
      width: 200,
      height: 50, // Note: width/height for text is auto-managed
      angle: 0,
      text: 'Double-click to edit',
      fontSize: 40,
      fontFamily: 'Inter',
      fill: '#333333'
    }
    appState.presentation.slides[0].elements.push(newText)
  }

  function addRectangle(): void {
    const newRect: DeckElement = {
      type: 'rect',
      id: `rect_${uuid_v4()}`,
      x: 50,
      y: 50,
      width: 150,
      height: 100,
      angle: 0,
      fill: '#FF6F61'
    }

    appState.presentation.slides[0].elements.push(newRect)
  }

  async function handleSave(): Promise<void> {
    // Convert the reactive state to a plain JavaScript object
    if (appState.currentFilePath) {
      const presentationData = { ...appState.presentation }
      const jsonString = JSON.stringify(presentationData, null, 2)
      const result = await window.api.saveDeck(jsonString, appState.currentFilePath)
      if (result.success) {
        console.log('File saved to:', result.path)
      } else {
        console.error('Save failed:', result.error)
      }
    } else {
      await handleSaveAs()
    }
  }

  async function handleSaveAs(): Promise<void> {
    // Convert the reactive state to a plain JavaScript object
    const presentationData = { ...appState.presentation }
    const jsonString = JSON.stringify(presentationData, null, 2) // Pretty print JSON
    const result = await window.api.saveAsDeck(jsonString)
    if (result.success) {
      console.log('File saved to:', result.path)
      appState.currentFilePath = result.path
    } else {
      console.error('Save failed:', result.error)
    }
  }

  async function handleOpen(): Promise<void> {
    const result = await window.api.openDeck()
    if (result.success && result.data) {
      try {
        const openedPresentation = JSON.parse(result.data)
        // Replace the entire state with the loaded data
        appState.presentation.slides = openedPresentation.slides || []
        if (result.path) {
          appState.currentFilePath = result.path
        }
      } catch (error) {
        console.error('Failed to parse presentation data:', error)
      }
    } else if (result.error) {
      console.error('Open failed:', result.error)
    }
  }
</script>

<div class="flex flex-col h-screen font-sans">
  <div class="flex items-center p-2 bg-gray-100 border-b border-gray-300 shadow-sm">
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
        class="px-3 py-1 font-bold text-sm rounded-md border border-gray-300"
        class:bg-indigo-200={isSelectionBold}
        class:text-white={isSelectionBold}>B</button
      >
      <input
        type="color"
        oninput={changeSelectionColor}
        class="w-8 h-8 p-0 border-none bg-transparent"
      />
    {/if}
  </div>
  <div class="flex flex-1 overflow-hidden">
    <div class="w-48 p-2 overflow-y-auto bg-gray-50 border-r border-gray-300">
      <div
        class="p-2 mb-2 text-sm text-center bg-white border border-gray-400 rounded-md shadow-md cursor-pointer hover:border-indigo-500"
      >
        Slide 1
      </div>
    </div>
    <div class="flex-1 p-4 bg-gray-200">
      <div class="flex items-center justify-center h-full">
        <div class="bg-white shadow-lg">
          <canvas bind:this={canvasEl} width="800" height="600"></canvas>
        </div>
      </div>
    </div>
    <PropertiesPanel />
  </div>
</div>
