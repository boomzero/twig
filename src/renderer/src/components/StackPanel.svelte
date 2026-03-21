<!--
  Stack Panel (Layers Panel) Component

  Displays all elements on the current slide in layer order (front at top).
  Drag-to-reorder splices the display-order array and normalizes zIndex values.
  Named operations (bring/move/send) are delegated to App.svelte via props so
  the logic lives in one place alongside the context menu operations.

  Props:
  - onLayerChange:  Fired after drag-to-reorder (triggers save + re-render)
  - onSelect:       Fired when a row is clicked (selects object on canvas)
  - onBringToFront: Bring element to front
  - onMoveUp:       Move element one layer up
  - onMoveDown:     Move element one layer down
  - onSendToBack:   Send element to back
-->

<script lang="ts">
  import { appState } from '../lib/state.svelte'
  import type { TwigElement } from '../lib/state.svelte'
  import { getElementLabel } from '../lib/elementUtils'

  const {
    onBeforeLayerChange,
    onLayerChange,
    onSelect,
    onBringToFront,
    onMoveUp,
    onMoveDown,
    onSendToBack
  }: {
    onBeforeLayerChange?: () => void
    onLayerChange?: () => void
    onSelect?: (id: string) => void
    onBringToFront?: (id: string) => void
    onMoveUp?: (id: string) => void
    onMoveDown?: (id: string) => void
    onSendToBack?: (id: string) => void
  } = $props()

  // Elements sorted front-to-back (highest zIndex first) for display
  const sortedElements = $derived(
    appState.currentSlide
      ? [...appState.currentSlide.elements].sort((a, b) => b.zIndex - a.zIndex)
      : []
  )

  function getIcon(el: TwigElement): string {
    if (el.type === 'text') return 'T'
    if (el.type === 'image') return '🖼'
    return '▭'
  }

  function selectElement(id: string): void {
    // Set state directly first for immediate panel highlight feedback.
    // onSelect also calls fabCanvas.setActiveObject(), which fires handleSelection
    // and sets selectedObjectId again — harmless since Svelte 5 signals skip
    // re-notification when the value is unchanged.
    // The direct assignment is also needed when the element is an image that hasn't
    // finished loading yet (absent from fabCanvas.getObjects()), so setActiveObject
    // would silently fail but the panel highlight still updates correctly.
    appState.selectedObjectId = id
    onSelect?.(id)
  }

  /**
   * Drag-to-reorder: splice the display-order array then normalize zIndex values.
   * sortedElements is front-to-back (index 0 = front = highest zIndex).
   */
  function reorderElements(fromDisplayIndex: number, toDisplayIndex: number): void {
    if (!appState.currentSlide) return
    if (fromDisplayIndex === toDisplayIndex) return

    onBeforeLayerChange?.()

    const ordered = [...sortedElements]
    const [moved] = ordered.splice(fromDisplayIndex, 1)
    ordered.splice(toDisplayIndex, 0, moved)

    const total = ordered.length
    ordered.forEach((el, i) => {
      const stateEl = appState.currentSlide!.elements.find((e) => e.id === el.id)
      if (stateEl) stateEl.zIndex = total - 1 - i
    })

    onLayerChange?.()
  }

  // Drag-and-drop state
  let dragSourceId = $state<string | null>(null)
  let dragOverId = $state<string | null>(null)
  let dragOverPosition = $state<'before' | 'after'>('before')

  function onDragStart(e: DragEvent, id: string): void {
    e.dataTransfer?.setData('text/plain', id)
    dragSourceId = id
  }

  function onDragOver(e: DragEvent, id: string): void {
    e.preventDefault()
    dragOverId = id
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dragOverPosition = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function onDragLeave(e: DragEvent): void {
    // Only clear if the pointer genuinely left the row. The browser fires dragleave
    // when crossing into a child element, which would cause the highlight to flicker.
    // Checking relatedTarget suppresses those spurious events.
    const row = e.currentTarget as HTMLElement
    if (row.contains(e.relatedTarget as Node)) return
    dragOverId = null
  }

  function onDrop(targetId: string): void {
    const pos = dragOverPosition
    dragOverId = null
    if (!dragSourceId || dragSourceId === targetId) return
    const fromIdx = sortedElements.findIndex((e) => e.id === dragSourceId)
    let toIdx = sortedElements.findIndex((e) => e.id === targetId)
    if (fromIdx < 0 || toIdx < 0) return
    if (pos === 'after') toIdx = Math.min(toIdx + 1, sortedElements.length - 1)
    reorderElements(fromIdx, toIdx)
    dragSourceId = null
  }

  function onDragEnd(): void {
    dragSourceId = null
    dragOverId = null
  }

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
</script>

{#if tooltip.visible}
  <div
    class="fixed z-50 px-2 py-1 text-xs text-white bg-gray-800 rounded pointer-events-none -translate-x-1/2 -translate-y-full whitespace-nowrap"
    style="left: {tooltip.x}px; top: {tooltip.y}px;"
  >
    {tooltip.text}
  </div>
{/if}

<div class="flex flex-col h-full" onmouseleave={hideTooltip} role="presentation">
  <div class="px-3 py-2 border-b border-gray-200">
    <h3 class="text-sm font-semibold text-gray-700">Layers</h3>
  </div>

  <div class="flex-1 overflow-y-auto" role="listbox" aria-label="Layers">
    {#if sortedElements.length === 0}
      <p class="px-3 py-4 text-xs text-gray-400 text-center">No elements on this slide.</p>
    {:else}
      {#each sortedElements as el, i (el.id)}
        {@const isFirst = i === 0}
        {@const isLast = i === sortedElements.length - 1}
        {@const isDragSource = dragSourceId === el.id}
        {@const isDragTarget = dragOverId === el.id && dragSourceId !== el.id}
        <div
          class="relative flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors"
          class:bg-indigo-50={appState.selectedObjectId === el.id}
          class:border-indigo-300={appState.selectedObjectId === el.id}
          class:opacity-40={isDragSource}
          onclick={() => selectElement(el.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectElement(el.id) } }}
          draggable={true}
          ondragstart={(e) => onDragStart(e, el.id)}
          ondragover={(e) => onDragOver(e, el.id)}
          ondragleave={(e) => onDragLeave(e)}
          ondrop={() => onDrop(el.id)}
          ondragend={onDragEnd}
          role="option"
          tabindex="0"
          aria-selected={appState.selectedObjectId === el.id}
        >
          {#if isDragTarget && dragOverPosition === 'before'}
            <div class="absolute top-0 left-0 right-0 h-0.5 bg-indigo-500 z-10 pointer-events-none"></div>
          {/if}
          {#if isDragTarget && dragOverPosition === 'after'}
            <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 z-10 pointer-events-none"></div>
          {/if}
          <!-- Type icon -->
          <span class="text-xs w-5 text-center text-gray-400 flex-shrink-0 font-mono">
            {getIcon(el)}
          </span>

          <!-- Label -->
          <span
            class="flex-1 text-xs truncate"
            class:text-indigo-700={appState.selectedObjectId === el.id}
            class:font-medium={appState.selectedObjectId === el.id}
            title={getElementLabel(el)}
          >
            {getElementLabel(el)}
          </span>

          <!-- Reorder buttons -->
          <div class="flex gap-0.5 flex-shrink-0">
            <!-- Bring to Front -->
            <button
              onclick={(e) => { e.stopPropagation(); onBringToFront?.(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Bring to Front')}
              onmouseleave={hideTooltip}
              disabled={isFirst}
              class="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
              aria-label="Bring to Front"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <rect x="1" y="1" width="10" height="1.5" rx="0.5"/>
                <path d="M6 3.5 L9.5 8 L6.75 8 L6.75 11 L5.25 11 L5.25 8 L2.5 8 Z"/>
              </svg>
            </button>
            <!-- Move Up -->
            <button
              onclick={(e) => { e.stopPropagation(); onMoveUp?.(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Move Up')}
              onmouseleave={hideTooltip}
              disabled={isFirst}
              class="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
              aria-label="Move Up"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <path d="M6 1.5 L9.5 6.5 L6.75 6.5 L6.75 10.5 L5.25 10.5 L5.25 6.5 L2.5 6.5 Z"/>
              </svg>
            </button>
            <!-- Move Down -->
            <button
              onclick={(e) => { e.stopPropagation(); onMoveDown?.(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Move Down')}
              onmouseleave={hideTooltip}
              disabled={isLast}
              class="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
              aria-label="Move Down"
            >
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <path d="M6 10.5 L2.5 5.5 L5.25 5.5 L5.25 1.5 L6.75 1.5 L6.75 5.5 L9.5 5.5 Z"/>
              </svg>
            </button>
            <!-- Send to Back -->
            <button
              onclick={(e) => { e.stopPropagation(); onSendToBack?.(el.id) }}
              onmouseenter={(e) => showTooltip(e, 'Send to Back')}
              onmouseleave={hideTooltip}
              disabled={isLast}
              class="w-5 h-5 flex items-center justify-center rounded text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
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
