<script lang="ts">
  import { Canvas, Rect } from 'fabric'
  import { appState } from './lib/state.svelte'
  import type { DeckElement } from './lib/state.svelte'
  import { v4 as uuid_v4 } from 'uuid'

  let canvasEl: HTMLCanvasElement
  let fabCanvas: Canvas | undefined

  $effect(() => {
    // If the canvas doesn't exist yet, create it.
    if (!fabCanvas) {
      fabCanvas = new Canvas(canvasEl)
    }
    const currentSlide = appState.presentation.slides[0]
    if (currentSlide) {
      fabCanvas.clear()
      currentSlide.elements.forEach((element) => {
        if (element.type === 'rect') {
          const rect = new Rect({
            left: element.x,
            top: element.y,
            width: element.width,
            height: element.height,
            fill: element.fill
          })
          fabCanvas.add(rect)
        }
      })
      fabCanvas.renderAll()
    }
  })

  function addRectangle() {
    const newRect: DeckElement = {
      type: 'rect',
      id: `rect_${uuid_v4()}`,
      x: 50,
      y: 50,
      width: 150,
      height: 100,
      fill: 'purple'
    }

    appState.presentation.slides[0].elements.push(newRect)
  }

  async function handleSave() {
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
      await handleSaveAs();
    }
  }
  async function handleSaveAs() {
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

  async function handleOpen() {
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
  </div>
</div>
