<script lang="ts">
  import { appState } from '../lib/state.svelte'
  import type { DeckElement } from '../../../types'

  const selectedObject = $derived(
    appState.activeSlide?.elements.find((el) => el.id === appState.selectedObjectId)
  )

  let debounceTimer: ReturnType<typeof setTimeout>
  function handleUpdate(updates: Partial<DeckElement>) {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (selectedObject) {
        window.api.updateElement(selectedObject.id, updates)
      }
    }, 300)
  }
</script>

<div class="p-4 bg-gray-50 border-l border-gray-300 basis-64">
  <h3 class="text-lg font-semibold mb-4">Properties</h3>

  {#if selectedObject}
    <div class="space-y-3">
      <div>
        <label for="x" class="block text-sm font-medium text-gray-600">X Position</label>
        <input
          type="number"
          id="x"
          value={selectedObject.x}
          oninput={(e) => {
            const newValue = (e.target as HTMLInputElement).valueAsNumber
            selectedObject.x = newValue
            handleUpdate({ x: newValue })
          }}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="y" class="block text-sm font-medium text-gray-600">Y Position</label>
        <input
          type="number"
          id="y"
          value={selectedObject.y}
          oninput={(e) => {
            const newValue = (e.target as HTMLInputElement).valueAsNumber
            selectedObject.y = newValue
            handleUpdate({ y: newValue })
          }}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="width" class="block text-sm font-medium text-gray-600">Width</label>
        <input
          type="number"
          id="width"
          value={selectedObject.width}
          oninput={(e) => {
            const newValue = (e.target as HTMLInputElement).valueAsNumber
            selectedObject.width = newValue
            handleUpdate({ width: newValue })
          }}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="height" class="block text-sm font-medium text-gray-600">Height</label>
        <input
          type="number"
          id="height"
          value={selectedObject.height}
          oninput={(e) => {
            const newValue = (e.target as HTMLInputElement).valueAsNumber
            selectedObject.height = newValue
            handleUpdate({ height: newValue })
          }}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="angle" class="block text-sm font-medium text-gray-600">Angle</label>
        <input
          type="number"
          id="angle"
          value={selectedObject.angle}
          oninput={(e) => {
            const newValue = (e.target as HTMLInputElement).valueAsNumber
            selectedObject.angle = newValue
            handleUpdate({ angle: newValue })
          }}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="fill" class="block text-sm font-medium text-gray-600">Fill Color</label>
        <input
          type="color"
          id="fill"
          value={selectedObject.fill}
          oninput={(e) => {
            const newValue = (e.target as HTMLInputElement).value
            selectedObject.fill = newValue
            handleUpdate({ fill: newValue })
          }}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
        />
      </div>
    </div>
  {:else}
    <p class="text-sm text-gray-500">No object selected.</p>
  {/if}
</div>
