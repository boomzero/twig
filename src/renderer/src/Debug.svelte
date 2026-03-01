<!--
  Debug Window Root Component

  Displays application state updates received from the main window.
-->

<script lang="ts">
  import { onMount } from 'svelte'

  interface DeckElement {
    type: 'rect' | 'text' | 'image'
    id: string
    x: number
    y: number
    width: number
    height: number
    angle: number
    fill?: string
    text?: string
    fontSize?: number
    fontFamily?: string
    styles?: Record<string, any>
    src?: string
    filename?: string
  }

  interface AppState {
    currentFilePath: string | null
    slideIds: string[]
    currentSlideIndex: number
    currentSlideId: string | null
    currentSlideElementCount: number
    selectedObjectId: string | null
    isPresentingMode: boolean
    isTempFile: boolean
    isLoadingSlide: boolean
    currentSlide: {
      id: string
      elements: DeckElement[]
    } | null
  }

  let state = $state<AppState>({
    currentFilePath: null,
    slideIds: [],
    currentSlideIndex: -1,
    currentSlideId: null,
    currentSlideElementCount: 0,
    selectedObjectId: null,
    isPresentingMode: false,
    isTempFile: false,
    isLoadingSlide: false,
    currentSlide: null
  })

  let lastUpdate = $state<string>('')
  let updateCount = $state(0)
  let isLoading = $state(true)

  // Format bytes to human readable size
  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  // Calculate approximate memory size of state
  function getStateSize(): string {
    try {
      const stateString = JSON.stringify(state)
      return formatBytes(new Blob([stateString]).size)
    } catch {
      return 'Unknown'
    }
  }

  // Copy state to clipboard
  async function copyStateToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(state, null, 2))
      alert('State copied to clipboard!')
    } catch (error) {
      console.error('Failed to copy state:', error)
      alert('Failed to copy state to clipboard')
    }
  }

  // Log full state to console
  function logFullState(): void {
    console.group('🔍 Deckhand Application State')
    console.log('State:', state)
    console.log('Last Update:', lastUpdate)
    console.log('Update Count:', updateCount)
    console.log('Full State JSON:', JSON.stringify(state, null, 2))
    console.groupEnd()
    alert('State logged to debug window console! Open DevTools (right-click → Inspect) to view.')
  }

  // Show state as JSON in a new window
  function showStateJson(): void {
    const json = JSON.stringify(state, null, 2)
    const win = window.open('', 'State JSON', 'width=800,height=600')
    if (win) {
      win.document.write(`
        <html>
          <head>
            <title>Deckhand State JSON</title>
            <style>
              body {
                margin: 0;
                padding: 20px;
                font-family: 'Courier New', monospace;
                background: #1e1e1e;
                color: #d4d4d4;
              }
              pre {
                margin: 0;
                white-space: pre-wrap;
                word-wrap: break-word;
              }
              .toolbar {
                position: sticky;
                top: 0;
                background: #2d2d30;
                padding: 10px;
                border-bottom: 1px solid #3e3e42;
                margin-bottom: 10px;
              }
              button {
                background: #0e639c;
                color: white;
                border: none;
                padding: 8px 16px;
                cursor: pointer;
                border-radius: 3px;
                font-size: 14px;
              }
              button:hover {
                background: #1177bb;
              }
            </style>
          </head>
          <body>
            <div class="toolbar">
              <button onclick="navigator.clipboard.writeText(document.querySelector('pre').textContent).then(() => alert('Copied to clipboard!'))">
                Copy to Clipboard
              </button>
            </div>
            <pre>${json}</pre>
          </body>
        </html>
      `)
      win.document.close()
    }
  }

  onMount(() => {
    isLoading = false

    // Listen for state updates from the main window
    if (window.api?.debug?.onStateUpdate) {
      window.api.debug.onStateUpdate((newState: AppState) => {
        state = newState
        lastUpdate = new Date().toLocaleTimeString()
        updateCount++
      })
    }

    // Request initial state
    if (window.api?.debug?.requestState) {
      window.api.debug.requestState()
    }
  })
</script>

