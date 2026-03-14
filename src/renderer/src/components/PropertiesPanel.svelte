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
  import type { SlideBackground } from '../lib/types'

  const {
    onPropertyChange,
    onSlideBackgroundChange,
    onSetAsDefault,
    onApplyToAll
  }: {
    onPropertyChange?: () => void
    onSlideBackgroundChange?: (bg: SlideBackground) => void
    onSetAsDefault?: (bg: SlideBackground | null) => void
    onApplyToAll?: (bg: SlideBackground | null) => void
  } = $props()

  // Reactively compute the currently selected object from app state
  const selectedObject = $derived(
    appState.currentSlide?.elements.find((el) => el.id === appState.selectedObjectId)
  )

  // Current background derived from slide state
  const currentBg = $derived(appState.currentSlide?.background)
  const bgType = $derived(currentBg?.type ?? 'solid')

  let activeTab = $state<'solid' | 'gradient' | 'image'>('solid')

  $effect(() => {
    activeTab = bgType as 'solid' | 'gradient' | 'image'
  })

  function emitSolid(color: string): void {
    onSlideBackgroundChange?.({ type: 'solid', color })
  }

  function emitGradient(angle: number, color1: string, color2: string): void {
    onSlideBackgroundChange?.({
      type: 'gradient',
      angle,
      stops: [{ offset: 0, color: color1 }, { offset: 1, color: color2 }]
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
          oninput={onPropertyChange}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="y" class="block text-sm font-medium text-gray-600">Y Position</label>
        <input
          type="number"
          id="y"
          bind:value={selectedObject.y}
          oninput={onPropertyChange}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="width" class="block text-sm font-medium text-gray-600">Width</label>
        <input
          type="number"
          id="width"
          bind:value={selectedObject.width}
          oninput={onPropertyChange}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="height" class="block text-sm font-medium text-gray-600">Height</label>
        <input
          type="number"
          id="height"
          bind:value={selectedObject.height}
          oninput={onPropertyChange}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
        />
      </div>
      <div>
        <label for="angle" class="block text-sm font-medium text-gray-600">Angle</label>
        <input
          type="number"
          id="angle"
          bind:value={selectedObject.angle}
          oninput={onPropertyChange}
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
          oninput={onPropertyChange}
          class="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
        />
      </div>
      {/if}
    </div>
  {:else}
    <!-- Slide background controls when nothing is selected -->
    <div class="space-y-3">
      <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide">Slide Background</p>

      <!-- Type selector tabs -->
      <div class="flex rounded-md border border-gray-300 overflow-hidden text-xs">
        {#each ['solid', 'gradient', 'image'] as t}
          <button
            class="flex-1 py-1 {activeTab === t ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}"
            onclick={() => {
              activeTab = t as 'solid' | 'gradient' | 'image'
              if (t === 'gradient' && currentBg?.type !== 'gradient') {
                emitGradient(90, '#4f46e5', '#7c3aed')
              } else if (t === 'solid' && currentBg?.type !== 'solid') {
                emitSolid('#ffffff')
              }
            }}
          >{t}</button>
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
              oninput={(e) => emitGradient(
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
              oninput={(e) => emitGradient(
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
              {#each [[0,'→'],[90,'↓'],[45,'↘'],[135,'↙'],[180,'←'],[270,'↑']] as [deg, label]}
                <button
                  class="flex-1 py-1 text-xs rounded border {currentBg?.type === 'gradient' && currentBg.angle === deg ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 hover:bg-gray-50'}"
                  onclick={() => emitGradient(
                    deg as number,
                    currentBg?.type === 'gradient' ? currentBg.stops[0].color : '#4f46e5',
                    currentBg?.type === 'gradient' ? currentBg.stops[1].color : '#7c3aed'
                  )}
                >{label}</button>
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
                {#each [['stretch','Stretch'],['contain','Fit'],['cover','Cover']] as [val, label]}
                  <button
                    class="flex-1 py-1 {(currentBg.fit ?? 'cover') === val ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}"
                    onclick={() => emitImageFit(val as 'stretch' | 'contain' | 'cover')}
                  >{label}</button>
                {/each}
              </div>
            </div>
          {/if}
          <button
            onclick={pickImageBackground}
            class="w-full py-1.5 text-sm rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700"
          >{currentBg?.type === 'image' ? 'Change Image' : 'Choose Image...'}</button>
          {#if currentBg?.type === 'image'}
            <button
              onclick={() => emitSolid('#ffffff')}
              class="w-full py-1 text-xs text-red-500 hover:underline"
            >Remove image</button>
          {/if}
        </div>
      {/if}

      <div class="border-t border-gray-200 pt-3 space-y-1.5">
        <button
          onclick={() => onSetAsDefault?.(currentBg ?? null)}
          class="w-full py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-50 active:bg-gray-100 text-gray-600"
        >Set as default for new slides</button>
        <button
          onclick={() => onApplyToAll?.(currentBg ?? null)}
          class="w-full py-1.5 text-xs rounded-md border border-gray-300 hover:bg-gray-50 active:bg-gray-100 text-gray-600"
        >Apply to all slides</button>
      </div>
    </div>
  {/if}
</div>
