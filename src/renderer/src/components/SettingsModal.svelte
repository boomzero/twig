<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { changeLocale, type SupportedLocale } from '../lib/i18n'
  import { locale } from 'svelte-i18n'

  interface Props {
    open: boolean
  }

  let { open = $bindable() }: Props = $props()

  // Language
  let currentLocale = $derived($locale as SupportedLocale)

  async function handleLocaleChange(l: SupportedLocale): Promise<void> {
    await changeLocale(l)
  }

  const isStoreBuild = window.api?.app?.isStoreBuild ?? false
  const modKeyLabel = navigator.userAgent.includes('Mac') ? 'Cmd' : 'Ctrl'

  // Auto-update
  let autoUpdate = $state(true)
  let autoUpdateLoaded = $state(false)

  // Snap to guides
  let snapToGuides = $state(true)
  let snapToGuidesLoaded = $state(false)

  $effect(() => {
    if (open && !autoUpdateLoaded) {
      window.api?.prefs
        ?.get('autoUpdate')
        .then((val) => {
          autoUpdate = val !== false
          autoUpdateLoaded = true
        })
        .catch(() => {
          // Keep default (true) on failure
          autoUpdateLoaded = true
        })
    }
    if (open && !snapToGuidesLoaded) {
      window.api?.prefs
        ?.get('snapToGuides')
        .then((val) => {
          snapToGuides = val !== false
          snapToGuidesLoaded = true
        })
        .catch(() => {
          snapToGuidesLoaded = true
        })
    }
  })

  // Keep the modal checkbox in sync when toggled from the View menu.
  $effect(() => {
    const unsub = window.api?.app?.onSnapChanged?.((enabled) => {
      snapToGuides = enabled
    })
    return () => unsub?.()
  })

  async function handleAutoUpdateChange(): Promise<void> {
    await window.api?.prefs?.set('autoUpdate', autoUpdate)
  }

  async function handleSnapToGuidesChange(): Promise<void> {
    await window.api?.prefs?.set('snapToGuides', snapToGuides)
  }

  async function openPrivacyPolicy(): Promise<void> {
    await window.api?.app?.openPrivacyPolicy()
  }

  // Manual update check
  type CheckStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error'
  let checkStatus = $state<CheckStatus>('idle')
  let updateFoundVersion = $state<string | null>(null)

  async function checkNow(): Promise<void> {
    checkStatus = 'checking'
    updateFoundVersion = null
    try {
      const result = await window.api?.app?.checkForUpdateManual()
      if (result?.error) {
        checkStatus = 'error'
      } else if (result?.available) {
        checkStatus = 'available'
        updateFoundVersion = result.version ?? null
      } else {
        checkStatus = 'up-to-date'
      }
    } catch {
      checkStatus = 'error'
    }
  }

  let isDownloading = $state(false)

  async function downloadAndInstall(): Promise<void> {
    isDownloading = true
    try {
      await window.api?.app?.downloadAndInstall()
    } catch {
      isDownloading = false
      checkStatus = 'error'
    }
  }

  function close(): void {
    open = false
    checkStatus = 'idle'
    updateFoundVersion = null
    autoUpdateLoaded = false
    snapToGuidesLoaded = false
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close()
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    onclick={(e) => {
      if (e.target === e.currentTarget) close()
    }}
    onkeydown={onKeydown}
    role="dialog"
    aria-modal="true"
    aria-label={$_('settings.title')}
  >
    <div class="bg-white rounded-xl shadow-2xl w-[420px] max-w-[calc(100vw-2rem)] flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 class="text-base font-semibold text-gray-900">{$_('settings.title')}</h2>
        <button
          onclick={close}
          class="text-gray-400 hover:text-gray-600 rounded-md p-1 focus:outline-none"
          aria-label={$_('settings.close')}
        >
          <svg class="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <!-- Body -->
      <div class="px-6 py-5 space-y-6">
        <!-- Language -->
        <section>
          <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {$_('settings.language')}
          </h3>
          <div class="flex gap-3">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="locale"
                value="en"
                checked={currentLocale === 'en'}
                onchange={() => handleLocaleChange('en')}
                class="accent-indigo-600"
              />
              <span class="text-sm text-gray-700">{$_('settings.language.en')}</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="locale"
                value="zh"
                checked={currentLocale === 'zh'}
                onchange={() => handleLocaleChange('zh')}
                class="accent-indigo-600"
              />
              <span class="text-sm text-gray-700">{$_('settings.language.zh')}</span>
            </label>
          </div>
        </section>

        <hr class="border-gray-100" />

        <!-- Editing -->
        <section>
          <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {$_('settings.editing')}
          </h3>
          <label class="flex items-center gap-3 cursor-pointer mb-2">
            <input
              type="checkbox"
              bind:checked={snapToGuides}
              onchange={handleSnapToGuidesChange}
              class="accent-indigo-600 w-4 h-4"
            />
            <span class="text-sm text-gray-700">{$_('settings.snap_to_guides')}</span>
          </label>
          <p class="text-xs text-gray-500 ml-7">
            {$_('settings.snap_to_guides_tip', { values: { key: modKeyLabel } })}
          </p>
        </section>

        <hr class="border-gray-100" />

        <!-- Privacy -->
        <section>
          <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {$_('settings.privacy')}
          </h3>
          <p class="text-sm text-gray-700 mb-3">
            {$_('settings.privacy_body')}
          </p>
          <button
            onclick={openPrivacyPolicy}
            class="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md"
          >
            {$_('settings.privacy_link')}
          </button>
        </section>

        <!-- Divider -->
        {#if !isStoreBuild}<hr class="border-gray-100" />{/if}

        <!-- Updates (hidden on store-managed builds — updater is not available) -->
        {#if !isStoreBuild}
          <section>
            <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {$_('settings.updates')}
            </h3>

            <!-- Auto-update toggle -->
            <label class="flex items-center gap-3 cursor-pointer mb-4">
              <input
                type="checkbox"
                bind:checked={autoUpdate}
                onchange={handleAutoUpdateChange}
                class="accent-indigo-600 w-4 h-4"
              />
              <span class="text-sm text-gray-700">{$_('settings.auto_update')}</span>
            </label>

            <!-- Manual check -->
            <div class="flex items-center gap-3 flex-wrap">
              <button
                onclick={checkNow}
                disabled={checkStatus === 'checking'}
                class="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md disabled:opacity-50"
              >
                {$_('settings.check_now')}
              </button>

              {#if checkStatus === 'checking'}
                <span class="text-xs text-gray-500">{$_('settings.checking')}</span>
              {:else if checkStatus === 'up-to-date'}
                <span class="text-xs text-gray-500">{$_('settings.up_to_date')}</span>
              {:else if checkStatus === 'available' && updateFoundVersion}
                <span class="text-xs text-gray-700">
                  {$_('settings.update_available', { values: { version: updateFoundVersion } })}
                </span>
                <button
                  onclick={downloadAndInstall}
                  disabled={isDownloading}
                  class="px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-md disabled:opacity-50"
                >
                  {isDownloading ? '...' : $_('settings.install_update')}
                </button>
              {:else if checkStatus === 'error'}
                <span class="text-xs text-red-500">{$_('settings.update_error')}</span>
              {/if}
            </div>
          </section>
        {/if}
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-gray-100 flex justify-end">
        <button
          onclick={close}
          class="px-4 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md"
        >
          {$_('settings.close')}
        </button>
      </div>
    </div>
  </div>
{/if}