<div class="min-h-screen bg-gray-50 p-4">
  <div class="max-w-4xl mx-auto">
    {#if isLoading}
      <div class="bg-white rounded-lg shadow-lg p-12 text-center">
        <div class="text-gray-500 text-lg">Loading debug panel...</div>
      </div>
    {:else if !window.api?.debug}
      <div class="bg-white rounded-lg shadow-lg p-12 text-center">
        <div class="text-red-600 text-lg font-semibold mb-4">Debug API Not Available</div>
        <div class="text-gray-600 text-sm">
          <p class="mb-2">The debug API is not properly loaded.</p>
          <p>Try refreshing the window or restarting the application.</p>
        </div>
        <button
          onclick={() => location.reload()}
          class="mt-6 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
        >
          Reload Window
        </button>
      </div>
    {:else}
    <!-- Header -->
    <div class="bg-gray-800 text-white px-6 py-4 rounded-t-lg">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-xl font-bold">Deckhand Debug Panel</h1>
          <p class="text-sm text-gray-300 mt-1">Real-time application state monitor</p>
        </div>
        <div class="text-right text-sm">
          <div class="text-gray-300">Last Update</div>
          <div class="font-mono">{lastUpdate || 'Waiting for data...'}</div>
          <div class="text-xs text-gray-400 mt-1">Updates: {updateCount}</div>
          {#if updateCount === 0}
            <div class="text-xs text-yellow-400 mt-2">No updates yet - check console</div>
          {/if}
        </div>
      </div>
    </div>

    <!-- Content -->
    <div class="bg-white rounded-b-lg shadow-lg p-6 space-y-6">
      <!-- File Info -->
      <section>
        <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">File Information</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm font-mono">
          <div class="flex justify-between">
            <span class="text-gray-600">Current File:</span>
            <span class="text-gray-900 truncate ml-4 max-w-md" title={state.currentFilePath || 'Unsaved'}>
              {state.currentFilePath || 'Unsaved'}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">Persistence Mode:</span>
            <span class="text-gray-900">
              {state.isTempFile ? 'Temp DB (unsaved)' : 'Saved to disk'}
            </span>
          </div>
        </div>
      </section>

      <!-- Slide Info -->
      <section>
        <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">Slide Information</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm font-mono">
          <div class="flex justify-between">
            <span class="text-gray-600">Total Slides:</span>
            <span class="text-gray-900 font-bold">{state.slideIds.length}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">Current Slide Index:</span>
            <span class="text-gray-900">{state.currentSlideIndex + 1} of {state.slideIds.length}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">Current Slide ID:</span>
            <span class="text-gray-900 truncate ml-4 max-w-md" title={state.currentSlideId || 'None'}>
              {state.currentSlideId || 'None'}
            </span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">Elements on Slide:</span>
            <span class="text-gray-900 font-bold">{state.currentSlideElementCount}</span>
          </div>
        </div>
      </section>

      <!-- Selection Info -->
      <section>
        <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">Selection State</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm font-mono">
          <div class="flex justify-between">
            <span class="text-gray-600">Selected Object ID:</span>
            <span class="text-gray-900">
              {state.selectedObjectId || 'None'}
            </span>
          </div>
        </div>
      </section>

      <!-- Loading State -->
      <section>
        <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">Loading State</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm font-mono">
          <div class="flex justify-between">
            <span class="text-gray-600">Is Loading Slide:</span>
            <span class:text-yellow-600={state.isLoadingSlide} class:text-gray-900={!state.isLoadingSlide} class="font-bold">
              {state.isLoadingSlide ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
      </section>

      <!-- Presentation Mode -->
      <section>
        <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">Presentation</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm font-mono">
          <div class="flex justify-between">
            <span class="text-gray-600">Is Presenting:</span>
            <span class:text-green-600={state.isPresentingMode} class:text-gray-900={!state.isPresentingMode} class="font-bold">
              {state.isPresentingMode ? 'Yes' : 'No'}
            </span>
          </div>
        </div>
      </section>

      <!-- Memory Usage -->
      <section>
        <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">Memory</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2 text-sm font-mono">
          <div class="flex justify-between">
            <span class="text-gray-600">Approx. State Size:</span>
            <span class="text-gray-900">{getStateSize()}</span>
          </div>
        </div>
      </section>

      <!-- Slide IDs List -->
      {#if state.slideIds.length > 0}
        <section>
          <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">All Slide IDs</h2>
          <div class="bg-gray-50 rounded-lg p-4 max-h-48 overflow-y-auto">
            <div class="text-xs font-mono space-y-1">
              {#each state.slideIds as slideId, index}
                <div class:text-indigo-600={slideId === state.currentSlideId} class:font-bold={slideId === state.currentSlideId}>
                  {index + 1}. {slideId}
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/if}

      <!-- Current Slide Details -->
      {#if state.currentSlide}
        <section>
          <h2 class="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">Current Slide Details</h2>
          <div class="bg-gray-50 rounded-lg p-4">
            <div class="text-sm font-mono space-y-1 mb-3">
              <div class="flex justify-between">
                <span class="text-gray-600">Slide ID:</span>
                <span class="text-gray-900 font-bold">{state.currentSlide.id}</span>
              </div>
              <div class="flex justify-between">
                <span class="text-gray-600">Elements:</span>
                <span class="text-gray-900 font-bold">{state.currentSlide.elements.length}</span>
              </div>
            </div>

            {#if state.currentSlide.elements.length > 0}
              <div class="border-t border-gray-300 pt-3 mt-3">
                <h3 class="text-xs font-semibold text-gray-700 mb-2 uppercase">Elements:</h3>
                <div class="space-y-4 max-h-96 overflow-y-auto">
                  {#each state.currentSlide.elements as element, index}
                    <div
                      class="bg-white rounded-md p-3 border-l-4"
                      class:border-indigo-500={element.id === state.selectedObjectId}
                      class:border-gray-300={element.id !== state.selectedObjectId}
                    >
                      <div class="flex items-center justify-between mb-2">
                        <div class="flex items-center gap-2">
                          <span class="text-xs font-bold text-gray-500">#{index + 1}</span>
                          <span class="px-2 py-0.5 text-xs font-semibold rounded"
                            class:bg-blue-100={element.type === 'rect'}
                            class:bg-green-100={element.type === 'text'}
                            class:bg-purple-100={element.type === 'image'}
                            class:text-blue-800={element.type === 'rect'}
                            class:text-green-800={element.type === 'text'}
                            class:text-purple-800={element.type === 'image'}
                          >
                            {element.type.toUpperCase()}
                          </span>
                          {#if element.id === state.selectedObjectId}
                            <span class="px-2 py-0.5 text-xs font-semibold rounded bg-indigo-100 text-indigo-800">
                              SELECTED
                            </span>
                          {/if}
                        </div>
                      </div>

                      <div class="text-xs font-mono space-y-1">
                        <div class="text-gray-500 text-[10px] break-all mb-1">ID: {element.id}</div>

                        <!-- Position & Size -->
                        <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                          <div><span class="text-gray-600">X:</span> <span class="text-gray-900">{Math.round(element.x)}</span></div>
                          <div><span class="text-gray-600">Y:</span> <span class="text-gray-900">{Math.round(element.y)}</span></div>
                          <div><span class="text-gray-600">Width:</span> <span class="text-gray-900">{Math.round(element.width)}</span></div>
                          <div><span class="text-gray-600">Height:</span> <span class="text-gray-900">{Math.round(element.height)}</span></div>
                          <div><span class="text-gray-600">Angle:</span> <span class="text-gray-900">{element.angle}°</span></div>
                          {#if element.fill}
                            <div class="flex items-center gap-1">
                              <span class="text-gray-600">Fill:</span>
                              <span class="text-gray-900">{element.fill}</span>
                              <span class="inline-block w-3 h-3 border border-gray-300 rounded" style="background-color: {element.fill}"></span>
                            </div>
                          {/if}
                        </div>

                        <!-- Type-specific properties -->
                        {#if element.type === 'text'}
                          <div class="border-t border-gray-200 mt-2 pt-2">
                            <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                              {#if element.fontSize}
                                <div><span class="text-gray-600">Font Size:</span> <span class="text-gray-900">{element.fontSize}px</span></div>
                              {/if}
                              {#if element.fontFamily}
                                <div class="col-span-2"><span class="text-gray-600">Font:</span> <span class="text-gray-900">{element.fontFamily}</span></div>
                              {/if}
                              {#if element.text}
                                <div class="col-span-2 mt-1">
                                  <span class="text-gray-600 block mb-1">Text:</span>
                                  <div class="bg-gray-50 p-2 rounded text-xs break-words max-h-20 overflow-y-auto">
                                    {element.text}
                                  </div>
                                </div>
                              {/if}
                              {#if element.styles && Object.keys(element.styles).length > 0}
                                <div class="col-span-2">
                                  <span class="text-gray-600">Has Styles:</span>
                                  <span class="text-gray-900">Yes ({Object.keys(element.styles).length} lines)</span>
                                </div>
                              {/if}
                            </div>
                          </div>
                        {:else if element.type === 'image'}
                          <div class="border-t border-gray-200 mt-2 pt-2">
                            {#if element.filename}
                              <div><span class="text-gray-600">Filename:</span> <span class="text-gray-900">{element.filename}</span></div>
                            {/if}
                            {#if element.src}
                              <div>
                                <span class="text-gray-600">Data URI Size:</span>
                                <span class="text-gray-900">{(element.src.length / 1024).toFixed(1)} KB</span>
                              </div>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {:else}
              <div class="text-center text-gray-500 text-sm py-4">
                No elements on this slide
              </div>
            {/if}
          </div>
        </section>
      {/if}
    </div>

    <!-- Footer with actions -->
    <div class="bg-gray-100 px-6 py-4 rounded-b-lg flex justify-between items-center mt-4">
      <div class="flex gap-2">
        <button
          onclick={logFullState}
          class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm"
          title="Log state to this window's console (open DevTools)"
        >
          Log to Console
        </button>
        <button
          onclick={showStateJson}
          class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 shadow-sm"
          title="Open state JSON in a new window"
        >
          View JSON
        </button>
      </div>
      <button
        onclick={copyStateToClipboard}
        class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 shadow-sm"
        title="Copy state JSON to clipboard"
      >
        Copy to Clipboard
      </button>
    </div>
    {/if}
  </div>
</div>
