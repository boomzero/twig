<!--
  Animation Order Panel Component

  Displays the ordered list of animation steps for the current slide.
  Each step can be reordered via drag-and-drop or removed (which also clears
  the animation config from the element).
-->

<script lang="ts">
  import { appState } from '../lib/state.svelte'
  import type { AnimationStep } from '../lib/types'
  import { isValidAnimationOrder, getAnimationStepKey } from '../lib/animationUtils'
  import { getElementLabel, computeDropInsertIndex } from '../lib/elementUtils'
  import { _ } from 'svelte-i18n'
  import { get } from 'svelte/store'

  const {
    onBeforeChange,
    onAfterChange,
    onRemoveStep
  }: {
    onBeforeChange?: () => void
    onAfterChange?: () => void
    onRemoveStep?: (step: AnimationStep) => void
  } = $props()

  // One-shot checkpoint guard — push once per drag session, reset on pointerup
  let snapshotPushed = false

  function applyOrderChange(newOrder: AnimationStep[]): void {
    if (appState.readOnly) return
    if (!appState.currentSlide) return
    if (!isValidAnimationOrder(newOrder)) return
    if (!snapshotPushed) {
      onBeforeChange?.()
      snapshotPushed = true
    }
    appState.currentSlide.animationOrder = newOrder
    onAfterChange?.()
  }

  function getCategoryBadge(category: AnimationStep['category']): {
    label: string
    classes: string
  } {
    if (category === 'buildIn')
      return {
        label: get(_)('anim_panel.in'),
        classes: 'bg-green-100 text-green-700 border-green-200'
      }
    if (category === 'buildOut')
      return {
        label: get(_)('anim_panel.out'),
        classes: 'bg-orange-100 text-orange-700 border-orange-200'
      }
    return {
      label: get(_)('anim_panel.action'),
      classes: 'bg-blue-100 text-blue-700 border-blue-200'
    }
  }

  function getAnimationTypeLabel(step: AnimationStep): string {
    const el = appState.currentSlide?.elements.find((e) => e.id === step.elementId)
    if (!el?.animations) return ''
    if (step.category === 'action') {
      const action = el.animations.actions?.find((a) => a.id === step.actionId)
      return action?.type === 'move' ? get(_)('anim.move') : ''
    }
    const anim = el.animations[step.category]
    if (!anim) return ''
    if (anim.type === 'appear') return get(_)('anim.appear')
    if (anim.type === 'fade-in') return get(_)('anim.fade_in')
    if (anim.type === 'disappear') return get(_)('anim.disappear')
    if (anim.type === 'fade-out') return get(_)('anim.fade_out')
    return ''
  }

  // Derived order for display — resolved live from currentSlide
  const order = $derived(appState.currentSlide?.animationOrder ?? [])

  // Drag-and-drop state
  let dragSourceIndex = $state<number | null>(null)
  let dragOverIndex = $state<number | null>(null)
  let dragOverPosition = $state<'before' | 'after'>('before')

  function onDragStart(e: DragEvent, index: number): void {
    if (appState.readOnly) {
      e.preventDefault()
      return
    }
    e.dataTransfer?.setData('text/plain', String(index))
    dragSourceIndex = index
  }

  function onDragOver(e: DragEvent, index: number): void {
    if (appState.readOnly) return
    e.preventDefault()
    dragOverIndex = index
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dragOverPosition = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function onDragLeave(e: DragEvent): void {
    const row = e.currentTarget as HTMLElement
    if (row.contains(e.relatedTarget as Node)) return
    dragOverIndex = null
  }

  function onDrop(targetIndex: number): void {
    const from = dragSourceIndex
    const pos = dragOverPosition
    dragOverIndex = null
    dragSourceIndex = null
    if (from === null || from === targetIndex) return
    const newOrder = [...order]
    const [moved] = newOrder.splice(from, 1)
    newOrder.splice(computeDropInsertIndex(from, targetIndex, pos), 0, moved)
    applyOrderChange(newOrder)
  }

  function onDragEnd(): void {
    dragSourceIndex = null
    dragOverIndex = null
    snapshotPushed = false
  }
</script>

<!-- Reset snapshot gate on pointer release so each drag gets its own undo entry -->
<div
  class="flex flex-col h-full"
  onpointerup={() => {
    snapshotPushed = false
  }}
  role="presentation"
>
  <div class="px-3 py-2 border-b border-gray-200">
    <h3 class="text-sm font-semibold text-gray-700">{$_('anim_panel.title')}</h3>
  </div>

  <div class="flex-1 overflow-y-auto" role="list" aria-label={$_('anim_panel.steps.label')}>
    {#if order.length === 0}
      <p class="px-3 py-4 text-xs text-gray-400 text-center">
        {$_('anim_panel.empty')}
      </p>
    {:else}
      {#each order as step, i (getAnimationStepKey(step))}
        {@const el = appState.currentSlide?.elements.find((e) => e.id === step.elementId)}
        {@const badge = getCategoryBadge(step.category)}
        {@const isDragSource = dragSourceIndex === i}
        {@const isDragTarget = dragOverIndex === i && dragSourceIndex !== i}
        <div
          class="relative flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
          class:opacity-40={isDragSource}
          draggable={!appState.readOnly}
          ondragstart={(e) => onDragStart(e, i)}
          ondragover={(e) => onDragOver(e, i)}
          ondragleave={(e) => onDragLeave(e)}
          ondrop={() => onDrop(i)}
          ondragend={onDragEnd}
          role="listitem"
        >
          {#if isDragTarget && dragOverPosition === 'before'}
            <div
              class="absolute top-0 left-0 right-0 h-0.5 bg-indigo-500 z-10 pointer-events-none"
            ></div>
          {/if}
          {#if isDragTarget && dragOverPosition === 'after'}
            <div
              class="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 z-10 pointer-events-none"
            ></div>
          {/if}
          <!-- Drag handle -->
          <span class="text-gray-300 cursor-grab active:cursor-grabbing flex-shrink-0 text-xs"
            >⠿</span
          >

          <!-- Step number -->
          <span class="text-xs text-gray-400 w-4 flex-shrink-0 font-mono">{i + 1}</span>

          <!-- Category badge -->
          <span
            class="text-xs px-1.5 py-0.5 rounded border font-medium flex-shrink-0 {badge.classes}"
          >
            {badge.label}
          </span>

          <!-- Element label -->
          <span
            class="flex-1 text-xs truncate text-gray-700"
            title={el ? getElementLabel(el) : step.elementId}
          >
            {el ? getElementLabel(el) : $_('anim_panel.deleted')}
          </span>

          <!-- Animation type -->
          <span class="text-xs text-gray-400 flex-shrink-0">
            {getAnimationTypeLabel(step)}
          </span>

          <!-- Remove button -->
          <button
            onclick={() => onRemoveStep?.(step)}
            disabled={appState.readOnly}
            class="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-300"
            aria-label={$_('anim_panel.remove_step.title')}
            title={$_('anim_panel.remove_step.title')}
          >
            ×
          </button>
        </div>
      {/each}
    {/if}
  </div>
</div>
