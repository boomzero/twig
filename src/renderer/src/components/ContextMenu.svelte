<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  export let x: number
  export let y: number

  const dispatch = createEventDispatcher()

  function handleDelete(): void {
    dispatch('delete')
  }
</script>

<div
  class="absolute bg-white border border-gray-300 rounded-md shadow-lg py-1"
  style="top: {y}px; left: {x}px;"
>
  <button
    on:click={handleDelete}
    class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
  >
    Delete
  </button>
</div>
