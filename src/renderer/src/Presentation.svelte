<!--
  Presentation Window Component

  Standalone fullscreen window for presenting slides.
  Receives slide state from the main window via IPC and renders using fabric.js.
  Uses setZoom + setDimensions for crisp native-resolution rendering (no CSS scaling blur).
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Canvas, IText, Rect, FabricImage, cache, type FabricObject } from 'fabric'
  import type { DeckElement, Slide } from './lib/types'
  import { fontDataToBase64 } from './lib/fontUtils'

  export interface PresentationState {
    slide: Slide | null
    slideIndex: number
    slideCount: number
    /** File path of the current presentation, needed to load embedded fonts. */
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
    slide: null,
    slideIndex: 0,
    slideCount: 0,
    filePath: null
  })
  let lastRenderedSlideId: string | null = null
  // Monotonically-increasing counter used to detect stale async image loads.
  let renderGeneration = 0
  // Tracks which fonts have been injected in this window so we don't repeat work.
  let loadedFontKeys = new Set<string>()
  let fontsLoadedForPath: string | null = null

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

    // Listen for slide state updates from the main window
    const unsubState = window.api.presentation.onStateChanged((newState: PresentationState) => {
      currentState = newState
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

  $effect(() => {
    const slide = currentState.slide
    if (slide && presentationCanvas && slide.id !== lastRenderedSlideId) {
      renderSlide()
    }
  })

  // Load embedded fonts whenever the presentation file path changes.
  $effect(() => {
    const filePath = currentState.filePath
    if (filePath && filePath !== fontsLoadedForPath) {
      loadEmbeddedFonts(filePath)
    }
  })

  function renderSlide(): void {
    if (!presentationCanvas || !currentState.slide) return

    // Stamp the current generation so async image callbacks from a previous
    // render can detect that the slide has since changed and bail out.
    const generation = ++renderGeneration

    presentationCanvas.getObjects().forEach(obj => presentationCanvas!.remove(obj))
    lastRenderedSlideId = currentState.slide.id

    const sorted = [...currentState.slide.elements].sort((a, b) => a.zIndex - b.zIndex)

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
        fabObj = new IText(element.text || '', {
          left: element.x,
          top: element.y,
          angle: element.angle,
          fill: element.fill,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          styles: element.styles || {},
          selectable: false,
          evented: false,
          editable: false
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
   * Loads embedded fonts from the presentation file and injects them via
   * CSS @font-face so fabric.js renders text with the correct typefaces.
   * After loading, the current slide is re-rendered so any text that was
   * drawn with a fallback font now uses the correct one.
   */
  async function loadEmbeddedFonts(filePath: string): Promise<void> {
    fontsLoadedForPath = filePath
    try {
      const embeddedFonts = await window.api.fonts.getEmbeddedFonts(filePath)
      for (const font of embeddedFonts) {
        await injectFont(font.fontFamily, font.fontData, font.format, font.variant)
      }
      if (embeddedFonts.length > 0) {
        if (document?.fonts?.ready) await document.fonts.ready
        // Re-render so text objects use the newly loaded typefaces.
        renderSlide()
      }
    } catch (err) {
      console.error('Failed to load embedded fonts in presentation window:', err)
    }
  }

  /**
   * Injects a single font as a CSS @font-face rule.
   * Idempotent — calling it twice for the same family+variant is a no-op.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function injectFont(fontFamily: string, fontData: any, format: string, variant: string = 'normal-normal'): Promise<void> {
    const key = `${fontFamily}-${variant}`
    if (loadedFontKeys.has(key)) return

    try {
      const base64 = fontDataToBase64(fontData)
      const normalizedFormat = format === 'ttc' ? 'ttf' : format
      let fontFormat = normalizedFormat
      if (normalizedFormat === 'ttf') fontFormat = 'truetype'
      else if (normalizedFormat === 'otf') fontFormat = 'opentype'

      const [weight, style] = variant.split('-')
      const styleEl = document.createElement('style')
      styleEl.textContent = `
        @font-face {
          font-family: '${fontFamily}';
          src: url(data:font/${normalizedFormat};base64,${base64}) format('${fontFormat}');
          font-weight: ${weight};
          font-style: ${style};
        }
      `
      document.head.appendChild(styleEl)
      loadedFontKeys.add(key)
      // Clear fabric.js font metric cache so text objects re-measure with the new font.
      cache.clearFontCache(fontFamily)
    } catch (err) {
      console.error(`Failed to inject font ${fontFamily}:`, err)
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
