<!--
  Presentation Window Component

  Standalone fullscreen window for presenting slides.
  Receives slide state from the main window via IPC and renders using fabric.js.
  Uses setZoom + setDimensions for crisp native-resolution rendering (no CSS scaling blur).
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import {
    Canvas,
    Textbox,
    Rect,
    Ellipse,
    Triangle,
    Polygon,
    FabricImage,
    type FabricObject,
    Gradient,
    Point,
    util
  } from 'fabric'
  import type {
    TwigElement,
    Slide,
    SlideBackground,
    AnimationStep,
    SlideTransition,
    ArrowShape
  } from './lib/types'
  import { DEFAULT_ARROW_SHAPE } from './lib/types'
  import { isStepConfiguredForElement } from './lib/animationUtils'
  import { normalizeFontBytes } from './lib/fontUtils'

  export interface PresentationState {
    /** ID of the slide to display — presentation window fetches the full slide from DB */
    slideId: string | null
    slideIndex: number
    slideCount: number
    /** File path of the current presentation, needed for DB access and font loading. */
    filePath: string | null
  }

  type PresentationFabricObject = FabricObject & { id?: string }

  // ============================================================================
  // Shape Geometry Helpers (must stay in sync with App.svelte)
  // ============================================================================

  function makeArrowPoints(
    w: number,
    h: number,
    shape: ArrowShape
  ): Array<{ x: number; y: number }> {
    const headW = h * shape.headWidthRatio
    const headL = w * shape.headLengthRatio
    const shaftT = headW * shape.shaftThicknessRatio
    const shaftTop = (h - shaftT) / 2
    const shaftBot = (h + shaftT) / 2
    const headTop = (h - headW) / 2
    const headBot = (h + headW) / 2
    return [
      { x: 0, y: shaftTop },
      { x: w - headL, y: shaftTop },
      { x: w - headL, y: headTop },
      { x: w, y: h / 2 },
      { x: w - headL, y: headBot },
      { x: w - headL, y: shaftBot },
      { x: 0, y: shaftBot }
    ]
  }

  const STAR_CANONICAL_W = 200
  const STAR_CANONICAL_H = 200
  function makeStarPoints(): Array<{ x: number; y: number }> {
    const raw = Array.from({ length: 10 }, (_, i) => {
      const angle = (i * 36 - 90) * (Math.PI / 180)
      const r = i % 2 === 0 ? 100 : 42
      return { x: r * Math.cos(angle), y: r * Math.sin(angle) }
    })
    const minX = Math.min(...raw.map((p) => p.x))
    const maxX = Math.max(...raw.map((p) => p.x))
    const minY = Math.min(...raw.map((p) => p.y))
    const maxY = Math.max(...raw.map((p) => p.y))
    const bboxW = maxX - minX
    const bboxH = maxY - minY
    return raw.map((p) => ({
      x: (p.x - minX - bboxW / 2) * (200 / bboxW),
      y: (p.y - minY - bboxH / 2) * (200 / bboxH)
    }))
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
  // Transition overlay state
  let transitionOverlaySrc = $state<string | null>(null)
  let transitionOverlayStyle = $state('')
  let slideWrapperStyle = $state('position: relative;')
  let lastNavigationDirection: 'forward' | 'backward' = 'forward'
  let transitionGeneration = 0
  let hasRenderedOnce = false
  let lastSlideIndex = 0
  let lastSlideTransition: SlideTransition | undefined = undefined
  // Animation state
  const fabObjById = new SvelteMap<string, FabricObject>() // elementId → fabric object
  const elementById = new SvelteMap<string, TwigElement>() // elementId → slide element (rebuilt per render)
  const failedElementIds = new SvelteSet<string>() // image elements that failed to load
  let animProgress = 0 // steps consumed on current slide; reset on every slide entry
  let animating = false // guard against concurrent animations
  let transitioning = false
  // Remembers one advance request that arrived while the next animated image
  // step was still loading, so the slide doesn't appear frozen.
  let pendingAdvanceAfterImageLoad = false
  // Tracks which fonts have been injected in this window so we don't repeat work.
  let loadedFontKeys = new SvelteSet<string>()
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

    // Listen for slide state updates from the main window.
    // Fonts and slide data are fetched in parallel; loadedSlide is only set once
    // BOTH are ready, so the render effect always has fonts available on first draw.
    const unsubState = window.api.presentation.onStateChanged(
      async (newState: PresentationState) => {
        currentState = newState
        const { slideId, filePath } = newState

        if (!slideId || !filePath) {
          loadedSlide = null
          transitionOverlaySrc = null
          transitionOverlayStyle = ''
          transitioning = false
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
      }
    )

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
    const w = SLIDE_WIDTH * scale
    const h = SLIDE_HEIGHT * scale
    presentationCanvas.setDimensions({ width: w, height: h })
    presentationCanvas.setZoom(scale)
    presentationCanvas.renderAll()
    slideWrapperStyle = `position: relative; width: ${w}px; height: ${h}px;`
  }

  // ============================================================================
  // Rendering
  // ============================================================================

  // Render whenever loadedSlide is updated (set only after fonts are ready).
  // Also track slide index direction for push transitions.
  $effect(() => {
    const slide = loadedSlide
    const idx = currentState.slideIndex
    if (slide && presentationCanvas && slide.id !== lastRenderedSlideId) {
      lastNavigationDirection = idx >= lastSlideIndex ? 'forward' : 'backward'
      lastSlideIndex = idx
      handleSlideChange(slide).catch(console.error)
    }
  })

  async function applyPresentationBackground(
    bg: SlideBackground | undefined,
    generation: number
  ): Promise<void> {
    if (!presentationCanvas) return
    const W = SLIDE_WIDTH,
      H = SLIDE_HEIGHT
    presentationCanvas.backgroundImage = undefined
    if (!bg || bg.type === 'solid') {
      presentationCanvas.backgroundColor = bg?.color ?? '#ffffff'
    } else if (bg.type === 'gradient') {
      const rad = (bg.angle * Math.PI) / 180
      const grad = new Gradient({
        type: 'linear',
        coords: {
          x1: W / 2 - Math.cos(rad) * (W / 2),
          y1: H / 2 - Math.sin(rad) * (H / 2),
          x2: W / 2 + Math.cos(rad) * (W / 2),
          y2: H / 2 + Math.sin(rad) * (H / 2)
        },
        colorStops: bg.stops.map((s) => ({ offset: s.offset, color: s.color }))
      })
      presentationCanvas.set({ backgroundColor: grad })
    } else if (bg.type === 'image' && bg.src) {
      presentationCanvas.backgroundColor = '#ffffff'
      const img = await FabricImage.fromURL(bg.src, { crossOrigin: 'anonymous' })
      if (renderGeneration !== generation || !presentationCanvas) return
      const fit = bg.fit ?? 'cover'
      if (fit === 'stretch') {
        img.scaleX = W / (img.width || 1)
        img.scaleY = H / (img.height || 1)
      } else {
        const scale =
          fit === 'contain'
            ? Math.min(W / (img.width || 1), H / (img.height || 1))
            : Math.max(W / (img.width || 1), H / (img.height || 1))
        img.scaleX = scale
        img.scaleY = scale
      }
      img.left = W / 2
      img.top = H / 2
      presentationCanvas.backgroundImage = img
      presentationCanvas.renderAll()
    }
  }

  function captureSlide(): string | null {
    if (!presentationCanvas) return null
    return presentationCanvas.toDataURL({ format: 'jpeg', quality: 0.85 })
  }

  async function handleSlideChange(slide: Slide): Promise<void> {
    const isFirstRender = !hasRenderedOnce
    hasRenderedOnce = true
    const myGeneration = ++transitionGeneration

    // Capture old slide bitmap and its transition config BEFORE rendering the new slide.
    // Per Keynote/PowerPoint convention, the transition on a slide controls leaving that slide.
    const outgoingTransition = isFirstRender ? undefined : lastSlideTransition
    // Record the new slide's transition immediately (before any await) so that if the
    // presenter advances again while images are still loading, the correct outgoing
    // transition is already in place for the next handleSlideChange call.
    lastSlideTransition = slide.transition
    const fromSnap = !isFirstRender ? captureSlide() : null
    if (fromSnap) {
      transitionOverlayStyle = ''
      transitionOverlaySrc = fromSnap
    }

    // Render new slide fully underneath
    await renderSlide(slide)

    if (myGeneration !== transitionGeneration) return

    const t = outgoingTransition
    if (!fromSnap || !t || t.type === 'none') {
      transitionOverlaySrc = null
      transitionOverlayStyle = ''
      transitioning = false
      return
    }

    // Wait two animation frames so the browser paints the initial overlay state
    // before we set the end-state style (otherwise the transition is skipped).
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    if (myGeneration !== transitionGeneration) return

    transitioning = true
    if (t.type === 'dissolve') {
      transitionOverlayStyle = `opacity: 0; transition: opacity ${t.duration}s ease`
    } else if (t.type === 'push') {
      const dir = lastNavigationDirection === 'forward' ? '-100%' : '100%'
      transitionOverlayStyle = `transform: translateX(${dir}); transition: transform ${t.duration}s ease`
    }

    await new Promise<void>((r) => setTimeout(r, t.duration * 1000 + 60))

    if (myGeneration !== transitionGeneration) return
    transitionOverlaySrc = null
    transitionOverlayStyle = ''
    transitioning = false
  }

  async function renderSlide(slide: Slide): Promise<void> {
    if (!presentationCanvas) return

    // Stamp the current generation so async image callbacks from a previous
    // render can detect that the slide has since changed and bail out.
    const generation = ++renderGeneration

    presentationCanvas.remove(...presentationCanvas.getObjects())
    fabObjById.clear()
    elementById.clear()
    failedElementIds.clear()
    animProgress = 0
    animating = false
    pendingAdvanceAfterImageLoad = false
    lastRenderedSlideId = slide.id
    const backgroundLoad = applyPresentationBackground(slide.background, generation).catch(
      console.error
    )

    const sorted = [...slide.elements].sort((a, b) => a.zIndex - b.zIndex)
    const zIndexById = new Map(sorted.map((el) => [el.id, el.zIndex]))
    for (const el of slide.elements) elementById.set(el.id, el)

    sorted.forEach((element: TwigElement) => {
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
          id: element.id,
          selectable: false,
          evented: false
        })
      } else if (element.type === 'ellipse') {
        fabObj = new Ellipse({
          left: element.x,
          top: element.y,
          rx: element.width / 2,
          ry: element.height / 2,
          angle: element.angle,
          fill: element.fill,
          id: element.id,
          selectable: false,
          evented: false
        })
      } else if (element.type === 'triangle') {
        fabObj = new Triangle({
          left: element.x,
          top: element.y,
          width: element.width,
          height: element.height,
          angle: element.angle,
          fill: element.fill,
          id: element.id,
          selectable: false,
          evented: false
        })
      } else if (element.type === 'star') {
        fabObj = new Polygon(makeStarPoints(), {
          left: element.x,
          top: element.y,
          angle: element.angle,
          fill: element.fill,
          id: element.id,
          scaleX: element.width / STAR_CANONICAL_W,
          scaleY: element.height / STAR_CANONICAL_H,
          selectable: false,
          evented: false
        })
      } else if (element.type === 'arrow') {
        const shape = element.arrowShape ?? DEFAULT_ARROW_SHAPE
        // Guard against persisted signed dimensions (pre-fix saves, etc.).
        const w = Math.abs(element.width)
        const h = Math.abs(element.height)
        fabObj = new Polygon(makeArrowPoints(w, h, shape), {
          left: element.x,
          top: element.y,
          angle: element.angle,
          fill: element.fill,
          id: element.id,
          width: w,
          height: h,
          pathOffset: new Point(w / 2, h / 2),
          scaleX: 1,
          scaleY: 1,
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
          id: element.id,
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

      if (fabObj) {
        presentationCanvas!.add(fabObj)
        fabObjById.set(element.id, fabObj)
      }
    })

    // Load images asynchronously. Guard against stale callbacks by comparing
    // the generation counter captured above with the current value.
    const imageLoads: Promise<void>[] = []
    sorted.forEach((element: TwigElement) => {
      if (element.type !== 'image' || !element.src) return
      const load = FabricImage.fromURL(element.src)
        .then((img) => {
          // Slide changed while this image was loading — discard it.
          if (renderGeneration !== generation || !presentationCanvas) return
          img.set({
            left: element.x,
            top: element.y,
            angle: element.angle,
            scaleX: element.width / (img.width || 1),
            scaleY: element.height / (img.height || 1),
            id: element.id,
            selectable: false,
            evented: false
          })
          const insertIndex = (
            presentationCanvas.getObjects() as PresentationFabricObject[]
          ).filter((obj) => (obj.id ? (zIndexById.get(obj.id) ?? 0) : 0) < element.zIndex).length
          presentationCanvas.insertAt(insertIndex, img)
          fabObjById.set(element.id, img)
          applyAnimationStateToObject(slide, element, img)
          presentationCanvas.renderAll()
          continuePendingAdvance(slide, generation)
        })
        .catch((err) => {
          if (renderGeneration !== generation) return
          failedElementIds.add(element.id)
          console.error('Failed to load image in presentation:', err)
          continuePendingAdvance(slide, generation)
        })
      imageLoads.push(load)
    })

    presentationCanvas.renderAll()
    applyInitialAnimationState(slide)

    await Promise.allSettled([backgroundLoad, ...imageLoads])

    if (!presentationCanvas || renderGeneration !== generation || imageLoads.length <= 1) return

    const orderedObjects = (presentationCanvas.getObjects() as PresentationFabricObject[])
      .slice()
      .sort((a, b) => (zIndexById.get(a.id ?? '') ?? 0) - (zIndexById.get(b.id ?? '') ?? 0))

    orderedObjects.forEach((obj, targetIndex) => presentationCanvas!.moveObjectTo(obj, targetIndex))
    presentationCanvas.renderAll()
  }

  function applyAnimationStateToObject(slide: Slide, el: TwigElement, fabObj: FabricObject): void {
    const order = slide.animationOrder
    const completedSteps = order.slice(0, animProgress)
    const buildInDone = completedSteps.some(
      (step) => step.elementId === el.id && step.category === 'buildIn'
    )
    const buildOutDone = completedSteps.some(
      (step) => step.elementId === el.id && step.category === 'buildOut'
    )
    const hasBuildInStep = order.some(
      (step) => step.elementId === el.id && step.category === 'buildIn'
    )
    const hasBuildOutStep = order.some(
      (step) => step.elementId === el.id && step.category === 'buildOut'
    )

    let opacity = 1
    if (hasBuildInStep && !buildInDone) opacity = 0
    if (hasBuildOutStep && buildOutDone) opacity = 0

    let left = el.x
    let top = el.y
    for (const step of completedSteps) {
      if (step.elementId !== el.id || step.category !== 'action' || !step.actionId) continue
      const action = el.animations?.actions?.find((candidate) => candidate.id === step.actionId)
      if (action?.type === 'move') {
        left = action.toX
        top = action.toY
      }
    }

    fabObj.set({ opacity, left, top })
    fabObj.setCoords()
  }

  function applyInitialAnimationState(slide: Slide): void {
    if (!presentationCanvas) return
    for (const el of slide.elements) {
      const fabObj = fabObjById.get(el.id)
      if (!fabObj) continue
      applyAnimationStateToObject(slide, el, fabObj)
    }
    presentationCanvas.renderAll()
  }

  async function runAnimation(
    fabObj: FabricObject,
    el: TwigElement,
    category: AnimationStep['category'],
    actionId?: string
  ): Promise<void> {
    const anim = el.animations!
    const canvas = presentationCanvas!
    return new Promise<void>((resolve) => {
      if (category === 'buildIn' && anim.buildIn?.type === 'appear') {
        // Instant appear
        fabObj.set({ opacity: 1 })
        canvas.renderAll()
        resolve()
      } else if (category === 'buildIn' && anim.buildIn?.type === 'fade-in') {
        util.animate({
          startValue: 0,
          endValue: 1,
          duration: anim.buildIn.duration,
          easing: util.ease.easeInQuad,
          onChange: (v: number) => {
            fabObj.set({ opacity: v })
            canvas.renderAll()
          },
          onComplete: resolve
        })
      } else if (category === 'buildOut' && anim.buildOut?.type === 'disappear') {
        // Instant disappear
        fabObj.set({ opacity: 0 })
        canvas.renderAll()
        resolve()
      } else if (category === 'buildOut' && anim.buildOut?.type === 'fade-out') {
        util.animate({
          startValue: fabObj.opacity as number,
          endValue: 0,
          duration: anim.buildOut.duration,
          easing: util.ease.easeOutQuad,
          onChange: (v: number) => {
            fabObj.set({ opacity: v })
            canvas.renderAll()
          },
          onComplete: resolve
        })
      } else if (category === 'action') {
        const action = anim.actions?.find((a) => a.id === actionId)
        if (action?.type === 'move') {
          const { toX, toY, duration } = action
          const fromX = fabObj.left as number
          const fromY = fabObj.top as number
          util.animate({
            startValue: 0,
            endValue: 1,
            duration,
            easing: util.ease.easeInOutCubic,
            onChange: (v: number) => {
              fabObj.set({ left: fromX + (toX - fromX) * v, top: fromY + (toY - fromY) * v })
              canvas.renderAll()
            },
            onComplete: () => {
              fabObj.setCoords()
              resolve()
            }
          })
        } else {
          resolve()
        }
      } else {
        resolve()
      }
    })
  }

  function continuePendingAdvance(slide: Slide, generation: number): void {
    if (!pendingAdvanceAfterImageLoad || renderGeneration !== generation || animating) return
    pendingAdvanceAfterImageLoad = false
    executeNextAnimation(slide).catch(console.error)
  }

  async function executeNextAnimation(slide: Slide): Promise<void> {
    if (animating) return
    const order = slide.animationOrder

    while (animProgress < order.length) {
      const step = order[animProgress]
      const el = elementById.get(step.elementId)
      if (!el || !isStepConfiguredForElement(el, step)) {
        animProgress++
        continue
      }

      const fabObj = fabObjById.get(step.elementId)
      if (!fabObj) {
        if (failedElementIds.has(step.elementId)) {
          animProgress++
          continue
        }
        pendingAdvanceAfterImageLoad = true
        return
      }

      animating = true
      try {
        await runAnimation(fabObj, el, step.category, step.actionId)
      } finally {
        animating = false
      }
      animProgress++
      return
    }

    // All steps consumed — go to next slide
    window.api.presentation.navigate('next')
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
      await Promise.all(
        embeddedFonts.map((font) => injectFont(font.fontFamily, font.fontData, font.variant))
      )
    } catch (err) {
      fontsLoadedForPath = null
      console.error('Failed to load embedded fonts in presentation window:', err)
    }
  }

  async function injectFont(
    fontFamily: string,
    fontData: unknown,
    variant: string = 'normal-normal'
  ): Promise<void> {
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
        if (animating || transitioning || !loadedSlide) return
        if (animProgress < loadedSlide.animationOrder.length) {
          executeNextAnimation(loadedSlide).catch(console.error)
        } else {
          window.api.presentation.navigate('next')
        }
        break
      case 'ArrowLeft':
      case 'PageUp':
        event.preventDefault()
        if (animating || transitioning || !loadedSlide) return
        pendingAdvanceAfterImageLoad = false
        if (animProgress > 0) {
          animProgress = 0
          applyInitialAnimationState(loadedSlide)
        } else {
          window.api.presentation.navigate('prev')
        }
        break
    }
  }
</script>

<div class="presentation-root">
  <div style={slideWrapperStyle}>
    <canvas bind:this={canvasEl}></canvas>
    {#if transitionOverlaySrc}
      <img
        src={transitionOverlaySrc}
        alt=""
        style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; user-select: none; z-index: 10; {transitionOverlayStyle}"
        aria-hidden="true"
        draggable="false"
      />
    {/if}
  </div>
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
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    font-weight: 500;
    background: rgba(0, 0, 0, 0.5);
    padding: 8px 16px;
    border-radius: 20px;
  }
</style>
