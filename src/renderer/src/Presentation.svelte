<!--
  Presentation Window Component

  Standalone fullscreen window for presenting slides.
  Receives slide state from the main window via IPC and renders using fabric.js.
  Uses setZoom + setDimensions for crisp native-resolution rendering (no CSS scaling blur).
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Canvas, IText, Rect, FabricImage, type FabricObject } from 'fabric'

  // ============================================================================
  // Types (mirrored from state.svelte.ts to keep this component self-contained)
  // ============================================================================

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    styles?: Record<string, any>
    src?: string
    filename?: string
    zIndex: number
  }

  interface Slide {
    id: string
    elements: DeckElement[]
  }

  export interface PresentationState {
    slide: Slide | null
    slideIndex: number
    slideCount: number
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
  let currentState = $state<PresentationState>({ slide: null, slideIndex: 0, slideCount: 0 })
  let lastRenderedSlideId: string | null = null

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

  function renderSlide(): void {
    if (!presentationCanvas || !currentState.slide) return

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

    // Load images asynchronously
    sorted.forEach((element: DeckElement) => {
      if (element.type !== 'image' || !element.src) return
      FabricImage.fromURL(element.src)
        .then((img) => {
          if (!presentationCanvas) return
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
