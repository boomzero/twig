<script lang="ts">
  export let x: number
  export let y: number
  export let onDelete: () => void
</script>

<div
  class="absolute bg-white border border-gray-300 rounded-md shadow-lg py-1 z-50"
  style="top: {y}px; left: {x}px;"
>
  <button
    onclick={onDelete}
    class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
  >
    Delete
  </button>
</div>
