<script lang="ts">
  import { tick } from 'svelte'
  import { _ } from 'svelte-i18n'

  interface Props {
    open: boolean
    errorMessage: string
    onCloseAnyway: () => void
    onCancel: () => void
  }

  let { open, errorMessage, onCloseAnyway, onCancel }: Props = $props()
  let dialogEl: HTMLDivElement | null = null
  let previousFocusedElement: HTMLElement | null = null

  function getFocusableElements(): HTMLElement[] {
    if (!dialogEl) return []

    return Array.from(
      dialogEl.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !element.matches(':disabled') && element.tabIndex >= 0)
  }

  function cancel(): void {
    onCancel()
  }

  function closeAnyway(): void {
    onCloseAnyway()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      cancel()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const focusable = getFocusableElements()
    if (focusable.length === 0) {
      event.preventDefault()
      dialogEl?.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement

    if (event.shiftKey) {
      if (active === first || !dialogEl?.contains(active)) {
        event.preventDefault()
        last.focus()
      }
      return
    }

    if (active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  $effect(() => {
    if (!open) return

    previousFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    void tick().then(() => {
      const focusable = getFocusableElements()
      if (focusable.length > 0) {
        focusable[0].focus()
      } else {
        dialogEl?.focus()
      }
    })

    return () => {
      previousFocusedElement?.focus()
      previousFocusedElement = null
    }
  })
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/45"
    onclick={(event) => {
      if (event.target === event.currentTarget) cancel()
    }}
    onkeydown={onKeydown}
    role="dialog"
    aria-modal="true"
    aria-label={$_('close_failure.title')}
  >
    <div
      bind:this={dialogEl}
      class="w-[520px] max-w-[calc(100vw-2rem)] rounded-2xl bg-white shadow-2xl"
      tabindex="-1"
    >
      <div class="border-b border-red-100 px-6 py-5">
        <div class="mb-3 flex items-center gap-3 text-red-700">
          <div class="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
            <svg class="h-5 w-5" viewBox="0 0 256 256" fill="currentColor">
              <path
                d="M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"
              />
            </svg>
          </div>
          <h2 class="text-lg font-semibold text-gray-900">{$_('close_failure.title')}</h2>
        </div>
        <p class="text-sm leading-6 text-gray-600">{$_('close_failure.body')}</p>
        {#if errorMessage}
          <pre
            class="mt-4 overflow-x-auto rounded-xl bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-700 whitespace-pre-wrap"
          >
{errorMessage}</pre
          >
        {/if}
      </div>

      <div class="flex flex-col-reverse gap-2 px-6 py-5 sm:flex-row sm:justify-end">
        <button
          onclick={cancel}
          class="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {$_('close_failure.cancel')}
        </button>
        <button
          onclick={closeAnyway}
          class="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
        >
          {$_('close_failure.close_anyway')}
        </button>
      </div>
    </div>
  </div>
{/if}
