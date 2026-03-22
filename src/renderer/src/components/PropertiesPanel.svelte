<!--
  Properties Panel Component

  Displays and allows editing of properties for the selected canvas object.
  Shows position, size, rotation, color, and text-specific properties.

  When no object is selected, shows Slide Background controls (solid color,
  linear gradient, or image).

  All changes are automatically synced to the application state and trigger
  canvas re-renders.
-->

<script lang="ts">
  import { appState } from '../lib/state.svelte'
  import type { SlideBackground, ElementAnimations, SlideTransition } from '../lib/types'

  type RichText = {
    isBold: boolean
    isItalic: boolean
    isUnderlined: boolean
    fontSize: number
    fontFamily: string
    fillColor: string
    fontDropdownOpen: boolean
    fontSearchQuery: string
    availableFonts: string[]
    toggleBold: () => void
    toggleItalic: () => void
    toggleUnderline: () => void
    changeFontSize: (e: Event) => void
    applyStyle: (style: Record<string, string | number | boolean>) => void
    toggleFontDropdown: () => void
    selectFont: (family: string) => Promise<void>
    previewFont: (family: string) => void
    escapeFont: (family: string) => string
    closeFontDropdown: () => void
    setFontSearchQuery: (q: string) => void
  }

  const {
    onPropertyChange,
    onBeforePropertyChange,
    onSlideBackgroundChange,
    onSetAsDefault,
    onApplyToAll,
    onAnimationChange,
    onSlideTransitionChange,
    slideTransition,
    richText
  }: {
    onPropertyChange?: () => void
    onBeforePropertyChange?: () => void
    onSlideBackgroundChange?: (bg: SlideBackground) => void
    onSetAsDefault?: (bg: SlideBackground | null) => void
    onApplyToAll?: (bg: SlideBackground | null) => void
    onAnimationChange?: (elementId: string, animations: ElementAnimations) => void
    onSlideTransitionChange?: (t: SlideTransition | undefined) => void
    slideTransition?: SlideTransition
    richText?: RichText
  } = $props()

  // Font dropdown click-outside handling (ref lives here since dropdown renders here)
  let fontDropdownRef: HTMLDivElement | null = $state(null)
  $effect(() => {
    if (!richText?.fontDropdownOpen) return
    function onMousedown(e: MouseEvent): void {
      if (fontDropdownRef && !fontDropdownRef.contains(e.target as Node)) {
        richText?.closeFontDropdown()
      }
    }
    document.addEventListener('mousedown', onMousedown)
    return () => document.removeEventListener('mousedown', onMousedown)
  })

  // One-shot checkpoint guard: push a history checkpoint on the first real value
  // change per focus session, not on focus itself (which would clear redo even
  // if the user never edits anything). Reset on blur so the next session is fresh.
  let snapshotPushed = false
  function handleInput(): void {
    if (!snapshotPushed) {
      onBeforePropertyChange?.()
      snapshotPushed = true
    }
    onPropertyChange?.()
  }
  function handleBlur(): void {
    snapshotPushed = false
  }

  // Guard for continuous animation input (number fields). Resets on blur so
  // each new focus session gets its own undo entry. Discrete actions (buttons,
  // selects) always checkpoint unconditionally — pass continuous=true only for
  // oninput handlers where per-keystroke checkpointing would be wrong.
  let animSnapshotPushed = false

  function emitAnimationChange(animations: ElementAnimations, continuous = false): void {
    if (!selectedObject) return
    if (!continuous || !animSnapshotPushed) {
      onBeforePropertyChange?.()
      animSnapshotPushed = continuous // stay true only for continuous sessions
    }
    onAnimationChange?.(selectedObject.id, animations)
  }

  function handleAnimationBlur(): void {
    animSnapshotPushed = false
  }

  // Duration presets in ms
  const DURATION_FAST = 250
  const DURATION_NORMAL = 500
  const DURATION_SLOW = 1000

  // Reactively compute the currently selected object from app state
  const selectedObject = $derived(
    appState.currentSlide?.elements.find((el) => el.id === appState.selectedObjectId)
  )

  // Current background derived from slide state
  const currentBg = $derived(appState.currentSlide?.background)
  const bgType = $derived(currentBg?.type ?? 'solid')

  let activeTab = $derived.by<'solid' | 'gradient' | 'image'>(
    () => bgType as 'solid' | 'gradient' | 'image'
  )

  function emitSolid(color: string): void {
    onSlideBackgroundChange?.({ type: 'solid', color })
  }

  function emitGradient(angle: number, color1: string, color2: string): void {
    onSlideBackgroundChange?.({
      type: 'gradient',
      angle,
      stops: [
        { offset: 0, color: color1 },
        { offset: 1, color: color2 }
      ]
    })
  }

  async function pickImageBackground(): Promise<void> {
    const result = await window.api.dialog.showImageDialog()
    if (result?.src) {
      const fit = currentBg?.type === 'image' ? (currentBg.fit ?? 'cover') : 'cover'
      onSlideBackgroundChange?.({ type: 'image', src: result.src, filename: result.filename, fit })
    }
  }

  function emitImageFit(fit: 'stretch' | 'contain' | 'cover'): void {
    if (currentBg?.type === 'image') {
      onSlideBackgroundChange?.({ ...currentBg, fit })
    }
  }
