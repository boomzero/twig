<!--
  Presentation Window Component

  Standalone fullscreen window for presenting slides.
  Receives slide state from the main window via IPC and renders using fabric.js.
  Uses setZoom + setDimensions for crisp native-resolution rendering (no CSS scaling blur).
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Canvas, Textbox, Rect, FabricImage, type FabricObject } from 'fabric'
  import type { DeckElement, Slide } from './lib/types'
  import { normalizeFontBytes } from './lib/fontUtils'

  export interface PresentationState {
    /** ID of the slide to display — presentation window fetches the full slide from DB */
    slideId: string | null
    slideIndex: number
    slideCount: number
    /** File path of the current presentation, needed for DB access and font loading. */
    filePath: string | null
  }

  // ============================================================================
  // Constants
  // ============================================================================

  const SLIDE_WIDTH = 960
  const SLIDE_HEIGHT = 540

  // ============================================================================
  // Component state
  // ============================================================================

  let canvasEl: HTMLCanvasElement
  let presentationCanvas: Canvas | undefined
  let currentState = $state<PresentationState>({
    slideId: null,
    slideIndex: 0,
    slideCount: 0,
    filePath: null
  })
  // The full slide data fetched from the DB for the current slideId
  let loadedSlide = $state<Slide | null>(null)
  let lastRenderedSlideId: string | null = null
  // Guards stale async DB slide fetches (incremented on each new fetch).
  let fetchGeneration = 0
  // Guards stale async image loads within renderSlide (incremented on each render).
  let renderGeneration = 0
  // Tracks which fonts have been injected in this window so we don't repeat work.
  let loadedFontKeys = new Set<string>()
  let fontsLoadedForPath: string | null = null
  // Shared promise for the in-progress font load. Concurrent slide navigations
  // to the same file all await this same promise, so none of them render before
  // fonts are ready even if they arrive while loading is still in flight.
  let fontLoadingPromise: Promise<void> = Promise.resolve()

  // ============================================================================
  // Lifecycle
  // ============================================================================

  onMount(() => {
    presentationCanvas = new Canvas(canvasEl, {
      selection: false,
      interactive: false,
      backgroundColor: '#ffffff'
    })

    scaleCanvas()
    renderSlide()

    // Listen for slide state updates from the main window.
    // Fonts and slide data are fetched in parallel; loadedSlide is only set once
    // BOTH are ready, so the render effect always has fonts available on first draw.
    const unsubState = window.api.presentation.onStateChanged(async (newState: PresentationState) => {
      currentState = newState
      const { slideId, filePath } = newState

      if (!slideId || !filePath) {
        loadedSlide = null
        return
      }

      const generation = ++fetchGeneration
      if (filePath !== fontsLoadedForPath) {
        fontLoadingPromise = loadEmbeddedFonts(filePath)
      }
      const [slide] = await Promise.all([
        window.api.db.getSlide(filePath, slideId),
        fontLoadingPromise
      ])
      if (fetchGeneration === generation) loadedSlide = slide
    })

    // Signal main window that we're ready to receive state
    window.api.presentation.signalReady()

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', scaleCanvas)

    return () => {
      unsubState()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', scaleCanvas)
    }
  })

  onDestroy(() => {
    if (presentationCanvas) {
      presentationCanvas.dispose()
      presentationCanvas = undefined
    }
  })

  // ============================================================================
  // Scaling — use setZoom + setDimensions for native pixel rendering (no blur)
  // ============================================================================

  function scaleCanvas(): void {
    if (!presentationCanvas) return
    const scale = Math.min(window.innerWidth / SLIDE_WIDTH, window.innerHeight / SLIDE_HEIGHT)
    presentationCanvas.setDimensions({ width: SLIDE_WIDTH * scale, height: SLIDE_HEIGHT * scale })
    presentationCanvas.setZoom(scale)
    presentationCanvas.renderAll()
  }

  // ============================================================================
  // Rendering
  // ============================================================================

  // Render whenever loadedSlide is updated (set only after fonts are ready).
  $effect(() => {
    const slide = loadedSlide
    if (slide && presentationCanvas && slide.id !== lastRenderedSlideId) {
      renderSlide()
    }
  })

  function renderSlide(): void {
    const slide = loadedSlide
    if (!presentationCanvas || !slide) return

    // Stamp the current generation so async image callbacks from a previous
    // render can detect that the slide has since changed and bail out.
    const generation = ++renderGeneration

    presentationCanvas.getObjects().forEach(obj => presentationCanvas!.remove(obj))
    lastRenderedSlideId = slide.id

    const sorted = [...slide.elements].sort((a, b) => a.zIndex - b.zIndex)

    sorted.forEach((element: DeckElement) => {
      if (element.type === 'image') return
      let fabObj: FabricObject | undefined

      if (element.type === 'rect') {
        fabObj = new Rect({
          left: element.x,
          top: element.y,
          width: element.width,
          height: element.height,
          angle: element.angle,
          fill: element.fill,
          selectable: false,
          evented: false
        })
      } else if (element.type === 'text') {
        fabObj = new Textbox(element.text || '', {
          left: element.x,
          top: element.y,
          width: element.width,
          angle: element.angle,
          fill: element.fill,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          styles: element.styles || {},
          selectable: false,
          evented: false,
          editable: false,
          objectCaching: false,
          lockScalingY: true
        })
      }

      if (fabObj) presentationCanvas!.add(fabObj)
    })

    // Load images asynchronously. Guard against stale callbacks by comparing
    // the generation counter captured above with the current value.
    sorted.forEach((element: DeckElement) => {
      if (element.type !== 'image' || !element.src) return
      FabricImage.fromURL(element.src)
        .then((img) => {
          // Slide changed while this image was loading — discard it.
          if (renderGeneration !== generation || !presentationCanvas) return
          img.set({
            left: element.x,
            top: element.y,
            angle: element.angle,
            scaleX: element.width / (img.width || 1),
            scaleY: element.height / (img.height || 1),
            selectable: false,
            evented: false
          })
          presentationCanvas.add(img)
          presentationCanvas.renderAll()
        })
        .catch((err) => console.error('Failed to load image in presentation:', err))
    })

    presentationCanvas.renderAll()
  }

  // ============================================================================
  // Font Loading
  // ============================================================================

  /**
   * Loads all embedded fonts for a presentation file into the document's
   * FontFaceSet so fabric.js canvas rendering uses the correct typefaces.
   */
  async function loadEmbeddedFonts(filePath: string): Promise<void> {
    fontsLoadedForPath = filePath
    try {
      const embeddedFonts = await window.api.fonts.getEmbeddedFonts(filePath)
      await Promise.all(embeddedFonts.map((font) =>
        injectFont(font.fontFamily, font.fontData, font.variant)
      ))
    } catch (err) {
      fontsLoadedForPath = null
      console.error('Failed to load embedded fonts in presentation window:', err)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function injectFont(fontFamily: string, fontData: any, variant: string = 'normal-normal'): Promise<void> {
    const key = `${fontFamily}-${variant}`
    if (loadedFontKeys.has(key)) return

    try {
      const bytes = normalizeFontBytes(fontData)
      if (!bytes) throw new Error('Unsupported font data type')

      const [weight, style] = variant.split('-')
      const normalizedStyle = style === 'italic' ? 'italic' : 'normal'

      const fontFace = new FontFace(fontFamily, bytes, { weight, style: normalizedStyle })
      await fontFace.load()
      document.fonts.add(fontFace)
      loadedFontKeys.add(key)
    } catch (err) {
      console.error(`Failed to load font ${fontFamily} (${variant}):`, err)
    }
  }

  // ============================================================================
  // Navigation
  // ============================================================================

  function handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        window.api.presentation.exit()
        break
      case 'ArrowRight':
      case ' ':
      case 'PageDown':
        event.preventDefault()
        window.api.presentation.navigate('next')
        break
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault()
        window.api.presentation.navigate('prev')
        break
    }
  }
</script>

<div class="presentation-root">
  <canvas bind:this={canvasEl}></canvas>
  {#if currentState.slideCount > 0}
    <div class="slide-counter">
      {currentState.slideIndex + 1} / {currentState.slideCount}
    </div>
  {/if}
</div>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    background: #000;
    overflow: hidden;
  }

  .presentation-root {
    width: 100vw;
    height: 100vh;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .slide-counter {
    position: fixed;
    bottom: 20px;
    right: 30px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 18px;
    font-family: system-ui, -apple-system, sans-serif;
    font-weight: 500;
    background: rgba(0, 0, 0, 0.5);
    padding: 8px 16px;
    border-radius: 20px;
  }
</style>
