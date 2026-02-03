<!--
  Properties Panel Component

  Displays and allows editing of properties for the selected canvas object.
  Shows position, size, rotation, color, and text-specific properties.

  The panel automatically shows/hides based on whether an object is selected.
  All changes are automatically synced to the application state and trigger
  canvas re-renders.
-->

<script lang="ts">
  import { appState } from '../lib/state.svelte'

  // Reactively compute the currently selected object from app state
  // This will automatically update when the selection changes
  const selectedObject = $derived(
    appState.currentSlide?.elements.find((el) => el.id === appState.selectedObjectId)
  )
</script>

<div class="p-4 bg-gray-50 border-l border-gray-300 basis-64">
  <h3 class="text-lg font-semibold mb-4">Properties</h3>

  {#if selectedObject}
    <!-- Property controls for the selected object -->
    <div class="space-y-3">
      <div>
        <label for="x" class="block text-sm font-medium text-gray-600">X Position</label>
        <input
          type="number"
          id="x"
          bind:value={selectedObject.x}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="y" class="block text-sm font-medium text-gray-600">Y Position</label>
        <input
          type="number"
          id="y"
          bind:value={selectedObject.y}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="width" class="block text-sm font-medium text-gray-600">Width</label>
        <input
          type="number"
          id="width"
          bind:value={selectedObject.width}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="height" class="block text-sm font-medium text-gray-600">Height</label>
        <input
          type="number"
          id="height"
          bind:value={selectedObject.height}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="angle" class="block text-sm font-medium text-gray-600">Angle</label>
        <input
          type="number"
          id="angle"
          bind:value={selectedObject.angle}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
    </div>
  {:else}
    <p class="text-sm text-gray-500">No object selected.</p>
  {/if}
</div>