</script>

<div class="p-4 overflow-y-auto flex-1">
  <h3 class="text-lg font-semibold mb-4">Properties</h3>

  {#if selectedObject}
    <!-- Property controls for the selected object -->
    <div class="space-y-3">
      {#if selectedObject.type === 'text' && richText}
        <!-- Text formatting controls -->
        <div class="pb-3 border-b border-gray-200">
          <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Text</p>
          <!-- B / I / U row -->
          <div class="flex gap-1 mb-2">
            <button
              onclick={richText.toggleBold}
              class="w-8 h-8 flex items-center justify-center font-bold text-sm rounded-md focus:outline-none"
              class:bg-gray-200={richText.isBold}
              class:text-gray-700={richText.isBold}
              class:text-gray-600={!richText.isBold}
              class:hover:bg-gray-100={!richText.isBold}>B</button
            >
            <button
              onclick={richText.toggleItalic}
              class="w-8 h-8 flex items-center justify-center italic text-sm rounded-md focus:outline-none"
              class:bg-gray-200={richText.isItalic}
              class:text-gray-700={richText.isItalic}
              class:text-gray-600={!richText.isItalic}
              class:hover:bg-gray-100={!richText.isItalic}>I</button
            >
            <button
              onclick={richText.toggleUnderline}
              class="w-8 h-8 flex items-center justify-center underline text-sm rounded-md focus:outline-none"
              class:bg-gray-200={richText.isUnderlined}
              class:text-gray-700={richText.isUnderlined}
              class:text-gray-600={!richText.isUnderlined}
              class:hover:bg-gray-100={!richText.isUnderlined}>U</button
            >
            <input
              type="number"
              value={richText.fontSize}
              onchange={richText.changeFontSize}
              onkeydown={(e) => e.stopPropagation()}
              min="1"
              max="500"
              class="flex-1 h-8 px-2 text-sm border border-gray-300 rounded-md"
              placeholder="Size"
            />
            <input
              type="color"
              value={richText.fillColor}
              oninput={(e) => richText?.applyStyle({ fill: (e.target as HTMLInputElement).value })}
              class="w-8 h-8 p-0 border-none bg-transparent cursor-pointer"
              title="Text color"
            />
          </div>
          <!-- Font family dropdown -->
          <div bind:this={fontDropdownRef} class="relative">
            <button
              onclick={richText.toggleFontDropdown}
              onkeydown={(e) => e.stopPropagation()}
              class="w-full h-8 px-2 pr-6 text-sm border border-gray-300 rounded-md bg-white hover:bg-gray-50 flex items-center relative"
              style={richText.fontFamily !== 'Multiple'
                ? `font-family: ${richText.escapeFont(richText.fontFamily)}`
                : ''}
            >
              <span
                class="truncate"
                class:italic={richText.fontFamily === 'Multiple'}
                class:text-gray-500={richText.fontFamily === 'Multiple'}>{richText.fontFamily}</span
              >
              <svg
                class="w-4 h-4 absolute right-1 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
            {#if richText.fontDropdownOpen}
              <div
                class="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-gray-300 rounded-md shadow-lg"
                onkeydown={(e) => e.stopPropagation()}
                style="will-change: scroll-position; contain: layout style paint;"
              >
                <div class="sticky top-0 bg-white p-2 border-b border-gray-200 z-10">
                  <input
                    type="text"
                    value={richText.fontSearchQuery}
                    oninput={(e) =>
                      richText?.setFontSearchQuery((e.target as HTMLInputElement).value)}
                    placeholder="Search fonts..."
                    class="w-full px-2 py-1 text-sm border border-gray-300 rounded bg-white"
                    onkeydown={(e) => e.stopPropagation()}
                  />
                </div>
                <div class="py-1">
                  {#each richText.availableFonts.filter((f) => !richText?.fontSearchQuery || f
                        .toLowerCase()
                        .includes(richText.fontSearchQuery.toLowerCase())) as font (font)}
                    <button
                      onclick={() => richText?.selectFont(font)}
                      onmouseenter={() => richText?.previewFont(font)}
                      class="w-full px-3 py-2 text-left hover:bg-blue-50 flex items-center text-base"
                      class:bg-blue-100={font === richText.fontFamily}
                      style="font-family: {richText.escapeFont(font)}; contain: layout style;"
                      >{font}</button
                    >
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
      <div>
        <label for="x" class="block text-sm font-medium text-gray-600">X Position</label>
        <input
          type="number"
          id="x"
          bind:value={selectedObject.x}
          oninput={handleInput}
          onblur={handleBlur}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="y" class="block text-sm font-medium text-gray-600">Y Position</label>
        <input
          type="number"
          id="y"
          bind:value={selectedObject.y}
          oninput={handleInput}
          onblur={handleBlur}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="width" class="block text-sm font-medium text-gray-600">Width</label>
        <input
          type="number"
          id="width"
          bind:value={selectedObject.width}
          oninput={handleInput}
          onblur={handleBlur}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="height" class="block text-sm font-medium text-gray-600">Height</label>
        <input
          type="number"
          id="height"
          bind:value={selectedObject.height}
          oninput={handleInput}
          onblur={handleBlur}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="angle" class="block text-sm font-medium text-gray-600">Angle</label>
        <input
          type="number"
          id="angle"
          bind:value={selectedObject.angle}
          oninput={handleInput}
          onblur={handleBlur}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      {#if selectedObject.type === 'rect'}
        <div>
          <label for="fill" class="block text-sm font-medium text-gray-600">Fill Color</label>
          <input
            type="color"
            id="fill"
            bind:value={selectedObject.fill}
            oninput={handleInput}
            onblur={handleBlur}
            class="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
          />
        </div>
      {/if}

      <!-- Animations section -->
      <div class="pt-3 border-t border-gray-200">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Animations</p>

        <!-- Build In -->
        <div class="mb-2">
          <label class="block text-xs font-medium text-gray-500 mb-1">Build In</label>
          <select
            class="block w-full rounded border-gray-300 text-xs py-1"
            value={selectedObject.animations?.buildIn?.type ?? 'none'}
            onchange={(e) => {
              const val = (e.target as HTMLSelectElement).value
              const cur = selectedObject.animations ?? {}
              if (val === 'none') {
                const rest = Object.fromEntries(
                  Object.entries(cur).filter(([k]) => k !== 'buildIn')
                ) as ElementAnimations
                emitAnimationChange(rest)
              } else {
                const type = val as 'appear' | 'fade-in'
                emitAnimationChange({
                  ...cur,
                  buildIn: { type, duration: cur.buildIn?.duration ?? DURATION_NORMAL }
                })
              }
            }}
            onblur={handleAnimationBlur}
          >
            <option value="none">None</option>
            <option value="appear">Appear</option>
            <option value="fade-in">Fade In</option>
          </select>
          {#if selectedObject.animations?.buildIn?.type === 'fade-in'}
            <div class="mt-1 flex gap-1">
              {#each [[DURATION_FAST, 'Fast'], [DURATION_NORMAL, 'Normal'], [DURATION_SLOW, 'Slow']] as [ms, lbl] (ms)}
                <button
                  class="flex-1 py-0.5 text-xs rounded border {selectedObject.animations.buildIn
                    .duration === ms
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-300 hover:bg-gray-50'}"
                  onclick={() => {
                    const cur = selectedObject.animations ?? {}
                    emitAnimationChange({
                      ...cur,
                      buildIn: { type: 'fade-in', duration: ms as number }
                    })
                  }}>{lbl}</button
                >
              {/each}
              <input
                type="number"
                min="50"
                max="5000"
                value={selectedObject.animations.buildIn.duration}
                oninput={(e) => {
                  const ms = parseInt((e.target as HTMLInputElement).value)
                  if (!isNaN(ms) && ms > 0) {
                    const cur = selectedObject.animations ?? {}
                    emitAnimationChange(
                      { ...cur, buildIn: { type: 'fade-in', duration: ms } },
                      true
                    )
                  }
                }}
                onblur={handleAnimationBlur}
                class="w-16 text-xs border border-gray-300 rounded px-1"
                title="Duration (ms)"
              />
            </div>
          {/if}
        </div>

        <!-- Actions (multiple) -->
        <div class="mb-2">
          <div class="flex items-center justify-between mb-1">
            <label class="block text-xs font-medium text-gray-500">Actions</label>
            <button
              class="text-xs text-indigo-600 hover:text-indigo-700"
              onclick={() => {
                const cur = selectedObject.animations ?? {}
                const newAction = {
                  id: crypto.randomUUID(),
                  type: 'move' as const,
                  toX: selectedObject.x + 100,
                  toY: selectedObject.y,
                  duration: DURATION_NORMAL
                }
                emitAnimationChange({ ...cur, actions: [...(cur.actions ?? []), newAction] })
              }}>+ Add Move</button
            >
          </div>
          {#each selectedObject.animations?.actions ?? [] as action (action.id)}
            <div class="mb-2 p-2 border border-gray-200 rounded bg-gray-50">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs font-medium text-blue-600">Move</span>
                <button
                  class="text-xs text-gray-300 hover:text-red-500"
                  onclick={() => {
                    const cur = selectedObject.animations ?? {}
                    const remaining = (cur.actions ?? []).filter((a) => a.id !== action.id)
                    const updated = { ...cur }
                    if (remaining.length > 0) updated.actions = remaining
                    else delete updated.actions
                    emitAnimationChange(updated)
                  }}
                  aria-label="Remove action">×</button
                >
              </div>
              <div class="space-y-1">
                <div class="flex gap-1 items-center">
                  <label class="text-xs text-gray-400 w-8">To X</label>
                  <input
                    type="number"
                    value={action.toX}
                    oninput={(e) => {
                      const v = parseFloat((e.target as HTMLInputElement).value)
                      if (!isNaN(v)) {
                        const cur = selectedObject.animations ?? {}
                        emitAnimationChange(
                          {
                            ...cur,
                            actions: (cur.actions ?? []).map((a) =>
                              a.id === action.id ? { ...a, toX: v } : a
                            )
                          },
                          true
                        )
                      }
                    }}
                    onblur={handleAnimationBlur}
                    class="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5"
                  />
                </div>
                <div class="flex gap-1 items-center">
                  <label class="text-xs text-gray-400 w-8">To Y</label>
                  <input
                    type="number"
                    value={action.toY}
                    oninput={(e) => {
                      const v = parseFloat((e.target as HTMLInputElement).value)
                      if (!isNaN(v)) {
                        const cur = selectedObject.animations ?? {}
                        emitAnimationChange(
                          {
                            ...cur,
                            actions: (cur.actions ?? []).map((a) =>
                              a.id === action.id ? { ...a, toY: v } : a
                            )
                          },
                          true
                        )
                      }
                    }}
                    onblur={handleAnimationBlur}
                    class="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5"
                  />
                </div>
                <div class="flex gap-1">
                  {#each [[DURATION_FAST, 'Fast'], [DURATION_NORMAL, 'Normal'], [DURATION_SLOW, 'Slow']] as [ms, lbl] (ms)}
                    <button
                      class="flex-1 py-0.5 text-xs rounded border {action.duration === ms
                        ? 'bg-indigo-600 text-white border-indigo-600'
                        : 'border-gray-300 hover:bg-gray-50'}"
                      onclick={() => {
                        const cur = selectedObject.animations ?? {}
                        emitAnimationChange({
                          ...cur,
                          actions: (cur.actions ?? []).map((a) =>
                            a.id === action.id ? { ...a, duration: ms as number } : a
                          )
                        })
                      }}>{lbl}</button
                    >
                  {/each}
                  <input
                    type="number"
                    min="50"
                    max="5000"
                    value={action.duration}
                    oninput={(e) => {
                      const ms = parseInt((e.target as HTMLInputElement).value)
                      if (!isNaN(ms) && ms > 0) {
                        const cur = selectedObject.animations ?? {}
                        emitAnimationChange(
                          {
                            ...cur,
                            actions: (cur.actions ?? []).map((a) =>
                              a.id === action.id ? { ...a, duration: ms } : a
                            )
                          },
                          true
                        )
                      }
                    }}
                    onblur={handleAnimationBlur}
                    class="w-16 text-xs border border-gray-300 rounded px-1"
                    title="Duration (ms)"
                  />
                </div>
              </div>
            </div>
          {/each}
        </div>

        <!-- Build Out -->
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Build Out</label>
          <select
            class="block w-full rounded border-gray-300 text-xs py-1"
            value={selectedObject.animations?.buildOut?.type ?? 'none'}
            onchange={(e) => {
              const val = (e.target as HTMLSelectElement).value
              const cur = selectedObject.animations ?? {}
              if (val === 'none') {
                const rest = Object.fromEntries(
                  Object.entries(cur).filter(([k]) => k !== 'buildOut')
                ) as ElementAnimations
                emitAnimationChange(rest)
              } else {
                const type = val as 'disappear' | 'fade-out'
                emitAnimationChange({
                  ...cur,
                  buildOut: { type, duration: cur.buildOut?.duration ?? DURATION_NORMAL }
                })
              }
            }}
            onblur={handleAnimationBlur}
          >
            <option value="none">None</option>
            <option value="disappear">Disappear</option>
            <option value="fade-out">Fade Out</option>
          </select>
          {#if selectedObject.animations?.buildOut?.type === 'fade-out'}
            <div class="mt-1 flex gap-1">
              {#each [[DURATION_FAST, 'Fast'], [DURATION_NORMAL, 'Normal'], [DURATION_SLOW, 'Slow']] as [ms, lbl] (ms)}
                <button
                  class="flex-1 py-0.5 text-xs rounded border {selectedObject.animations.buildOut
                    .duration === ms
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-300 hover:bg-gray-50'}"
                  onclick={() => {
                    const cur = selectedObject.animations ?? {}
                    emitAnimationChange({
                      ...cur,
                      buildOut: { type: 'fade-out', duration: ms as number }
                    })
                  }}>{lbl}</button
                >
              {/each}
              <input
                type="number"
                min="50"
                max="5000"
                value={selectedObject.animations.buildOut.duration}
                oninput={(e) => {
                  const ms = parseInt((e.target as HTMLInputElement).value)
                  if (!isNaN(ms) && ms > 0) {
                    const cur = selectedObject.animations ?? {}
                    emitAnimationChange(
                      { ...cur, buildOut: { type: 'fade-out', duration: ms } },
                      true
                    )
                  }
                }}
                onblur={handleAnimationBlur}
                class="w-16 text-xs border border-gray-300 rounded px-1"
                title="Duration (ms)"
              />
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <!-- Slide background controls when nothing is selected -->
    <div class="space-y-3">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide">Slide Background</p>

      <!-- Type selector tabs -->
      <div class="flex rounded-md border border-gray-300 overflow-hidden text-xs">
        {#each ['solid', 'gradient', 'image'] as t (t)}
          <button
            class="flex-1 py-1 {activeTab === t
              ? 'bg-indigo-600 text-white'
              : 'bg-white text-gray-600 hover:bg-gray-50'}"
            onclick={() => {
              activeTab = t as 'solid' | 'gradient' | 'image'
              if (t === 'gradient' && currentBg?.type !== 'gradient') {
                emitGradient(90, '#4f46e5', '#7c3aed')
              } else if (t === 'solid' && currentBg?.type !== 'solid') {
                emitSolid('#ffffff')
              }
            }}>{t}</button
          >
        {/each}
      </div>

      {#if activeTab === 'solid'}
        <div>
          <label class="block text-sm font-medium text-gray-600">Color</label>
          <input
            type="color"
            value={currentBg?.type === 'solid' ? currentBg.color : '#ffffff'}
            oninput={(e) => emitSolid((e.target as HTMLInputElement).value)}
            class="mt-1 block w-full rounded-md border-gray-300 shadow-sm h-8"
          />
        </div>
      {:else if activeTab === 'gradient'}
        <div class="space-y-2">
          <div>
            <label class="block text-sm font-medium text-gray-600">Start Color</label>
            <input
              type="color"
              value={currentBg?.type === 'gradient' ? currentBg.stops[0].color : '#4f46e5'}
              oninput={(e) =>
                emitGradient(
                  currentBg?.type === 'gradient' ? currentBg.angle : 90,
                  (e.target as HTMLInputElement).value,
                  currentBg?.type === 'gradient' ? currentBg.stops[1].color : '#7c3aed'
                )}
              class="mt-1 block w-full rounded-md border-gray-300 shadow-sm h-8"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-600">End Color</label>
            <input
              type="color"
              value={currentBg?.type === 'gradient' ? currentBg.stops[1].color : '#7c3aed'}
              oninput={(e) =>
                emitGradient(
                  currentBg?.type === 'gradient' ? currentBg.angle : 90,
                  currentBg?.type === 'gradient' ? currentBg.stops[0].color : '#4f46e5',
                  (e.target as HTMLInputElement).value
                )}
              class="mt-1 block w-full rounded-md border-gray-300 shadow-sm h-8"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-600">Angle</label>
            <div class="flex gap-1 mt-1 flex-wrap">
              {#each [[0, '→'], [90, '↓'], [45, '↘'], [135, '↙'], [180, '←'], [270, '↑']] as [deg, label] (deg)}
                <button
                  class="flex-1 py-1 text-xs rounded border {currentBg?.type === 'gradient' &&
                  currentBg.angle === deg
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-300 hover:bg-gray-50'}"
                  onclick={() =>
                    emitGradient(
                      deg as number,
                      currentBg?.type === 'gradient' ? currentBg.stops[0].color : '#4f46e5',
                      currentBg?.type === 'gradient' ? currentBg.stops[1].color : '#7c3aed'
                    )}>{label}</button
                >
              {/each}
            </div>
          </div>
        </div>
      {:else if activeTab === 'image'}
        <div class="space-y-2">
          {#if currentBg?.type === 'image'}
            <div class="rounded overflow-hidden border border-gray-200">
              <img src={currentBg.src} alt="slide background" class="w-full object-cover h-16" />
            </div>
            <p class="text-xs text-gray-400 truncate">{currentBg.filename ?? 'image'}</p>
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Fit</label>
              <div class="flex rounded-md border border-gray-300 overflow-hidden text-xs">
                {#each [['stretch', 'Stretch'], ['contain', 'Fit'], ['cover', 'Cover']] as [val, label] (val)}
                  <button
                    class="flex-1 py-1 {(currentBg.fit ?? 'cover') === val
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'}"
                    onclick={() => emitImageFit(val as 'stretch' | 'contain' | 'cover')}
                    >{label}</button
                  >
                {/each}
              </div>
            </div>
          {/if}
          <button
            onclick={pickImageBackground}
            class="w-full py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700"
            >{currentBg?.type === 'image' ? 'Change Image' : 'Choose Image...'}</button
          >
          {#if currentBg?.type === 'image'}
            <button
              onclick={() => emitSolid('#ffffff')}
              class="w-full py-1 text-xs text-red-500 hover:underline">Remove image</button
            >
          {/if}
        </div>
      {/if}

      <div class="border-t border-gray-200 pt-3 space-y-1.5">
        <button
          onclick={() => onSetAsDefault?.(currentBg ?? null)}
          class="w-full py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-50 active:bg-gray-100 text-gray-600"
          >Set as default for new slides</button
        >
        <button
          onclick={() => onApplyToAll?.(currentBg ?? null)}
          class="w-full py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-50 active:bg-gray-100 text-gray-600"
          >Apply to all slides</button
        >
      </div>

      <!-- Slide transition controls -->
      <div class="border-t border-gray-200 pt-3 space-y-2">
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide">Slide Transition</p>
        <div class="flex rounded-md border border-gray-300 overflow-hidden text-xs">
          {#each [['none', 'None'], ['dissolve', 'Dissolve'], ['push', 'Push']] as [val, label] (val)}
            <button
              class="flex-1 py-1 {(slideTransition?.type ?? 'none') === val
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50'}"
              onclick={() => {
                if (val === 'none') {
                  onSlideTransitionChange?.(undefined)
                } else {
                  onSlideTransitionChange?.({
                    type: val as 'dissolve' | 'push',
                    duration: slideTransition?.duration ?? 0.4
                  })
                }
              }}>{label}</button
            >
          {/each}
        </div>
        {#if slideTransition && slideTransition.type !== 'none'}
          <div>
            <label class="block text-xs font-medium text-gray-500 mb-1">
              Duration: {slideTransition.duration.toFixed(2)}s
            </label>
            <input
              type="range"
              min="0.1"
              max="2.0"
              step="0.05"
              value={slideTransition.duration}
              oninput={(e) => {
                const dur = parseFloat((e.target as HTMLInputElement).value)
                onSlideTransitionChange?.({ ...slideTransition!, duration: dur })
              }}
              class="w-full"
            />
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
