<!--
  Stack Panel (Layers Panel) Component

  Displays all elements on the current slide in layer order (front at top).
  Reordering moves the element in the array, then normalizes all zIndex values
  to sequential integers so DB ordering is always clean.

  Props:
  - onLayerChange: Callback fired after any reorder (triggers save + re-render)
-->

<script lang="ts">
  import { appState } from '../lib/state.svelte'
  import type { DeckElement } from '../lib/state.svelte'

  const { onLayerChange }: { onLayerChange?: () => void } = $props()

  // Elements sorted front-to-back (highest zIndex first) for display
  const sortedElements = $derived(
    appState.currentSlide
      ? [...appState.currentSlide.elements].sort((a, b) => b.zIndex - a.zIndex)
      : []
  )

  function getLabel(el: DeckElement): string {
    if (el.type === 'text') {
      const preview = el.text?.slice(0, 20) ?? ''
      return `Text: ${preview}${(el.text?.length ?? 0) > 20 ? '…' : ''}`
    }
    if (el.type === 'image') {
      return `Image: ${el.filename ?? 'image'}`
    }
    return 'Shape'
  }

  function getIcon(el: DeckElement): string {
    if (el.type === 'text') return 'T'
    if (el.type === 'image') return '🖼'
    return '▭'
  }

  function selectElement(id: string): void {
    appState.selectedObjectId = id
  }

  /**
   * Reorder: move element at fromIndex to toIndex in the sorted display array,
   * then normalize all zIndex values to sequential integers.
   * The sorted array is front-to-back (index 0 = front/highest zIndex).
   */
  function reorderElements(fromDisplayIndex: number, toDisplayIndex: number): void {
    if (!appState.currentSlide) return
    if (fromDisplayIndex === toDisplayIndex) return

    // Work on a sorted copy (front-to-back order)
    const ordered = [...sortedElements]
    const [moved] = ordered.splice(fromDisplayIndex, 1)
    ordered.splice(toDisplayIndex, 0, moved)

    // Normalize: index 0 (front) gets highest zIndex
    const total = ordered.length
    ordered.forEach((el, i) => {
      // Find the element in the actual state array and update its zIndex
      const stateEl = appState.currentSlide!.elements.find((e) => e.id === el.id)
      if (stateEl) {
        stateEl.zIndex = total - 1 - i
      }
    })

    onLayerChange?.()
  }

  function bringToFront(id: string): void {
    const idx = sortedElements.findIndex((e) => e.id === id)
    if (idx <= 0) return
    reorderElements(idx, 0)
  }

  function sendToBack(id: string): void {
    const idx = sortedElements.findIndex((e) => e.id === id)
    if (idx < 0 || idx >= sortedElements.length - 1) return
    reorderElements(idx, sortedElements.length - 1)
  }

  function moveUp(id: string): void {
    const idx = sortedElements.findIndex((e) => e.id === id)
    if (idx <= 0) return
    reorderElements(idx, idx - 1)
  }

  function moveDown(id: string): void {
    const idx = sortedElements.findIndex((e) => e.id === id)
    if (idx < 0 || idx >= sortedElements.length - 1) return
    reorderElements(idx, idx + 1)
  }

  // Drag-and-drop state
  let dragSourceId = $state<string | null>(null)

  // Tooltip state (fixed-position, rendered outside draggable rows)
  let tooltip = $state<{ text: string; x: number; y: number; visible: boolean }>({
    text: '',
    x: 0,
    y: 0,
    visible: false
  })

  function showTooltip(e: MouseEvent, text: string): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    tooltip = { text, x: rect.left + rect.width / 2, y: rect.top - 6, visible: true }
  }

  function hideTooltip(): void {
    tooltip = { ...tooltip, visible: false }
  }

  function onDragStart(id: string): void {
    dragSourceId = id
  }

  function onDrop(targetId: string): void {
    if (!dragSourceId || dragSourceId === targetId) return
    const fromIdx = sortedElements.findIndex((e) => e.id === dragSourceId)
    const toIdx = sortedElements.findIndex((e) => e.id === targetId)
    if (fromIdx < 0 || toIdx < 0) return
    reorderElements(fromIdx, toIdx)
    dragSourceId = null
  }

  function onDragEnd(): void {
    dragSourceId = null
  }
