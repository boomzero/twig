<!--
  PresentationView Component

  Fullscreen presentation mode for twig.
  Displays slides in a clean, fullscreen view without editing controls.

  Features:
  - Fullscreen display with dark background
  - Scales to fit screen while maintaining aspect ratio
  - Keyboard navigation (arrow keys, space, escape)
  - Slide counter
  - Designed to support animations in the future
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { appState, loadSlide } from '../lib/state.svelte'
  import type { DeckElement } from '../lib/state.svelte'
  import { Canvas, IText, Rect, FabricImage, type FabricObject } from 'fabric'

  // Props
  interface Props {
    onExit: () => void
  }
  let { onExit }: Props = $props()

  // Component state
  let containerEl: HTMLDivElement
  let canvasEl: HTMLCanvasElement
  let presentationCanvas: Canvas | undefined

  // Canvas dimensions
  const SLIDE_WIDTH = 800
  const SLIDE_HEIGHT = 600

  // Animation state (placeholder for future animation support)
  let isTransitioning = $state(false)
  let transitionDirection: 'forward' | 'backward' = 'forward'

  // Track current slide to detect changes
  let lastRenderedSlideId: string | null = null

  // ============================================================================
  // Lifecycle
  // ============================================================================

  onMount(() => {
    // Initialize the presentation canvas
    if (canvasEl) {
      presentationCanvas = new Canvas(canvasEl, {
        selection: false,
        interactive: false,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        backgroundColor: '#ffffff'
      })

      // Initial render
      renderCurrentSlide()

      // Scale to fit screen
      scaleCanvas()
    }

    // Add event listeners
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', scaleCanvas)
  })

  onDestroy(() => {
    // Clean up event listeners first
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener('resize', scaleCanvas)

    // Dispose canvas
    if (presentationCanvas) {
      presentationCanvas.dispose()
      presentationCanvas = undefined
    }
  })

  // ============================================================================
  // Scaling
  // ============================================================================

  /**
   * Scales the canvas container to fit the screen while maintaining aspect ratio
   */
  function scaleCanvas(): void {
    if (!containerEl) return

    const maxWidth = window.innerWidth * 0.9
    const maxHeight = window.innerHeight * 0.9

    const scaleX = maxWidth / SLIDE_WIDTH
    const scaleY = maxHeight / SLIDE_HEIGHT
    const scale = Math.min(scaleX, scaleY)

    const scaledWidth = SLIDE_WIDTH * scale
    const scaledHeight = SLIDE_HEIGHT * scale

    containerEl.style.width = `${scaledWidth}px`
    containerEl.style.height = `${scaledHeight}px`
  }

  // ============================================================================
  // Rendering
  // ============================================================================

  /**
   * Renders the current slide onto the presentation canvas.
   * Creates a read-only view of the slide data.
   */
  function renderCurrentSlide(): void {
    if (!presentationCanvas || !appState.currentSlide) return

    // Clear canvas objects but preserve background
    presentationCanvas.getObjects().forEach(obj => presentationCanvas!.remove(obj))

    const currentSlide = appState.currentSlide
    lastRenderedSlideId = currentSlide.id

    // Process elements - images need async loading
    const imageElements: DeckElement[] = []
    const nonImageElements: DeckElement[] = []

    currentSlide.elements.forEach((element: DeckElement) => {
      if (element.type === 'image') {
        imageElements.push(element)
      } else {
        nonImageElements.push(element)
      }
    })

    // Render non-image elements synchronously
    nonImageElements.forEach((element: DeckElement) => {
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

      if (fabObj) {
        presentationCanvas!.add(fabObj)
      }
    })

    // Render image elements asynchronously
    imageElements.forEach((element: DeckElement) => {
      if (element.src) {
        FabricImage.fromURL(element.src, {
          crossOrigin: 'anonymous'
        }).then((img) => {
          const scaleX = element.width / (img.width || 1)
          const scaleY = element.height / (img.height || 1)

          img.set({
            left: element.x,
            top: element.y,
            angle: element.angle,
            scaleX: scaleX,
            scaleY: scaleY,
            selectable: false,
            evented: false
          })

          presentationCanvas!.add(img)
          presentationCanvas!.renderAll()
        }).catch((error) => {
          console.error('Failed to load image in presentation:', error)
        })
      }
    })

    presentationCanvas.renderAll()
  }

  /**
   * Reactive effect to re-render when the current slide changes.
   */
  $effect(() => {
    // Only re-render if the slide actually changed
    if (appState.currentSlide && presentationCanvas && appState.currentSlide.id !== lastRenderedSlideId) {
      if (isTransitioning) {
        setTimeout(() => {
          renderCurrentSlide()
          isTransitioning = false
        }, 300)
      } else {
        renderCurrentSlide()
      }
    }
  })

  // ============================================================================
  // Navigation
  // ============================================================================

  async function goToNextSlide(): Promise<void> {
    if (appState.currentSlideIndex < appState.slideIds.length - 1) {
      transitionDirection = 'forward'
      const nextSlideId = appState.slideIds[appState.currentSlideIndex + 1]
      await loadSlide(nextSlideId)
    }
  }

  async function goToPreviousSlide(): Promise<void> {
    if (appState.currentSlideIndex > 0) {
      transitionDirection = 'backward'
      const prevSlideId = appState.slideIds[appState.currentSlideIndex - 1]
      await loadSlide(prevSlideId)
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        onExit()
        break
      case 'ArrowRight':
      case ' ':
      case 'PageDown':
        event.preventDefault()
        goToNextSlide()
        break
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault()
        goToPreviousSlide()
        break
      case 'Home':
        event.preventDefault()
        if (appState.slideIds.length > 0) {
          loadSlide(appState.slideIds[0])
        }
        break
      case 'End':
        event.preventDefault()
        if (appState.slideIds.length > 0) {
          loadSlide(appState.slideIds[appState.slideIds.length - 1])
        }
        break
    }
  }
</script>

<div class="presentation-container">
  <div class="presentation-slide" bind:this={containerEl}>
    <canvas bind:this={canvasEl} width={SLIDE_WIDTH} height={SLIDE_HEIGHT}></canvas>
  </div>

  <div class="slide-counter">
    {appState.currentSlideIndex + 1} / {appState.slideIds.length}
  </div>

  <button class="exit-button" onclick={onExit} title="Exit presentation (Esc)">
    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
    </svg>
  </button>
</div>

<style>
  .presentation-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }

  .presentation-slide {
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #ffffff;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  }

  .presentation-slide canvas {
    width: 100% !important;
    height: 100% !important;
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

  .exit-button {
    position: fixed;
    top: 20px;
    right: 30px;
    color: rgba(255, 255, 255, 0.5);
    background: rgba(0, 0, 0, 0.3);
    border: none;
    border-radius: 50%;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: all 0.2s ease;
  }

  .exit-button:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }

  .presentation-container:hover .exit-button {
    opacity: 0.5;
  }
</style>
