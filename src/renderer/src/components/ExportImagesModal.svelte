<script lang="ts">
  import type { ExportImageFormat } from '../lib/exportImages'

  type SlideExportError = {
    slideNumber: number
    slideId: string
    error: string
  }

  interface Props {
    open: boolean
    onClose: () => void
    onExport: (opts: {
      format: ExportImageFormat
      quality: number
      dirPath: string
      onProgress: (done: number, total: number) => void
      onSlideError: (error: SlideExportError) => void
    }) => Promise<void>
  }

  let { open, onClose, onExport }: Props = $props()

  let format = $state<ExportImageFormat>('png')
  let quality = $state(0.92)
  let phase = $state<'ready' | 'exporting' | 'done' | 'error'>('ready')
  let progressDone = $state(0)
  let progressTotal = $state(0)
  let exportDir = $state('')
  let errors = $state<SlideExportError[]>([])
  let fatalError = $state('')

  const isExporting = $derived(phase === 'exporting')
  const exportedCount = $derived(Math.max(0, progressDone - errors.length))
  const qualityPercent = $derived(Math.round(quality * 100))
  const exportButtonLabel = $derived(
    isExporting
      ? progressTotal > 0
        ? `Exporting ${progressDone} / ${progressTotal}...`
        : 'Exporting...'
      : 'Export...'
  )

  function reset(): void {
    format = 'png'
    quality = 0.92
    phase = 'ready'
    progressDone = 0
    progressTotal = 0
    exportDir = ''
    errors = []
    fatalError = ''
  }

  $effect(() => {
    if (open) reset()
  })

  function close(): void {
    if (isExporting) return
    reset()
    onClose()
  }

  async function handleExport(): Promise<void> {
    if (isExporting) return

    const folder = await window.api.dialog.showExportFolderDialog()
    if (!folder) return

    phase = 'exporting'
    progressDone = 0
    progressTotal = 0
    exportDir = folder.dirPath
    errors = []
    fatalError = ''

    try {
      await onExport({
        format,
        quality,
        dirPath: folder.dirPath,
        onProgress: (done, total) => {
          progressDone = done
          progressTotal = total
        },
        onSlideError: (error) => {
          errors = [...errors, error]
        }
      })
      phase = 'done'
    } catch (error) {
      fatalError = error instanceof Error ? error.message : 'Unknown export error'
      phase = 'error'
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      close()
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    onclick={(event) => {
      if (event.target === event.currentTarget) close()
    }}
    onkeydown={onKeydown}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="export-images-title"
  >
    <div class="w-105 max-w-[calc(100vw-2rem)] rounded-xl bg-white shadow-2xl">
      <div class="flex items-center justify-between border-b border-gray-100 px-6 py-4">
        <h2 id="export-images-title" class="text-base font-semibold text-gray-900">
          Export as Images
        </h2>
        <button
          onclick={close}
          disabled={isExporting}
          class="rounded-md p-1 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Close"
        >
          <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <div class="space-y-5 px-6 py-5">
        {#if phase === 'ready' || phase === 'exporting'}
          <section>
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">Format</h3>
            <div class="flex gap-4">
              <label class="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="export-format"
                  value="png"
                  bind:group={format}
                  disabled={isExporting}
                  class="accent-indigo-600"
                />
                PNG
              </label>
              <label class="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
                <input
                  type="radio"
                  name="export-format"
                  value="jpeg"
                  bind:group={format}
                  disabled={isExporting}
                  class="accent-indigo-600"
                />
                JPEG
              </label>
            </div>
          </section>

          {#if format === 'jpeg'}
            <section>
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-xs font-semibold uppercase tracking-wide text-gray-500">Quality</h3>
                <span class="text-xs text-gray-500">{qualityPercent}%</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="1"
                step="0.02"
                bind:value={quality}
                disabled={isExporting}
                class="w-full accent-indigo-600"
              />
            </section>
          {/if}
        {/if}

        <div class="min-h-6 text-sm" aria-live="polite">
          {#if phase === 'exporting'}
            <p class="text-gray-600">{exportButtonLabel}</p>
          {:else if phase === 'done'}
            <p class="text-gray-700">
              Exported {exportedCount} of {progressTotal} slides to
              <span class="break-all font-medium text-gray-900">{exportDir}</span>.
            </p>
            {#if errors.length > 0}
              <div class="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p class="text-xs font-semibold text-amber-800">
                  {errors.length} slide{errors.length === 1 ? '' : 's'} failed
                </p>
                <ul class="mt-2 space-y-1 text-xs text-amber-900">
                  {#each errors as error (error.slideId)}
                    <li>
                      Slide {error.slideNumber}: {error.error}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          {:else if phase === 'error'}
            <p class="text-red-600">Export failed: {fatalError}</p>
          {/if}
        </div>
      </div>

      <div class="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
        {#if phase === 'done' || phase === 'error'}
          <button
            onclick={close}
            class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            OK
          </button>
        {:else}
          <button
            onclick={close}
            disabled={isExporting}
            class="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onclick={handleExport}
            disabled={isExporting}
            class="min-w-28 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-70"
          >
            {exportButtonLabel}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