</script>

{#if tooltip.visible}
  <div
    class="fixed z-50 px-2 py-1 text-xs text-white bg-gray-800 rounded pointer-events-none -translate-x-1/2 -translate-y-full whitespace-nowrap"
    style="left: {tooltip.x}px; top: {tooltip.y}px;"
  >
    {tooltip.text}
  </div>
{/if}

<div class="flex flex-col h-full">
  <div class="px-3 py-2 border-b border-gray-200">
    <h3 class="text-sm font-semibold text-gray-700">Layers</h3>
  </div>

  <div class="flex-1 overflow-y-auto">
    {#if sortedElements.length === 0}
      <p class="px-3 py-4 text-xs text-gray-400 text-center">No elements on this slide.</p>
    {:else}
      {#each sortedElements as el (el.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 cursor-pointer hover:bg-gray-50"
          class:bg-indigo-50={appState.selectedObjectId === el.id}
          class:border-indigo-300={appState.selectedObjectId === el.id}
          onclick={() => selectElement(el.id)}
          draggable={true}
          ondragstart={() => onDragStart(el.id)}
          ondragover={(e) => e.preventDefault()}
          ondrop={() => onDrop(el.id)}
          ondragend={onDragEnd}
          role="option"
          aria-selected={appState.selectedObjectId === el.id}
        >
          <!-- Type icon -->
          <span class="text-xs w-5 text-center text-gray-400 flex-shrink-0 font-mono">
            {getIcon(el)}
          </span>

          <!-- Label -->
          <span
            class="flex-1 text-xs truncate"
            class:text-indigo-700={appState.selectedObjectId === el.id}
            class:font-medium={appState.selectedObjectId === el.id}
            title={getLabel(el)}
          >
            {getLabel(el)}
          </span>

          <!-- Reorder buttons (stop propagation so clicks don't also select) -->
          <div class="flex gap-0.5 flex-shrink-0">
            <!-- Bring to Front: arrow + top bar -->
            <button
              onclick={(e) => { e.stopPropagation(); bringToFront(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Bring to Front')}
              onmouseleave={hideTooltip}
              class="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded"
              aria-label="Bring to Front"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <rect x="1" y="1" width="10" height="1.5" rx="0.5"/>
                <path d="M6 3.5 L9.5 8 L6.75 8 L6.75 11 L5.25 11 L5.25 8 L2.5 8 Z"/>
              </svg>
            </button>
            <!-- Move Up: simple arrow up -->
            <button
              onclick={(e) => { e.stopPropagation(); moveUp(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Move Up')}
              onmouseleave={hideTooltip}
              class="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded"
              aria-label="Move Up"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <path d="M6 1.5 L9.5 6.5 L6.75 6.5 L6.75 10.5 L5.25 10.5 L5.25 6.5 L2.5 6.5 Z"/>
              </svg>
            </button>
            <!-- Move Down: simple arrow down -->
            <button
              onclick={(e) => { e.stopPropagation(); moveDown(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Move Down')}
              onmouseleave={hideTooltip}
              class="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded"
              aria-label="Move Down"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <path d="M6 10.5 L2.5 5.5 L5.25 5.5 L5.25 1.5 L6.75 1.5 L6.75 5.5 L9.5 5.5 Z"/>
              </svg>
            </button>
            <!-- Send to Back: arrow + bottom bar -->
            <button
              onclick={(e) => { e.stopPropagation(); sendToBack(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Send to Back')}
              onmouseleave={hideTooltip}
              class="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded"
              aria-label="Send to Back"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <rect x="1" y="9.5" width="10" height="1.5" rx="0.5"/>
                <path d="M6 8.5 L2.5 4 L5.25 4 L5.25 1 L6.75 1 L6.75 4 L9.5 4 Z"/>
              </svg>
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
