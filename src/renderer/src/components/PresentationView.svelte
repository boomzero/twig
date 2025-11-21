<!--
  PresentationView Component

  Fullscreen presentation mode for Deckhand.
  Displays slides in a clean, fullscreen view without editing controls.

  Features:
  - Fullscreen display with dark background
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
  let canvasEl: HTMLCanvasElement
  let presentationCanvas: Canvas | undefined

  // Animation state (placeholder for future animation support)
  let isTransitioning = $state(false)
  let transitionDirection: 'forward' | 'backward' = 'forward'

  // ============================================================================
  // Lifecycle
  // ============================================================================

  onMount(() => {
    // Initialize the presentation canvas
    if (canvasEl) {
      presentationCanvas = new Canvas(canvasEl, {
        selection: false, // Disable selection in presentation mode
        interactive: false, // Disable all interactions
        backgroundColor: '#ffffff' // White slide background
      })
      renderCurrentSlide()
    }

    // Add keyboard event listener
    window.addEventListener('keydown', handleKeyDown)
  })

  onDestroy(() => {
    // Clean up
    window.removeEventListener('keydown', handleKeyDown)
    presentationCanvas?.dispose()
  })

  // ============================================================================
  // Rendering
  // ============================================================================

  /**
   * Renders the current slide onto the presentation canvas.
   * This is similar to renderCanvasFromState in App.svelte but simplified for presentation.
   */
  function renderCurrentSlide(): void {
    if (!presentationCanvas || !appState.currentSlide) return

    // Clear the canvas
    presentationCanvas.clear()

    // Process elements - images need async loading, so handle separately
    const imageElements: DeckElement[] = []
    const nonImageElements: DeckElement[] = []

    appState.currentSlide.elements.forEach((element: DeckElement) => {
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
        // Set center origin for consistent positioning
        fabObj.set({
          originX: 'center',
          originY: 'center'
        })
        presentationCanvas.add(fabObj)
      }
    })

    // Render image elements asynchronously
    imageElements.forEach((element: DeckElement) => {
      if (element.src) {
        FabricImage.fromURL(element.src, {
          crossOrigin: 'anonymous'
        }).then((img) => {
          // Calculate scale to match the stored width/height
          const scaleX = element.width / (img.width || 1)
          const scaleY = element.height / (img.height || 1)

          img.set({
            left: element.x,
            top: element.y,
            angle: element.angle,
            scaleX: scaleX,
            scaleY: scaleY,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false
          })

          presentationCanvas.add(img)
          presentationCanvas.renderAll()
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
    if (appState.currentSlide && presentationCanvas) {
      // FUTURE: This is where slide transition animations would be triggered
      // For now, we just render immediately
      if (isTransitioning) {
        // Placeholder for animation logic
        // Example: fade out current slide, load new slide, fade in
        setTimeout(() => {
          renderCurrentSlide()
          isTransitioning = false
        }, 300) // Animation duration
      } else {
        renderCurrentSlide()
      }
    }
  })

  // ============================================================================
  // Navigation
  // ============================================================================

  /**
   * Navigates to the next slide with optional animation support.
   * FUTURE: Add transition parameter for different animation types
   */
  async function goToNextSlide(): Promise<void> {
    if (appState.currentSlideIndex < appState.slideIds.length - 1) {
      transitionDirection = 'forward'
      // FUTURE: Set isTransitioning = true to trigger animations
      const nextSlideId = appState.slideIds[appState.currentSlideIndex + 1]
      await loadSlide(nextSlideId)
    }
  }

  /**
   * Navigates to the previous slide with optional animation support.
   * FUTURE: Add transition parameter for different animation types
   */
  async function goToPreviousSlide(): Promise<void> {
    if (appState.currentSlideIndex > 0) {
      transitionDirection = 'backward'
      // FUTURE: Set isTransitioning = true to trigger animations
      const prevSlideId = appState.slideIds[appState.currentSlideIndex - 1]
      await loadSlide(prevSlideId)
    }
  }

  /**
   * Handles keyboard navigation in presentation mode.
   */
  function handleKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        onExit()
        break
      case 'ArrowRight':
      case ' ': // Space bar
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

  // ============================================================================
  // Animation Helpers (Placeholder for future implementation)
  // ============================================================================

  /**
   * FUTURE: Apply slide transition animation
   *
   * @param type - Type of transition (fade, slide, zoom, etc.)
   * @param direction - Direction of transition (forward, backward)
   *
   * Example implementations:
   * - 'fade': Cross-fade between slides
   * - 'slide': Slide in from left/right
   * - 'zoom': Zoom in/out effect
   * - 'none': Instant transition (current behavior)
   */
  function applyTransition(type: 'fade' | 'slide' | 'zoom' | 'none' = 'none'): void {
    // Placeholder for future animation logic
    // This function would:
    // 1. Set isTransitioning = true
    // 2. Animate the canvas or container
    // 3. Call renderCurrentSlide() when animation completes
    // 4. Set isTransitioning = false
  }
</script>

<div class="presentation-container">
  <!-- Fullscreen presentation view -->
  <div class="presentation-slide">
    <canvas bind:this={canvasEl} width="800" height="600"></canvas>
  </div>

  <!-- Slide counter (bottom right) -->
  <div class="slide-counter">
    {appState.currentSlideIndex + 1} / {appState.slideIds.length}
  </div>

  <!-- Exit button (top right) - subtle, shows on hover -->
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
    max-width: 90vw;
    max-height: 90vh;
  }

  .presentation-slide canvas {
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    background-color: #ffffff;
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
    backdrop-filter: blur(10px);
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
    backdrop-filter: blur(10px);
  }

  .exit-button:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.2);
    color: white;
  }

  .presentation-container:hover .exit-button {
    opacity: 0.5;
  }

  /* Transition animation placeholder */
  /* FUTURE: Add classes for different transition effects */
  .slide-transition-fade {
    animation: fadeIn 0.3s ease-in-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .slide-transition-slide-forward {
    animation: slideInRight 0.3s ease-in-out;
  }

  @keyframes slideInRight {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }

  .slide-transition-slide-backward {
    animation: slideInLeft 0.3s ease-in-out;
  }

  @keyframes slideInLeft {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }
</style>
