<!--
  Context Menu Component

  Displays a right-click context menu at the specified position.
  Supports delete and layer-reorder operations for selected canvas objects.

  Props:
  - x: X coordinate for menu position
  - y: Y coordinate for menu position
  - onDelete: Callback function to execute when Delete is clicked
  - onBringToFront: Callback to bring element to front
  - onMoveUp: Callback to move element one layer up
  - onMoveDown: Callback to move element one layer down
  - onSendToBack: Callback to send element to back
  - isAtFront: True if the selected element is already at the front
  - isAtBack: True if the selected element is already at the back
-->

<script lang="ts">
  const {
    x,
    y,
    onDelete,
    onBringToFront,
    onMoveUp,
    onMoveDown,
    onSendToBack,
    isAtFront = false,
    isAtBack = false
  }: {
    x: number
    y: number
    onDelete: () => void
    onBringToFront?: () => void
    onMoveUp?: () => void
    onMoveDown?: () => void
    onSendToBack?: () => void
    isAtFront?: boolean
    isAtBack?: boolean
  } = $props()
</script>

<div
  class="absolute bg-white border border-gray-300 rounded-md shadow-lg py-1 z-50"
  style="top: {y}px; left: {x}px;"
>
  {#if onBringToFront || onMoveUp || onMoveDown || onSendToBack}
    <button
      onclick={onBringToFront}
      disabled={isAtFront}
      class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      Bring to Front
    </button>
    <!--
      "Move Up" is disabled under the same condition as "Bring to Front" (isAtFront) because
      when the selected element is already at the top, both operations are no-ops. With only
      two elements these actions are identical; with more they differ. No separate
      isSecondFromFront guard is needed.
    -->
    <button
      onclick={onMoveUp}
      disabled={isAtFront}
      class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      Move Up
    </button>
    <button
      onclick={onMoveDown}
      disabled={isAtBack}
      class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      Move Down
    </button>
    <button
      onclick={onSendToBack}
      disabled={isAtBack}
      class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      Send to Back
    </button>
    <div class="border-t border-gray-200 my-1"></div>
  {/if}
  <button
    onclick={onDelete}
    class="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-gray-100"
  >
    Delete
  </button>
</div>
