<script lang="ts">
  import { _ } from 'svelte-i18n'
  import { renderLatexToSvgDataUrl, type RenderResult, type RenderedMath } from '../lib/math'

  interface Props {
    open: boolean
    initialLatex: string
    mode: 'insert' | 'edit'
    onCommit: (result: { latex: string; rendered: RenderedMath }) => void
    onClose: () => void
  }

  let { open, initialLatex, mode, onCommit, onClose }: Props = $props()

  let latex = $state('')
  let lastResult = $state<RenderResult | null>(null)
  let renderingError = $state<string | null>(null)
  let previewSrc = $state<string | null>(null)
  let editorContainer: HTMLDivElement | null = $state(null)
  let editorView: unknown = null

  // Lazy-import handles. Cached across reopens.
  let editorModulesPromise: Promise<EditorModules> | null = null

  type EditorModules = {
    EditorState: typeof import('@codemirror/state').EditorState
    EditorView: typeof import('@codemirror/view').EditorView
    keymap: typeof import('@codemirror/view').keymap
    StreamLanguage: typeof import('@codemirror/language').StreamLanguage
    syntaxHighlighting: typeof import('@codemirror/language').syntaxHighlighting
    defaultHighlightStyle: typeof import('@codemirror/language').defaultHighlightStyle
    defaultKeymap: typeof import('@codemirror/commands').defaultKeymap
    history: typeof import('@codemirror/commands').history
    historyKeymap: typeof import('@codemirror/commands').historyKeymap
    stex: typeof import('@codemirror/legacy-modes/mode/stex').stex
  }

  async function loadEditorModules(): Promise<EditorModules> {
    if (!editorModulesPromise) {
      editorModulesPromise = (async () => {
        const [stateMod, viewMod, languageMod, commandsMod, stexMod] = await Promise.all([
          import('@codemirror/state'),
          import('@codemirror/view'),
          import('@codemirror/language'),
          import('@codemirror/commands'),
          import('@codemirror/legacy-modes/mode/stex')
        ])
        return {
          EditorState: stateMod.EditorState,
          EditorView: viewMod.EditorView,
          keymap: viewMod.keymap,
          StreamLanguage: languageMod.StreamLanguage,
          syntaxHighlighting: languageMod.syntaxHighlighting,
          defaultHighlightStyle: languageMod.defaultHighlightStyle,
          defaultKeymap: commandsMod.defaultKeymap,
          history: commandsMod.history,
          historyKeymap: commandsMod.historyKeymap,
          stex: stexMod.stex
        }
      })()
    }
    return editorModulesPromise
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRender(value: string): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runRender(value)
    }, 200)
  }

  async function runRender(value: string): Promise<void> {
    const result = await renderLatexToSvgDataUrl(value)
    // Discard stale results if a newer keystroke is now in the editor.
    if (value !== latex) return
    lastResult = result
    if (result.ok === true) {
      previewSrc = result.rendered.src
      renderingError = null
    } else if (result.ok === false) {
      previewSrc = null
      renderingError = result.error
    }
  }

  // Initialize / re-seed when the modal opens.
  $effect(() => {
    if (!open) return
    latex = initialLatex
    lastResult = null
    previewSrc = null
    renderingError = null
    void initializeEditor()
    void runRender(initialLatex)
  })

  async function initializeEditor(): Promise<void> {
    const mods = await loadEditorModules()
    if (!editorContainer) return
    destroyEditor()
    const updateListener = mods.EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      const value = update.state.doc.toString()
      latex = value
      scheduleRender(value)
    })
    const startState = mods.EditorState.create({
      doc: latex,
      extensions: [
        mods.history(),
        mods.keymap.of([...mods.defaultKeymap, ...mods.historyKeymap]),
        mods.StreamLanguage.define(mods.stex),
        mods.syntaxHighlighting(mods.defaultHighlightStyle, { fallback: true }),
        mods.EditorView.lineWrapping,
        mods.EditorView.theme({
          '&': { fontSize: '13px' },
          '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          '.cm-scroller': { lineHeight: '1.5' }
        }),
        updateListener
      ]
    })
    const view = new mods.EditorView({ state: startState, parent: editorContainer })
    editorView = view
    view.focus()
  }

  function destroyEditor(): void {
    if (editorView && typeof (editorView as { destroy: () => void }).destroy === 'function') {
      ;(editorView as { destroy: () => void }).destroy()
    }
    editorView = null
  }

  function close(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    destroyEditor()
    onClose()
  }

  function commit(): void {
    if (!lastResult?.ok) return
    onCommit({ latex, rendered: lastResult.rendered })
    close()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
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
    tabindex="-1"
    aria-modal="true"
    aria-label={$_('math.editor.title')}
  >
    <div class="bg-white rounded-xl shadow-2xl w-[640px] max-w-[calc(100vw-2rem)] flex flex-col">
      <!-- Header -->
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <h2 class="text-base font-semibold text-gray-900">{$_('math.editor.title')}</h2>
        <button
          onclick={close}
          class="text-gray-400 hover:text-gray-600 rounded-md p-1 focus:outline-none"
          aria-label={$_('math.editor.cancel')}
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
      <div class="px-6 py-5 space-y-4">
        <!-- LaTeX editor -->
        <div>
          <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            {$_('math.editor.latex_label')}
          </p>
          <div
            bind:this={editorContainer}
            class="border border-gray-200 rounded-md min-h-[110px] max-h-[200px] overflow-auto focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500"
          ></div>
        </div>

        <!-- Preview -->
        <div>
          <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            {$_('math.editor.preview_label')}
          </p>
          <div
            class="border border-gray-200 rounded-md bg-gray-50 px-4 py-6 flex items-center justify-center min-h-[100px]"
          >
            {#if previewSrc && !renderingError}
              <img src={previewSrc} alt="" class="max-w-full max-h-32" />
            {:else if renderingError}
              <span class="text-xs text-red-600 font-mono">
                {$_('math.editor.error_prefix')}{renderingError}
              </span>
            {:else}
              <span class="text-xs text-gray-400">…</span>
            {/if}
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
        <button
          onclick={close}
          class="px-4 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md"
        >
          {$_('math.editor.cancel')}
        </button>
        <button
          onclick={commit}
          disabled={!lastResult?.ok}
          class="px-4 py-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:bg-indigo-300 disabled:cursor-not-allowed"
        >
          {mode === 'edit' ? $_('math.editor.save') : $_('math.editor.insert')}
        </button>
      </div>
    </div>
  </div>
{/if}
