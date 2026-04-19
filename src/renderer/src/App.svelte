<!--
  Main Application Component - App.svelte

  This is the main UI component for twig. It manages:
  - The fabric.js canvas for rendering and editing slides
  - Bi-directional sync between application state and canvas objects
  - Rich text editing capabilities
  - File operations (new, open, save, save as)
  - Keyboard shortcuts and context menus

  Key Architecture Patterns:
  1. State is the source of truth - canvas reflects state
  2. When state changes → canvas re-renders (via $effect)
  3. When canvas objects are modified → state is updated
  4. Selection state is preserved across re-renders when possible

  fabric.js Customization:
  - Objects use center origin (fabric.js v7 default)
  - Objects are extended with an 'id' property to link them to state
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { v4 as uuid_v4 } from 'uuid'
  import { appState, loadPresentation, loadSlide, loadingState } from './lib/state.svelte'
  import { registerFlushSave, unregisterFlushSave } from './lib/saveCallbacks'
  import type { TwigElement, SelectionState } from './lib/state.svelte'
  import type {
    SlideBackground,
    ElementAnimations,
    AnimationStep,
    ActionAnimation,
    SlideTransition,
    Slide
  } from './lib/types'
  import { normalizeAnimationOrder, insertAnimationStep } from './lib/animationUtils'
  import { resolveControlLayout } from './lib/controlLayout'
  import { fontDataToBase64 } from './lib/fontUtils'
  import { getTextboxWrappingOptions, syncTextboxWrapping } from './lib/textboxUtils'
  import {
    Canvas,
    StaticCanvas,
    type FabricObject,
    Textbox,
    Rect,
    Line,
    Ellipse,
    Triangle,
    Polygon,
    FabricImage,
    ActiveSelection,
    Control,
    Point,
    util,
    cache,
    Gradient
  } from 'fabric'
  import { DEFAULT_ARROW_SHAPE, type ArrowShape } from './lib/types'
  import PropertiesPanel from './components/PropertiesPanel.svelte'
  import ContextMenu from './components/ContextMenu.svelte'
  import StackPanel from './components/StackPanel.svelte'
  import AnimationOrderPanel from './components/AnimationOrderPanel.svelte'
  import SettingsModal from './components/SettingsModal.svelte'
  import CloseFailureModal from './components/CloseFailureModal.svelte'
  import TempPresentationGuardModal from './components/TempPresentationGuardModal.svelte'
  import LoadingScreen, { type LoadingPhase } from './components/LoadingScreen.svelte'
  import { PressedKeys } from 'runed'
  import { _ } from 'svelte-i18n'
  import { get } from 'svelte/store'
  import {
    closePresentationWithTempGuard,
    switchPresentationWithTempGuard,
    type TempPresentationPromptChoice
  } from './lib/tempPresentationGuard'
  import { installAlignmentGuides } from './lib/alignment-guides/index'

  // ============================================================================
  // Shape Geometry Helpers
  // ============================================================================

  // Arrow: 7-point right-pointing block arrow parameterized by three ratios.
  // Point order matches the legacy (pre-parameterization) order (CCW from the
  // top-left of the shaft). Indices (used by adjustment-handle positionHandlers):
  //   0: left-top of shaft       (0,       shaftTop)
  //   1: right-top of shaft      (w-headL, shaftTop)
  //   2: head base top           (w-headL, headTop )   ← junction handle anchor
  //   3: tip                     (w,       h/2     )
  //   4: head base bottom        (w-headL, headBot )
  //   5: right-bottom of shaft   (w-headL, shaftBot)
  //   6: left-bottom of shaft    (0,       shaftBot)
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

  /**
   * Ensures an arrow element has its geometry ratios populated. Every code
   * path that inserts or restores an arrow in memory funnels through this,
   * so downstream (properties panel, handles, serialize) can rely on the
   * field being present.
   *
   * Merge-fills partial objects (e.g. from a pasted payload that only carries
   * one of the three ratios) so `undefined` ratios can't leak into
   * makeArrowPoints() and produce NaN polygon points. Short-circuits when the
   * shape is already complete to avoid spurious reactivity.
   */
  function ensureArrowShape(el: TwigElement): void {
    if (el.type !== 'arrow') return
    const s = el.arrowShape
    if (
      s &&
      typeof s.headWidthRatio === 'number' &&
      typeof s.headLengthRatio === 'number' &&
      typeof s.shaftThicknessRatio === 'number'
    ) {
      return
    }
    el.arrowShape = { ...DEFAULT_ARROW_SHAPE, ...(s ?? {}) }
  }

  /**
   * Applies an arrow element's (width, height, arrowShape) to a fabric Polygon.
   * Sets points, resets scale to 1, and pins width/height/pathOffset to the
   * element's nominal bounding box so hit-testing and control placement stay
   * predictable regardless of the ratio values.
   *
   * Intentionally does NOT call Polygon.setBoundingBox(): when headWidthRatio<1
   * the points bbox is smaller than the user's nominal h, and we want the
   * fabric bbox to remain (w, h). pathOffset is supplied explicitly so it
   * tracks the new points.
   *
   * Fabric's polygon geometry (bbox, hit-testing, pathOffset) breaks with
   * negative intrinsic width/height, so Math.abs absorbs the sign from
   * mirrored drags before points are built.
   */
  function applyArrowGeometry(obj: Polygon, el: TwigElement): void {
    const shape = el.arrowShape ?? DEFAULT_ARROW_SHAPE
    const w = Math.abs(el.width)
    const h = Math.abs(el.height)
    obj.set({
      points: makeArrowPoints(w, h, shape),
      width: w,
      height: h,
      pathOffset: new Point(w / 2, h / 2),
      scaleX: 1,
      scaleY: 1,
      dirty: true
    })
    obj.setCoords()
  }

  // Action names for the custom arrow controls. Detected in handleObjectModified
  // so the generic pushCheckpoint()/updateStateFromObject path is skipped
  // (their work is handled inline by the control callbacks).
  const ARROW_HEAD_ACTION = 'arrowHeadAdjust'
  const ARROW_SHAFT_ACTION = 'arrowShaftAdjust'
  const ARROW_HEAD_CONTROL_KEY = 'arrowHead'
  const ARROW_SHAFT_CONTROL_KEY = 'arrowShaft'

  function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v
  }

  // Render the yellow-diamond adjustment handle. Called by fabric for each frame.
  function renderAdjustmentDiamond(ctx: CanvasRenderingContext2D, left: number, top: number): void {
    const size = 7
    ctx.save()
    ctx.translate(left, top)
    ctx.rotate(Math.PI / 4)
    ctx.fillStyle = '#FACC15' // amber-400 — distinct from the default blue corner handles
    ctx.strokeStyle = '#78350F' // amber-900 border for visibility on any background
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.rect(-size, -size, size * 2, size * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Installs two yellow adjustment handles on an arrow Polygon:
   *   - "junction" control (points index 2) adjusts headLengthRatio and headWidthRatio.
   *   - "shaft" control (points index 0) adjusts shaftThicknessRatio.
   *
   * positionHandler mirrors fabric's built-in polyControl pattern so the handles
   * track the polygon correctly under arbitrary rotation/scale (see
   * node_modules/fabric/src/controls/polyControl.ts).
   *
   * actionHandler converts the viewport pointer to the polygon's local point
   * space via util.sendPointToPlane + pathOffset (same as polyActionHandler),
   * recomputes ratios, calls applyArrowGeometry, and schedules a save. It does
   * NOT push an undo checkpoint on every frame — a single pre-drag snapshot is
   * pushed from mouseDownHandler, and handleObjectModified skips its usual
   * post-drag checkpoint for these action names.
   */
  function installArrowAdjustmentHandles(obj: Polygon, el: TwigElement): void {
    const ownerId = el.id

    const makePositionHandler = (pointIndex: number) => {
      return (_dim: Point, _finalMatrix: unknown, polyObject: FabricObject): Point => {
        const poly = polyObject as Polygon
        return new Point(poly.points[pointIndex].x, poly.points[pointIndex].y)
          .subtract(poly.pathOffset)
          .transform(
            util.multiplyTransformMatrices(poly.getViewportTransform(), poly.calcTransformMatrix())
          )
      }
    }

    // Resolve the canonical element off the state each time (never close over
    // a stale reference — the element may be swapped out by undo/redo or
    // cross-slide navigation while an arrow Polygon is still attached).
    const getElement = (): TwigElement | undefined => {
      return appState.currentSlide?.elements.find((e) => e.id === ownerId)
    }

    const localPointerOnPoly = (poly: Polygon, x: number, y: number): Point => {
      return util
        .sendPointToPlane(new Point(x, y), undefined, poly.calcOwnMatrix())
        .add(poly.pathOffset)
    }

    const junctionActionHandler = (
      _eventData: unknown,
      transform: { target: FabricObject },
      x: number,
      y: number
    ): boolean => {
      const poly = transform.target as Polygon
      const element = getElement()
      if (!element || element.type !== 'arrow') return false
      const w = element.width
      const h = element.height
      if (w <= 0 || h <= 0) return false
      const lp = localPointerOnPoly(poly, x, y)
      const newHeadLen = clamp(1 - lp.x / w, 0.05, 0.95)
      // Keep this clamp in sync with PropertiesPanel's headWidth input bounds
      // (5%–100%) so an arrow authored through the panel round-trips through
      // a handle drag without getting silently renormalized.
      const newHeadWid = clamp(1 - (2 * lp.y) / h, 0.05, 1.0)
      ensureArrowShape(element)
      element.arrowShape = {
        ...(element.arrowShape ?? DEFAULT_ARROW_SHAPE),
        headLengthRatio: newHeadLen,
        headWidthRatio: newHeadWid
      }
      applyArrowGeometry(poly, element)
      return true
    }

    const shaftActionHandler = (
      _eventData: unknown,
      transform: { target: FabricObject },
      x: number,
      y: number
    ): boolean => {
      const poly = transform.target as Polygon
      const element = getElement()
      if (!element || element.type !== 'arrow') return false
      const w = element.width
      const h = element.height
      if (w <= 0 || h <= 0) return false
      const lp = localPointerOnPoly(poly, x, y)
      const headW = h * (element.arrowShape?.headWidthRatio ?? DEFAULT_ARROW_SHAPE.headWidthRatio)
      if (headW <= 0) return false
      // Shaft top y in local points space is (h - shaftT) / 2. Inverting:
      // shaftT = h - 2 * lp.y. Ratio = shaftT / headW.
      const newShaft = clamp((h - 2 * lp.y) / headW, 0.05, 1.0)
      ensureArrowShape(element)
      element.arrowShape = {
        ...(element.arrowShape ?? DEFAULT_ARROW_SHAPE),
        shaftThicknessRatio: newShaft
      }
      applyArrowGeometry(poly, element)
      return true
    }

    const mouseDownHandler = (): boolean => {
      // Capture pre-drag snapshot exactly once per drag.
      pushCheckpoint()
      return true
    }

    const mouseUpHandler = (): boolean => {
      scheduleSave()
      scheduleThumbnailCapture()
      return true
    }

    const diamondRender = (ctx: CanvasRenderingContext2D, left: number, top: number): void => {
      renderAdjustmentDiamond(ctx, left, top)
    }

    const junction = new Control({
      actionName: ARROW_HEAD_ACTION,
      positionHandler: makePositionHandler(2) as Control['positionHandler'],
      actionHandler: junctionActionHandler as Control['actionHandler'],
      mouseDownHandler: mouseDownHandler as Control['mouseDownHandler'],
      mouseUpHandler: mouseUpHandler as Control['mouseUpHandler'],
      render: diamondRender as Control['render'],
      cursorStyle: 'crosshair'
    })

    const shaft = new Control({
      actionName: ARROW_SHAFT_ACTION,
      positionHandler: makePositionHandler(0) as Control['positionHandler'],
      actionHandler: shaftActionHandler as Control['actionHandler'],
      mouseDownHandler: mouseDownHandler as Control['mouseDownHandler'],
      mouseUpHandler: mouseUpHandler as Control['mouseUpHandler'],
      render: diamondRender as Control['render'],
      cursorStyle: 'ns-resize'
    })

    obj.controls = {
      ...obj.controls,
      [ARROW_HEAD_CONTROL_KEY]: junction,
      [ARROW_SHAFT_CONTROL_KEY]: shaft
    }
  }

  // Star: 5-point star with outer radius 100 and inner radius 42.
  // Raw points are normalized to an exact 200×200 bounding box so that
  // STAR_CANONICAL_W/H are always precisely 200 — no approximation drift.
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
  // Component State
  // ============================================================================

  // Canvas element reference (bound to the <canvas> element in the template)
  let canvasEl: HTMLCanvasElement

  // fabric.js Canvas instance (initialized in $effect)
  let fabCanvas: Canvas | undefined
  let alignmentGuides: { dispose(): void } | undefined

  // Snap rotation to 15° increments within a 7° threshold. Applied to every
  // interactive fabric object + ActiveSelection so multi-select rotation snaps too.
  const ROTATION_SNAP = { snapAngle: 15, snapThreshold: 7 } as const

  // Currently active text object (for rich text editing)
  let activeTextObject: Textbox | null = null
  let lastTextSelectionRange: { start: number; end: number } | null = null
  let suppressSelectionTracking = false
  // Editor-only overlay objects for the Keynote-style move-path affordance.
  // These never persist to slide state; they just visualize and edit one move action.
  type MovePathOverlayFabricObject = FabricObject & {
    overlayRole?: 'move-path-ghost'
    actionId?: string
  }
  let movePathLine: Line | null = null
  let movePathSourceMarker: Rect | null = null
  let movePathGhostObject: MovePathOverlayFabricObject | null = null
  let movePathDragState: { elementId: string; actionId: string } | null = null
  let movePathCheckpointPushed = false
  let suppressMovePathSelectionClear = false
  let expandedMovePathElementId = $state<string | null>(null)
  let movePathIndicatorUi = $state({ visible: false, left: 0, top: 0 })

  // Settings modal
  let settingsOpen = $state(false)
  let tempPresentationGuardOpen = $state(false)
  let closeFailureGuardOpen = $state(false)
  let closeFailureGuardMessage = $state('')
  let loadingScreenPhase = $state<LoadingPhase>('booting')
  let tempPresentationGuardResolver: ((choice: TempPresentationPromptChoice) => void) | null = null
  let closeFailureGuardResolver: ((shouldClose: boolean) => void) | null = null
  let activePresentationTransitionPromise: Promise<void> | null = null

  // Active side panel — only one can be open at a time
  type SidePanel = 'properties' | 'layers' | 'animate'
  let activeSidePanel = $state<SidePanel>('properties')
  let stackPanelWidth = $state(256)
  // Default background applied to newly created slides in this presentation
  let defaultSlideBackground = $state<SlideBackground | undefined>(undefined)
  // Incremented each time regenerateAllThumbnails() is called; lets a superseded
  // run detect it has been overtaken and bail out early.
  let thumbnailRegenerationGeneration = 0

  function startStackPanelResize(e: MouseEvent): void {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = stackPanelWidth

    function onMove(ev: MouseEvent): void {
      // Drag handle is on the LEFT edge — dragging left increases width
      const delta = startX - ev.clientX
      stackPanelWidth = Math.max(120, Math.min(600, startWidth + delta))
    }

    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Rich text editor state
  let isSelectionBold = $state(false)
  let isSelectionItalic = $state(false)
  let isSelectionUnderlined = $state(false)
  let selectionFontSize = $state(40)
  let selectionFontFamily = $state('Arial')
  let selectionFillColor = $state('#333333')
  let selectionRangeToRestore: { start: number; end: number } | null = null
  let wasEditing = false

  // Font management state
  let systemFonts: { family: string; path: string; format: string }[] = []
  let availableFonts = $state(['Arial', 'Helvetica', 'Times New Roman', 'Courier New']) // Default fallbacks
  let loadedFonts = new SvelteSet<string>() // Track which fonts have been loaded via @font-face

  // Custom font dropdown state
  let fontDropdownOpen = $state(false)
  let fontSearchQuery = $state('')
  let showShapePicker = $state(false)
  let shapePickerRef: HTMLDivElement | null = $state(null)
  let shapePickerButtonRef: HTMLButtonElement | null = $state(null)
  $effect(() => {
    if (!showShapePicker) return
    function onMousedown(e: MouseEvent): void {
      const target = e.target as Node
      if (shapePickerRef?.contains(target)) return
      if (shapePickerButtonRef?.contains(target)) return
      showShapePicker = false
    }
    document.addEventListener('mousedown', onMousedown)
    return () => document.removeEventListener('mousedown', onMousedown)
  })
  let fontLoadingQueue: Set<string> = new SvelteSet<string>()
  let isLoadingFonts = false

  // Keyboard shortcut handler
  const keys = new PressedKeys()

  // Context menu state
  let contextMenuVisible = $state(false)
  let contextMenuPosition = $state({ x: 0, y: 0 })

  // Boundary flags for disabling layer buttons when already at front/back.
  // When there are no elements, selectedIsAtFront/Back both default to false
  // (no element is selected, so neither boundary applies).
  const selectedElementZIndex = $derived(
    appState.currentSlide?.elements.find((e) => e.id === appState.selectedObjectId)?.zIndex ?? null
  )
  const canvasMaxZ = $derived(
    appState.currentSlide?.elements.length
      ? appState.currentSlide.elements.reduce((m, e) => Math.max(m, e.zIndex), -Infinity)
      : null
  )
  const canvasMinZ = $derived(
    appState.currentSlide?.elements.length
      ? appState.currentSlide.elements.reduce((m, e) => Math.min(m, e.zIndex), Infinity)
      : null
  )
  const selectedIsAtFront = $derived(
    selectedElementZIndex !== null && canvasMaxZ !== null && selectedElementZIndex >= canvasMaxZ
  )
  const selectedIsAtBack = $derived(
    selectedElementZIndex !== null && canvasMinZ !== null && selectedElementZIndex <= canvasMinZ
  )

  // Generation counter incremented on each renderCanvasFromState() call.
  // Async image load callbacks capture their generation and bail out if a newer
  // render has started (e.g. the user navigated to another slide), preventing
  // stale images from landing on the wrong canvas and causing duplicates.
  let renderGeneration = 0

  // Cache of decoded image elements keyed by src (base64 data URI).
  // Allows synchronous FabricImage construction on re-renders, preventing flicker.
  const imageElementCache = new SvelteMap<string, HTMLImageElement>()
  // Tracks which slide IDs have been fully prefetched, so repeated renderCanvasFromState
  // calls (per keystroke/drag) don't re-issue IPC round-trips for already-fetched slides.
  const prefetchedSlideIds = new SvelteSet<string>()

  /**
   * Auto-save debounce delay in milliseconds.
   * 300ms is fast enough to feel instant while batching rapid changes
   * (e.g., dragging objects, typing in text boxes).
   */
  const AUTO_SAVE_DEBOUNCE_MS = 300

  /**
   * Delay between retry attempts when creating a new presentation fails.
   */
  const NEW_PRESENTATION_RETRY_DELAY_MS = 500

  // Promise-based lock to prevent concurrent saves
  let savePromise: Promise<void> | null = null

  // Debounced auto-save
  let saveTimeoutId: ReturnType<typeof setTimeout> | null = null

  // Debounced thumbnail capture (500ms, separate from auto-save debounce)
  let thumbnailTimeoutId: ReturnType<typeof setTimeout> | null = null

  // ============================================================================
  // Undo/Redo History
  // ============================================================================

  // Image asset store: elementId → base64 data URI.
  // Snapshots omit src blobs; this map is used to re-attach them on restore.
  const imageAssets = new SvelteMap<string, string>()

  type ElementSnapshot = Omit<TwigElement, 'src'>
  type SlideSnapshot = {
    elements: ElementSnapshot[]
    background: SlideBackground | undefined
    animationOrder: AnimationStep[]
    transition: SlideTransition | undefined
  }
  // Each entry stores the snapshot and its JSON serialization (for O(1) dedup).
  type HistoryEntry = { snapshot: SlideSnapshot; serialized: string }
  type SlideHistory = { undo: HistoryEntry[]; redo: HistoryEntry[] }

  const historyBySlideId = new SvelteMap<string, SlideHistory>()
  const MAX_UNDO_ENTRIES = 50
  let historyRevision = $state(0) // bumped on every history mutation to drive $derived

  let bgCheckpointPushed = false // gates background-change history to first event per drag
  let transitionCheckpointPushed = false // gates transition-change history to first event per drag
  let slideTransitionOverlaySrc = $state<string | null>(null)
  let isRestoringHistory = false

  // Copy/paste state
  let updateAvailableVersion = $state<string | null>(null)
  let pasteCount = 0 // resets on each copy; increments each paste
  let lastCopiedPayload = '' // detects cross-window clipboard changes to reset pasteCount
  let pendingSelectionIds: string[] = [] // consumed by renderCanvasFromState after render

  // Slide drag-to-reorder state
  let slideDragSourceId = $state<string | null>(null)
  let slideDragOverId = $state<string | null>(null)
  let slideDragOverPosition = $state<'before' | 'after'>('before')

  // Reactive booleans for toolbar disabled state.
  // historyRevision is read to subscribe to stack mutations; appState.currentSlide?.id
  // is also tracked so canUndo/canRedo update immediately on slide switch.
  const canUndo = $derived.by(() => {
    void historyRevision
    return (historyBySlideId.get(appState.currentSlide?.id ?? '')?.undo.length ?? 0) > 0
  })
  const canRedo = $derived.by(() => {
    void historyRevision
    return (historyBySlideId.get(appState.currentSlide?.id ?? '')?.redo.length ?? 0) > 0
  })

  // Auto-save status indicator
  // 'idle'   — data is persisted, no recent activity (shows relative timestamp)
  // 'pending' — unsaved changes exist, debounced save queued
  // 'saving'  — save in flight
  // 'saved'   — just saved (green flash for 2s, then transitions to 'idle')
  // 'error'   — last save failed
  type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
  let saveStatus = $state<SaveStatus>('idle')
  let savedResetTimeoutId: ReturnType<typeof setTimeout> | null = null

  // Timestamp of the last successful save, used to render "Saved Xs ago" in idle state.
  // Starts as null (no save has occurred yet). The toolbar is only rendered when
  // appState.currentSlide is set, which happens after handleNewPresentation/handleOpen
  // complete — both call setSaveStatus('saved'), so lastSavedAt is set before the
  // idle indicator ever appears.
  let lastSavedAt: number | null = null

  // Reactive clock for updating the relative timestamp in idle state.
  // Only ticks once a save has occurred (interval started lazily in setSaveStatus).
  let now = $state(Date.now())
  let nowTickId: ReturnType<typeof setInterval> | null = null

  function setSaveStatus(status: SaveStatus): void {
    saveStatus = status
    if (savedResetTimeoutId) {
      clearTimeout(savedResetTimeoutId)
      savedResetTimeoutId = null
    }
    if (status === 'saved') {
      lastSavedAt = Date.now()
      // Stop the tick during the 2s green-flash; it will restart on idle entry
      if (nowTickId) {
        clearInterval(nowTickId)
        nowTickId = null
      }
      savedResetTimeoutId = setTimeout(() => {
        savedResetTimeoutId = null
        setSaveStatus('idle')
      }, 2000)
    } else if (status === 'idle') {
      // Sync 'now' immediately so the relative timestamp is accurate on entry,
      // then tick every 10s to keep it fresh.
      now = Date.now()
      if (!nowTickId) {
        nowTickId = setInterval(() => {
          now = Date.now()
        }, 10_000)
      }
    } else {
      // pending / saving / error — relative timestamp not shown, stop the ticker
      if (nowTickId) {
        clearInterval(nowTickId)
        nowTickId = null
      }
    }
  }

  function formatRelativeTime(ts: number): string {
    const secs = Math.floor((now - ts) / 1000)
    if (secs < 10) return get(_)('time.just_now')
    if (secs < 60) return get(_)('time.seconds_ago', { values: { s: secs } })
    const mins = Math.floor(secs / 60)
    if (mins < 60) return get(_)('time.minutes_ago', { values: { m: mins } })
    return get(_)('time.hours_ago', { values: { h: Math.floor(mins / 60) } })
  }

  /**
   * Performs the actual save operation with promise-based locking.
   * This is the single source of truth for all save operations.
   *
   * @param rethrowErrors - If true, errors are re-thrown to the caller. If false, errors are logged only.
   */
  async function performSave(rethrowErrors: boolean = false): Promise<void> {
    // Wait for any in-flight save to complete
    while (savePromise) {
      await savePromise
    }

    // Rich-text edits live on the active Fabric object while editing. Flush the
    // latest content/styles back into slide state before we snapshot for saving.
    if (activeTextObject?.id) {
      updateStateFromObject(activeTextObject as TwigFabricObject)
    }

    // Snapshot state before any async operation to prevent race conditions
    // (currentFilePath could change while we're awaiting savePromise)
    const filePath = appState.currentFilePath
    const slide = appState.currentSlide

    // Check if we have valid state to save.
    // Don't change saveStatus here — if status is 'pending', the changes are still
    // unwritten; leaving it as-is avoids a false 'idle' flash. The transition
    // handlers (handleNewPresentation, handleOpen) call setSaveStatus('saved') once
    // valid state is established, which normalises the indicator.
    if (!slide || !filePath) {
      return
    }

    // Start new save operation with promise lock
    setSaveStatus('saving')
    savePromise = (async () => {
      try {
        const plainSlide = JSON.parse(JSON.stringify(slide))
        await window.api.db.saveSlide(filePath, plainSlide)
        setSaveStatus('saved')
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.error('Save operation failed:', errorMessage)
        setSaveStatus('error')
        if (rethrowErrors) {
          throw error
        }
      }
    })()

    try {
      await savePromise
    } finally {
      savePromise = null
      // Safety net: if status is still 'saving' here, something bypassed both
      // setSaveStatus('saved') and setSaveStatus('error') — reset to avoid a
      // permanently stuck indicator.
      if (saveStatus === 'saving') {
        setSaveStatus('error')
      }
    }
  }

  // ============================================================================
  // Image Asset Registration
  // ============================================================================

  function registerImageAssetsFromSlide(slide: typeof appState.currentSlide): void {
    if (!slide) return
    for (const el of slide.elements) {
      if (el.type === 'image' && el.src && el.id) {
        imageAssets.set(el.id, el.src)
      }
    }
  }

  /**
   * Preloads images from a slide's elements into imageElementCache.
   * Skips srcs already cached. Returns a promise that resolves when all
   * images on that slide have been decoded.
   */
  async function prefetchSlideImages(slideId: string): Promise<void> {
    const filePath = appState.currentFilePath
    if (!filePath) return
    if (prefetchedSlideIds.has(slideId)) return
    try {
      const slide = await window.api.db.getSlide(filePath, slideId)
      if (!slide) return
      const loads: Promise<void>[] = []
      for (const el of slide.elements) {
        if (el.type === 'image' && el.src && !imageElementCache.has(el.src)) {
          const src = el.src
          loads.push(
            new Promise<void>((resolve) => {
              const img = new Image()
              img.onload = () => {
                imageElementCache.set(src, img)
                resolve()
              }
              img.onerror = () => resolve() // Don't block on broken images
              img.src = src
            })
          )
        }
      }
      await Promise.all(loads)
      prefetchedSlideIds.add(slideId)
    } catch {
      // Best-effort prefetch; ignore errors
    }
  }

  /**
   * Preemptively loads images from adjacent slides into imageElementCache so that
   * switching to those slides renders synchronously without flicker.
   * Fire-and-forget — errors are silently ignored.
   */
  async function prefetchAdjacentSlideImages(): Promise<void> {
    const idx = appState.currentSlideIndex
    const slideIds = appState.slideIds

    const adjacentIds: string[] = []
    if (idx + 1 < slideIds.length) adjacentIds.push(slideIds[idx + 1])
    if (idx - 1 >= 0) adjacentIds.push(slideIds[idx - 1])

    await Promise.all(adjacentIds.map((id) => prefetchSlideImages(id)))
  }

  /**
   * Preloads images for ALL slides in the background immediately after a
   * presentation is opened, so that first-visit renders are flicker-free.
   * Skips the current slide (already rendering). Fire-and-forget.
   */
  async function prefetchAllSlideImages(): Promise<void> {
    const currentId = appState.currentSlide?.id
    const slideIds = appState.slideIds
    // Prefetch remaining slides sequentially to avoid flooding IPC
    for (const slideId of slideIds) {
      if (slideId === currentId) continue
      await prefetchSlideImages(slideId)
    }
  }

  // ============================================================================
  // Undo/Redo Core
  // ============================================================================

  function getSlideHistory(slideId: string): SlideHistory {
    if (!historyBySlideId.has(slideId)) {
      historyBySlideId.set(slideId, { undo: [], redo: [] })
    }
    return historyBySlideId.get(slideId)!
  }

  function takeSnapshot(): SlideSnapshot | null {
    if (!appState.currentSlide) return null
    return {
      elements: appState.currentSlide.elements.map(
        (el) => JSON.parse(JSON.stringify({ ...el, src: undefined })) as ElementSnapshot
      ),
      background: appState.currentSlide.background
        ? (JSON.parse(JSON.stringify(appState.currentSlide.background)) as SlideBackground)
        : undefined,
      animationOrder: JSON.parse(JSON.stringify(appState.currentSlide.animationOrder)),
      transition: appState.currentSlide.transition
        ? (JSON.parse(JSON.stringify(appState.currentSlide.transition)) as SlideTransition)
        : undefined
    }
  }

  function pushCheckpointForSlide(slide: Slide): void {
    const snapshot: SlideSnapshot = {
      elements: slide.elements.map(
        (el) => JSON.parse(JSON.stringify({ ...el, src: undefined })) as ElementSnapshot
      ),
      background: slide.background
        ? (JSON.parse(JSON.stringify(slide.background)) as SlideBackground)
        : undefined,
      animationOrder: JSON.parse(JSON.stringify(slide.animationOrder ?? [])),
      transition: slide.transition
        ? (JSON.parse(JSON.stringify(slide.transition)) as SlideTransition)
        : undefined
    }
    const serialized = JSON.stringify(snapshot)
    const h = getSlideHistory(slide.id)
    const top = h.undo[h.undo.length - 1]
    if (top && serialized === top.serialized) return
    h.undo.push({ snapshot, serialized })
    if (h.undo.length > MAX_UNDO_ENTRIES) h.undo.shift()
    h.redo = []
    historyRevision++
  }

  function pushCheckpoint(): void {
    const slideId = appState.currentSlide?.id
    if (!slideId) return
    const snapshot = takeSnapshot()
    if (!snapshot) return
    const serialized = JSON.stringify(snapshot)
    const h = getSlideHistory(slideId)
    // Deduplicate: skip if identical to the most recent undo entry
    const top = h.undo[h.undo.length - 1]
    if (top && serialized === top.serialized) return
    h.undo.push({ snapshot, serialized })
    if (h.undo.length > MAX_UNDO_ENTRIES) h.undo.shift()
    h.redo = []
    historyRevision++
  }

  function restoreSnapshot(snapshot: SlideSnapshot): void {
    const currentSlide = appState.currentSlide
    if (!currentSlide) return

    isRestoringHistory = true
    activeTextObject?.off('selection:changed', handleTextSelectionChange)
    activeTextObject = null
    wasEditing = false
    lastTextSelectionRange = null
    expandedMovePathElementId = null
    fabCanvas?.discardActiveObject()

    const restoredElements = snapshot.elements.map((el) => {
      if (el.type === 'image') {
        return { ...el, src: imageAssets.get(el.id) } as TwigElement
      }
      return { ...el } as TwigElement
    })

    const restoredBackground = snapshot.background
      ? (JSON.parse(JSON.stringify(snapshot.background)) as SlideBackground)
      : undefined
    const restoredTransition = snapshot.transition
      ? (JSON.parse(JSON.stringify(snapshot.transition)) as SlideTransition)
      : undefined
    const restoredAnimationOrder = JSON.parse(JSON.stringify(snapshot.animationOrder ?? []))

    appState.currentSlide = {
      ...currentSlide,
      elements: restoredElements,
      background: restoredBackground,
      animationOrder: normalizeAnimationOrder({
        ...currentSlide,
        elements: restoredElements,
        background: restoredBackground,
        animationOrder: restoredAnimationOrder,
        transition: restoredTransition
      }),
      transition: restoredTransition
    }
    appState.selectedObjectId = null
    if (fabCanvas) {
      renderCanvasFromState()
        .catch((err) => console.error('Canvas render failed during history restore:', err))
        .finally(() => {
          isRestoringHistory = false
        })
    } else {
      isRestoringHistory = false
    }
  }

  function performUndo(): void {
    const slideId = appState.currentSlide?.id
    if (!slideId) return
    const h = getSlideHistory(slideId)
    if (h.undo.length === 0) return
    // Sync mid-edit text state before snapshotting current
    if (activeTextObject?.isEditing) updateStateFromObject(activeTextObject)
    const current = takeSnapshot()
    const prevEntry = h.undo.pop()!
    if (current) h.redo.push({ snapshot: current, serialized: JSON.stringify(current) })
    historyRevision++
    restoreSnapshot(prevEntry.snapshot)
    scheduleThumbnailCapture()
    scheduleSave()
  }

  function performRedo(): void {
    const slideId = appState.currentSlide?.id
    if (!slideId) return
    const h = getSlideHistory(slideId)
    if (h.redo.length === 0) return
    if (activeTextObject?.isEditing) updateStateFromObject(activeTextObject)
    const current = takeSnapshot()
    const nextEntry = h.redo.pop()!
    if (current) {
      h.undo.push({ snapshot: current, serialized: JSON.stringify(current) })
      if (h.undo.length > MAX_UNDO_ENTRIES) h.undo.shift()
    }
    historyRevision++
    restoreSnapshot(nextEntry.snapshot)
    scheduleThumbnailCapture()
    scheduleSave()
  }

  function clearAllHistory(): void {
    historyBySlideId.clear()
    imageAssets.clear()
    historyRevision++
  }

  function scheduleSave(): void {
    // Always mark as pending — a queued debounced save IS pending, even if
    // a save is currently in-flight. This prevents a false "Saved" indicator
    // during the window between an in-flight save completing and the next
    // debounced save starting.
    setSaveStatus('pending')
    if (saveTimeoutId) clearTimeout(saveTimeoutId)
    saveTimeoutId = setTimeout(async () => {
      saveTimeoutId = null
      await performSave(false) // Log errors but don't throw
    }, AUTO_SAVE_DEBOUNCE_MS)
  }

  async function applySlideBackground(
    bg: SlideBackground | undefined,
    target?: StaticCanvas | Canvas
  ): Promise<void> {
    const c = target ?? fabCanvas
    if (!c) return
    const W = 960,
      H = 540

    // Always clear backgroundImage first; re-set if needed
    c.backgroundImage = undefined

    if (!bg || bg.type === 'solid') {
      c.backgroundColor = bg?.color ?? '#ffffff'
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
      c.set({ backgroundColor: grad })
    } else if (bg.type === 'image' && bg.src) {
      c.backgroundColor = '#ffffff'
      const img = await FabricImage.fromURL(bg.src, { crossOrigin: 'anonymous' })
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
      c.backgroundImage = img
      c.renderAll()
    }
  }

  function captureCanvasSnapshot(quality = 0.85, multiplier = 1): string | null {
    if (!fabCanvas) return null
    const hadOverlay = !!(movePathLine || movePathSourceMarker || movePathGhostObject)
    if (hadOverlay) {
      setMovePathOverlayVisible(false)
      fabCanvas.renderAll()
    }
    const dataUrl = fabCanvas.toDataURL({ format: 'jpeg', quality, multiplier })
    if (hadOverlay) {
      setMovePathOverlayVisible(true)
      fabCanvas.requestRenderAll()
    }
    return dataUrl
  }

  async function captureAndStoreThumbnail(): Promise<void> {
    if (!fabCanvas || !appState.currentSlide || !appState.currentFilePath) return
    const dataUrl = captureCanvasSnapshot(0.7, 0.2)
    if (!dataUrl) return
    appState.thumbnails[appState.currentSlide.id] = dataUrl
    window.api.db
      .saveThumbnail(appState.currentFilePath, appState.currentSlide.id, dataUrl)
      .catch(console.error)
  }

  function scheduleThumbnailCapture(): void {
    if (thumbnailTimeoutId) clearTimeout(thumbnailTimeoutId)
    thumbnailTimeoutId = setTimeout(() => {
      thumbnailTimeoutId = null
      captureAndStoreThumbnail().catch(console.error)
    }, 500)
  }

  // Remove any existing move-path overlay before rebuilding it for the latest
  // selection or slide state.
  function clearMovePathOverlay(): void {
    detachMovePathWindowListeners()
    if (fabCanvas) {
      if (movePathLine) fabCanvas.remove(movePathLine)
      if (movePathSourceMarker) fabCanvas.remove(movePathSourceMarker)
      if (movePathGhostObject) fabCanvas.remove(movePathGhostObject)
    }
    movePathLine = null
    movePathSourceMarker = null
    movePathGhostObject = null
    movePathDragState = null
    movePathCheckpointPushed = false
    suppressMovePathSelectionClear = false
    if (movePathIndicatorUi.visible) movePathIndicatorUi = { visible: false, left: 0, top: 0 }
  }

  function setMovePathOverlayVisible(visible: boolean): void {
    movePathLine?.set({ visible })
    movePathSourceMarker?.set({ visible })
    movePathGhostObject?.set({ visible })
    movePathIndicatorUi = { ...movePathIndicatorUi, visible }
  }

  // First pass: expose a single editable move action for the selected element.
  // If the element has multiple moves, prefer the first one that appears in the
  // slide timeline so the overlay matches presentation order.
  function getEditableMoveActionForSelection(): {
    element: TwigElement
    action: ActionAnimation
  } | null {
    return getEditableMoveActionForElement(appState.selectedObjectId)
  }

  function getEditableMoveActionForElement(
    elementId: string | null | undefined
  ): { element: TwigElement; action: ActionAnimation } | null {
    const slide = appState.currentSlide
    if (!slide || !elementId) return null

    const element = slide.elements.find((el) => el.id === elementId)
    const actions = element?.animations?.actions?.filter((action) => action.type === 'move') ?? []
    if (!element || actions.length === 0) return null

    const orderedActionId = slide.animationOrder.find(
      (step) => step.elementId === elementId && step.category === 'action' && step.actionId
    )?.actionId

    const action = actions.find((candidate) => candidate.id === orderedActionId) ?? actions[0]
    return action ? { element, action } : null
  }

  function getMovePathIndicatorPosition(
    element: TwigElement,
    sourceObject?: TwigFabricObject | null
  ): { x: number; y: number } {
    if (sourceObject) {
      const rect = sourceObject.getBoundingRect()
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height
      }
    }
    return {
      x: element.x,
      y: element.y + element.height / 2
    }
  }

  function setMovePathIndicatorPosition(left: number, top: number, visible: boolean = true): void {
    movePathIndicatorUi = { left, top, visible }
  }

  // Shared fabric options for all ghost overlay objects.
  const GHOST_OVERLAY_OPTIONS = {
    opacity: 0.6,
    selectable: true,
    evented: true,
    hoverCursor: 'move',
    moveCursor: 'move',
    hasControls: false,
    hasBorders: false,
    padding: 8
  } as const

  function stampGhostOverlay(ghost: FabricObject, actionId: string): MovePathOverlayFabricObject {
    const typed = ghost as MovePathOverlayFabricObject
    typed.overlayRole = 'move-path-ghost'
    typed.actionId = actionId
    return typed
  }

  function createMovePathGhostObject(
    element: TwigElement,
    sourceObject: TwigFabricObject | undefined,
    action: ActionAnimation
  ): MovePathOverlayFabricObject | null {
    const pos = { left: action.toX, top: action.toY, angle: element.angle }

    if (element.type === 'rect') {
      return stampGhostOverlay(
        new Rect({
          ...pos,
          width: element.width,
          height: element.height,
          fill: element.fill,
          ...GHOST_OVERLAY_OPTIONS
        }),
        action.id
      )
    }

    if (element.type === 'ellipse') {
      return stampGhostOverlay(
        new Ellipse({
          ...pos,
          rx: element.width / 2,
          ry: element.height / 2,
          fill: element.fill,
          ...GHOST_OVERLAY_OPTIONS
        }),
        action.id
      )
    }

    if (element.type === 'triangle') {
      return stampGhostOverlay(
        new Triangle({
          ...pos,
          width: element.width,
          height: element.height,
          fill: element.fill,
          ...GHOST_OVERLAY_OPTIONS
        }),
        action.id
      )
    }

    if (element.type === 'star') {
      return stampGhostOverlay(
        new Polygon(makeStarPoints(), {
          ...pos,
          fill: element.fill,
          scaleX: element.width / STAR_CANONICAL_W,
          scaleY: element.height / STAR_CANONICAL_H,
          ...GHOST_OVERLAY_OPTIONS
        }),
        action.id
      )
    }

    if (element.type === 'arrow') {
      const shape = element.arrowShape ?? DEFAULT_ARROW_SHAPE
      return stampGhostOverlay(
        new Polygon(makeArrowPoints(element.width, element.height, shape), {
          ...pos,
          fill: element.fill,
          width: element.width,
          height: element.height,
          pathOffset: new Point(element.width / 2, element.height / 2),
          scaleX: 1,
          scaleY: 1,
          ...GHOST_OVERLAY_OPTIONS
        }),
        action.id
      )
    }

    if (element.type === 'text') {
      return stampGhostOverlay(
        new Textbox(element.text || '', {
          ...pos,
          width: element.width,
          fill: element.fill,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          fontWeight: element.fontWeight,
          fontStyle: element.fontStyle,
          underline: element.underline,
          styles: element.styles ? cleanStylesObject(element.styles) : {},
          ...getTextboxWrappingOptions(element.text),
          lockScalingY: true,
          editable: false,
          ...GHOST_OVERLAY_OPTIONS
        }),
        action.id
      )
    }

    if (element.type === 'image' && sourceObject instanceof FabricImage) {
      const ghost = new FabricImage(sourceObject.getElement())
      ghost.set({
        ...pos,
        scaleX: sourceObject.scaleX,
        scaleY: sourceObject.scaleY,
        ...GHOST_OVERLAY_OPTIONS
      })
      return stampGhostOverlay(ghost, action.id)
    }

    return null
  }

  // Keynote-style first pass:
  // 1. Show a collapsed red indicator below the selected object when it has a move.
  // 2. Expand to line + source marker + draggable ghost destination after clicking it.
  function renderMovePathOverlay(): void {
    clearMovePathOverlay()
    if (!fabCanvas) return

    const editable = getEditableMoveActionForSelection()
    if (!editable) {
      fabCanvas.requestRenderAll()
      return
    }

    const { element, action } = editable
    const sourceObject = fabCanvas
      .getObjects()
      .find((obj) => (obj as TwigFabricObject).id === element.id) as TwigFabricObject | undefined
    const indicatorPos = getMovePathIndicatorPosition(element, sourceObject)
    setMovePathIndicatorPosition(indicatorPos.x, indicatorPos.y)

    if (expandedMovePathElementId !== element.id) {
      fabCanvas.requestRenderAll()
      return
    }

    movePathLine = new Line([element.x, element.y, action.toX, action.toY], {
      stroke: '#ef4444',
      strokeWidth: 2,
      selectable: false,
      evented: false
    })
    movePathSourceMarker = new Rect({
      left: element.x,
      top: element.y,
      width: 10,
      height: 10,
      fill: '#ffffff',
      stroke: '#ef4444',
      strokeWidth: 2,
      selectable: false,
      evented: false
    })
    movePathGhostObject = createMovePathGhostObject(element, sourceObject, action)

    fabCanvas.add(movePathLine)
    fabCanvas.add(movePathSourceMarker)
    if (movePathGhostObject) fabCanvas.add(movePathGhostObject)
    fabCanvas.requestRenderAll()
  }

  // During drag we mutate the overlay in place instead of rebuilding the whole
  // canvas, which keeps the interaction responsive.
  function applyMovePathCoords(startX: number, startY: number, endX: number, endY: number): void {
    movePathLine?.set({ x1: startX, y1: startY, x2: endX, y2: endY })
    movePathSourceMarker?.set({ left: startX, top: startY })
    movePathGhostObject?.set({ left: endX, top: endY })
    movePathLine?.setCoords()
    movePathSourceMarker?.setCoords()
    movePathGhostObject?.setCoords()
  }

  function syncMovePathOverlay(element: TwigElement, action: ActionAnimation): void {
    const sourceObject = fabCanvas
      ?.getObjects()
      .find((obj) => (obj as TwigFabricObject).id === element.id) as TwigFabricObject | undefined
    const indicatorPos = getMovePathIndicatorPosition(element, sourceObject)
    applyMovePathCoords(element.x, element.y, action.toX, action.toY)
    setMovePathIndicatorPosition(indicatorPos.x, indicatorPos.y)
    fabCanvas?.renderAll()
  }

  function syncMovePathOverlayPreview(
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): void {
    applyMovePathCoords(startX, startY, endX, endY)
    // Caller is responsible for renderAll — avoids double render in handleObjectMoving.
  }

  function restoreSelectedCanvasObject(): void {
    if (!fabCanvas || !appState.selectedObjectId) return
    const selectedObject = fabCanvas
      .getObjects()
      .find((obj) => (obj as TwigFabricObject).id === appState.selectedObjectId)
    if (selectedObject && fabCanvas.getActiveObject() !== selectedObject) {
      fabCanvas.setActiveObject(selectedObject)
      fabCanvas.renderAll()
    }
  }

  function toggleExpandedMovePath(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (!appState.selectedObjectId) return
    expandedMovePathElementId =
      expandedMovePathElementId === appState.selectedObjectId ? null : appState.selectedObjectId
    restoreSelectedCanvasObject()
    renderMovePathOverlay()
  }

  function setMoveActionTarget(
    elementId: string,
    actionId: string,
    toX: number,
    toY: number,
    persist: boolean
  ): void {
    const slide = appState.currentSlide
    if (!slide) return

    const element = slide.elements.find((candidate) => candidate.id === elementId)
    const action = element?.animations?.actions?.find(
      (candidate) => candidate.id === actionId && candidate.type === 'move'
    )
    if (!element || !action) return

    action.toX = Math.round(toX)
    action.toY = Math.round(toY)
    syncMovePathOverlay(element, action)
    if (persist) {
      scheduleSave()
      scheduleThumbnailCapture()
    }
  }

  // Fabric may briefly clear or move selection when the ghost drag finishes.
  // Hold onto the real object selection through that handoff, then release it
  // on the next tick once Fabric has finished its event cycle.
  function preserveSelectionAfterGhostDrag(elementId: string): void {
    appState.selectedObjectId = elementId
    expandedMovePathElementId = elementId
    suppressMovePathSelectionClear = true
    restoreSelectedCanvasObject()
    setTimeout(() => {
      appState.selectedObjectId = elementId
      expandedMovePathElementId = elementId
      suppressMovePathSelectionClear = false
      restoreSelectedCanvasObject()
      renderMovePathOverlay()
    }, 0)
  }

  function detachMovePathWindowListeners(): void {
    window.removeEventListener('mousemove', handleMovePathWindowMouseMove)
    window.removeEventListener('mouseup', handleMovePathWindowMouseUp)
  }

  function handleCanvasMouseDownBefore(event: { target?: FabricObject; e: MouseEvent }): void {
    const target = event.target as MovePathOverlayFabricObject | undefined
    if (!target?.overlayRole || !target.actionId || !appState.selectedObjectId) return

    if (target.overlayRole === 'move-path-ghost') {
      suppressMovePathSelectionClear = true
      movePathDragState = { elementId: appState.selectedObjectId, actionId: target.actionId }
      if (!movePathCheckpointPushed) {
        pushCheckpoint()
        movePathCheckpointPushed = true
      }
      // Attach window-level listeners only for out-of-canvas drag tracking.
      // We listen on the canvas element's mouseleave to attach them lazily —
      // that way they don't fire while fabric.js is handling the drag normally,
      // avoiding conflicts with object:moving / syncMovePathOverlay.
      const canvasEl = fabCanvas?.getElement()
      const attachOnLeave = (): void => {
        window.addEventListener('mousemove', handleMovePathWindowMouseMove)
        window.addEventListener('mouseup', handleMovePathWindowMouseUp)
        canvasEl?.removeEventListener('mouseleave', attachOnLeave)
      }
      canvasEl?.addEventListener('mouseleave', attachOnLeave, { once: true })
      return
    }
  }

  function handleMovePathWindowMouseMove(event: MouseEvent): void {
    if (!movePathDragState || !fabCanvas) return
    const point = fabCanvas.getScenePoint(event)
    setMoveActionTarget(
      movePathDragState.elementId,
      movePathDragState.actionId,
      point.x,
      point.y,
      false
    )
    restoreSelectedCanvasObject()
  }

  function handleMovePathWindowMouseUp(event: MouseEvent): void {
    if (movePathDragState && fabCanvas) {
      const point = fabCanvas.getScenePoint(event)
      setMoveActionTarget(
        movePathDragState.elementId,
        movePathDragState.actionId,
        point.x,
        point.y,
        true
      )
    }
    detachMovePathWindowListeners()
    movePathDragState = null
    movePathCheckpointPushed = false
    suppressMovePathSelectionClear = false
    restoreSelectedCanvasObject()
  }

  function handleObjectMoving(event: { target?: TwigFabricObject | ActiveSelection }): void {
    const target = event.target
    if (!target || target.type === 'activeselection') return

    const overlayTarget = target as MovePathOverlayFabricObject
    if (overlayTarget.overlayRole === 'move-path-ghost' && movePathDragState) {
      setMoveActionTarget(
        movePathDragState.elementId,
        movePathDragState.actionId,
        overlayTarget.left ?? 0,
        overlayTarget.top ?? 0,
        false
      )
      return
    }

    const editable = getEditableMoveActionForElement((target as TwigFabricObject).id)
    if (!editable) return

    const indicatorPos = getMovePathIndicatorPosition(editable.element, target as TwigFabricObject)
    setMovePathIndicatorPosition(indicatorPos.x, indicatorPos.y)

    if (expandedMovePathElementId !== editable.element.id) {
      fabCanvas?.renderAll()
      return
    }

    const liveX = target.left ?? editable.element.x
    const liveY = target.top ?? editable.element.y
    // Keep the authored move destination fixed; only the source point should
    // follow the object while it is being dragged on the slide.
    syncMovePathOverlayPreview(liveX, liveY, editable.action.toX, editable.action.toY)
    fabCanvas?.renderAll()
  }

  /**
   * Regenerates thumbnails for every slide in the presentation using a new background.
   * Renders each slide on a hidden offscreen StaticCanvas, captures the result,
   * and updates both the in-memory thumbnail map and the database.
   */
  async function regenerateAllThumbnails(background: SlideBackground | undefined): Promise<void> {
    if (!appState.currentFilePath) return
    const filePath = appState.currentFilePath
    const myGeneration = ++thumbnailRegenerationGeneration

    for (const slideId of appState.slideIds) {
      if (thumbnailRegenerationGeneration !== myGeneration) return
      // The current slide is handled by scheduleThumbnailCapture (already rendered on fabCanvas)
      if (slideId === appState.currentSlide?.id) continue

      const slide = await window.api.db.getSlide(filePath, slideId)
      if (!slide || thumbnailRegenerationGeneration !== myGeneration) continue

      const tempEl = document.createElement('canvas')
      tempEl.style.cssText = 'position:absolute;left:-9999px;top:-9999px'
      document.body.appendChild(tempEl)
      const tempCanvas = new StaticCanvas(tempEl, { width: 960, height: 540 })

      try {
        await applySlideBackground(background, tempCanvas)

        // Add non-image elements in z-order (images skipped for performance)
        const sorted = [...slide.elements].sort((a, b) => a.zIndex - b.zIndex)
        for (const el of sorted) {
          if (el.type === 'rect') {
            tempCanvas.add(
              new Rect({
                left: el.x,
                top: el.y,
                width: el.width,
                height: el.height,
                angle: el.angle,
                fill: el.fill
              })
            )
          } else if (el.type === 'ellipse') {
            tempCanvas.add(
              new Ellipse({
                left: el.x,
                top: el.y,
                rx: el.width / 2,
                ry: el.height / 2,
                angle: el.angle,
                fill: el.fill
              })
            )
          } else if (el.type === 'triangle') {
            tempCanvas.add(
              new Triangle({
                left: el.x,
                top: el.y,
                width: el.width,
                height: el.height,
                angle: el.angle,
                fill: el.fill
              })
            )
          } else if (el.type === 'star') {
            tempCanvas.add(
              new Polygon(makeStarPoints(), {
                left: el.x,
                top: el.y,
                angle: el.angle,
                fill: el.fill,
                scaleX: el.width / STAR_CANONICAL_W,
                scaleY: el.height / STAR_CANONICAL_H
              })
            )
          } else if (el.type === 'arrow') {
            const shape = el.arrowShape ?? DEFAULT_ARROW_SHAPE
            tempCanvas.add(
              new Polygon(makeArrowPoints(el.width, el.height, shape), {
                left: el.x,
                top: el.y,
                angle: el.angle,
                fill: el.fill,
                width: el.width,
                height: el.height,
                pathOffset: new Point(el.width / 2, el.height / 2),
                scaleX: 1,
                scaleY: 1
              })
            )
          } else if (el.type === 'text') {
            tempCanvas.add(
              new Textbox(el.text || '', {
                left: el.x,
                top: el.y,
                width: el.width,
                angle: el.angle,
                fill: el.fill,
                fontFamily: el.fontFamily,
                fontSize: el.fontSize,
                fontWeight: el.fontWeight,
                fontStyle: el.fontStyle,
                underline: el.underline,
                ...getTextboxWrappingOptions(el.text)
              })
            )
          } else if (el.type === 'image' && el.src) {
            try {
              const img = await FabricImage.fromURL(el.src, { crossOrigin: 'anonymous' })
              const scaleX = el.width / (img.width || 1)
              const scaleY = el.height / (img.height || 1)
              img.set({ left: el.x, top: el.y, angle: el.angle, scaleX, scaleY })
              tempCanvas.add(img)
            } catch {
              // Skip images that fail to load
            }
          }
        }

        tempCanvas.renderAll()
        const dataUrl = tempCanvas.toDataURL({ format: 'jpeg', quality: 0.7, multiplier: 0.2 })
        appState.thumbnails[slideId] = dataUrl
        window.api.db.saveThumbnail(filePath, slideId, dataUrl).catch(console.error)
      } finally {
        tempCanvas.dispose()
        document.body.removeChild(tempEl)
      }
    }
  }

  /**
   * Flushes any pending auto-save immediately.
   * Called before critical operations like navigation, closing, or presenting.
   */
  async function flushPendingSave(): Promise<void> {
    // Cancel pending debounced save
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId)
      saveTimeoutId = null
    }

    // If a text object is actively being edited, sync its current content to
    // state before saving (normally this only happens on deselection via object:modified)
    if (activeTextObject?.id) {
      updateStateFromObject(activeTextObject as TwigFabricObject)
    }

    await performSave(true) // Re-throw errors for caller to handle
  }

  /**
   * Extended fabric.js object type that includes our custom 'id' property.
   * The id links canvas objects back to their corresponding state elements.
   */
  type TwigFabricObject = FabricObject & { id?: string }

  // ============================================================================
  // Lifecycle and Reactive Effects
  // ============================================================================

  /**
   * Initialize the app on mount by creating a new presentation.
   */
  let unsubscribeCloseRequested: (() => void) | undefined
  let unsubscribeStateRequest: (() => void) | undefined
  let unsubscribePresentationNavigate: (() => void) | undefined
  let unsubscribePresentationClosed: (() => void) | undefined
  let unsubscribePresentationReady: (() => void) | undefined
  let unsubscribeOpenFile: (() => void) | undefined
  let unsubscribeUpdateDownloaded: (() => void) | undefined
  let unsubscribeOpenSettings: (() => void) | undefined
  let unsubscribeSnapChanged: (() => void) | undefined

  // Reset background and transition checkpoint gates on pointer release so the next drag
  // session gets its own undo entry.
  onMount(() => {
    const resetBgGate = (): void => {
      bgCheckpointPushed = false
      transitionCheckpointPushed = false
    }
    window.addEventListener('pointerup', resetBgGate, { passive: true })
    return (): void => window.removeEventListener('pointerup', resetBgGate)
  })

  function dismissBootSplash(): void {
    document.body.dataset.appReady = 'true'
    const splash = document.getElementById('boot-splash')
    if (splash) {
      // 240ms > 180ms CSS transition — intentional buffer so the element
      // is not removed mid-fade on slow machines.
      window.setTimeout(() => splash.remove(), 240)
    }
  }

  onMount(async () => {
    dismissBootSplash()
    await loadSystemFonts()

    // Check if the app was launched by double-clicking a .tb file
    const launchFile = await window.api?.app?.getFileToOpen()
    if (launchFile) {
      await openPresentationAtPath(launchFile)
    } else {
      await createNewPresentationInternal()
    }
    loadingScreenPhase = 'booting'

    // Handle .tb files opened while the app is already running
    unsubscribeOpenFile = window.api?.app?.onOpenFile(async (filePath) => {
      try {
        await runGuardedPresentationTransition(async () => {
          await openPresentationAtPath(filePath)
          return { completed: true, mutatedState: true }
        })
      } catch (error) {
        console.error('Failed to open presentation from OS event:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        alert(`Failed to open presentation: ${errorMessage}`)
      }
    })

    // Expose state and utility functions to window for console debugging
    if (typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>).__TWIG_STATE__ = {
        appState,
        loadingState
      }
      registerFlushSave(flushPendingSave)
    }

    // Listen for state requests from the debug window
    unsubscribeStateRequest = window.api?.debug?.onStateRequest(() => {
      sendStateToDebugWindow()
    })

    // Forward navigation requests from the presentation window
    unsubscribePresentationNavigate = window.api?.presentation?.onNavigateRequest(
      async (direction) => {
        const idx = appState.currentSlideIndex
        if (direction === 'next' && idx < appState.slideIds.length - 1) {
          await loadSlide(appState.slideIds[idx + 1])
        } else if (direction === 'prev' && idx > 0) {
          await loadSlide(appState.slideIds[idx - 1])
        }
      }
    )

    // Handle presentation window being closed externally
    unsubscribePresentationClosed = window.api?.presentation?.onWindowClosed(() => {
      appState.isPresentingMode = false
    })

    // Send initial state when presentation window signals it's ready.
    // isPresentingMode is set here (not in enterPresentationMode) so that
    // the $effect below doesn't fire a premature sendPresentationState before
    // the presentation window has registered its onStateChanged listener.
    unsubscribePresentationReady = window.api?.presentation?.onWindowReady(async () => {
      await flushPendingSave()
      appState.isPresentingMode = true
      sendPresentationState()
    })

    // Listen for update-downloaded events from the main process
    unsubscribeUpdateDownloaded = window.api?.app?.onUpdateDownloaded((version) => {
      updateAvailableVersion = version
    })

    // Open settings modal when triggered from the native app menu (macOS Cmd+,)
    unsubscribeOpenSettings = window.api?.app?.onOpenSettings(() => {
      settingsOpen = true
    })

    // Initialize alignment-guide snap toggle from the main-owned pref and
    // subscribe to changes pushed from the View menu.
    try {
      const snapPref = await window.api?.prefs?.get('snapToGuides')
      if (typeof snapPref === 'boolean') appState.snapEnabled = snapPref
    } catch {
      // Missing pref key — defaults already set in state.svelte.ts
    }
    unsubscribeSnapChanged = window.api?.app?.onSnapChanged((enabled) => {
      appState.snapEnabled = enabled
    })

    // Listen for close requests from the main process
    unsubscribeCloseRequested = window.api?.lifecycle?.onCloseRequested(async (requestId) => {
      const decision = (await handleCloseRequest()) ? 'proceed' : 'cancel'
      window.api?.lifecycle?.respondToCloseRequest(requestId, decision)
    })
    window.api?.lifecycle?.signalCloseReady()
  })

  /**
   * Clean up pending auto-save timeout and event listeners on component unmount.
   * Prevents memory leaks from dangling timeouts and IPC listeners.
   */
  onDestroy(() => {
    // Clear pending auto-save timeout
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId)
      saveTimeoutId = null
    }
    if (thumbnailTimeoutId) {
      clearTimeout(thumbnailTimeoutId)
      thumbnailTimeoutId = null
    }
    if (savedResetTimeoutId) {
      clearTimeout(savedResetTimeoutId)
      savedResetTimeoutId = null
    }
    if (nowTickId) {
      clearInterval(nowTickId)
      nowTickId = null
    }

    // Unsubscribe from IPC event listeners
    unsubscribeCloseRequested?.()
    unsubscribeStateRequest?.()
    unsubscribePresentationNavigate?.()
    unsubscribePresentationClosed?.()
    unsubscribePresentationReady?.()
    unsubscribeOpenFile?.()
    unsubscribeUpdateDownloaded?.()
    unsubscribeOpenSettings?.()
    unsubscribeSnapChanged?.()

    // Unregister flush save callback
    unregisterFlushSave()
    tempPresentationGuardResolver?.('cancel')
    tempPresentationGuardResolver = null
    closeFailureGuardResolver?.(false)
    closeFailureGuardResolver = null
  })

  /** Keep the window title in sync with the open file. */
  $effect(() => {
    const filePath = appState.currentFilePath
    const isTemp = appState.isTempFile
    if (!filePath || isTemp) {
      document.title = 'twig'
    } else {
      const name = filePath.split('/').pop()?.replace(/\.tb$/, '') ?? 'twig'
      document.title = `${name} — twig`
    }
  })

  /**
   * Reactive effect that broadcasts state changes to the debug window.
   * Runs whenever any tracked state changes.
   */
  $effect(() => {
    // Track all relevant state by reading each property
    void appState.currentFilePath
    void appState.slideIds
    void appState.currentSlideIndex
    void appState.currentSlide
    void appState.selectedObjectId
    void appState.isPresentingMode
    void loadingState.isLoadingSlide

    // Send state update to debug window (if open)
    sendStateToDebugWindow()
  })

  /**
   * Sends the current application state to the debug window.
   */
  function sendStateToDebugWindow(): void {
    const stateSnapshot = {
      currentFilePath: appState.currentFilePath,
      slideIds: [...appState.slideIds],
      currentSlideIndex: appState.currentSlideIndex,
      currentSlideId: appState.currentSlide?.id || null,
      currentSlideElementCount: appState.currentSlide?.elements.length || 0,
      selectedObjectId: appState.selectedObjectId,
      isPresentingMode: appState.isPresentingMode,
      isTempFile: appState.isTempFile,
      isLoadingSlide: loadingState.isLoadingSlide,
      currentSlide: appState.currentSlide ? JSON.parse(JSON.stringify(appState.currentSlide)) : null
    }

    window.api?.debug?.sendStateUpdate(stateSnapshot)
  }

  /**
   * Opens the debug window.
   */
  function openDebugWindow(): void {
    window.api?.debug?.openWindow()
  }

  /**
   * Reactive effect that auto-saves the current slide when it changes.
   * Tracks the last loaded slide ID to avoid saving when switching slides.
   */
  let lastLoadedSlideId: string | null = null
  $effect(() => {
    if (appState.currentSlide) {
      if (lastLoadedSlideId === appState.currentSlide.id) {
        // Same slide updated — schedule auto-save
        scheduleSave()
      } else {
        // Different slide loaded — just track it
        lastLoadedSlideId = appState.currentSlide.id
      }
    }
  })

  /**
   * Reactive effect that loads embedded fonts when a presentation file is opened.
   */
  $effect(() => {
    if (appState.currentFilePath) {
      loadEmbeddedFonts()
    }
  })

  /**
   * Reactive effect that loads the default slide background for the current file.
   */
  $effect(() => {
    const filePath = appState.currentFilePath
    if (filePath) {
      window.api.db
        .getSetting(filePath, 'default_background')
        .then((value) => {
          defaultSlideBackground = value ? JSON.parse(value) : undefined
        })
        .catch(console.error)
    } else {
      defaultSlideBackground = undefined
    }
  })

  /**
   * Main rendering effect - runs whenever the current slide changes.
   *
   * This effect:
   * 1. Captures current selection state (to restore after re-render)
   * 2. Creates the fabric.js canvas if needed
   * 3. Re-renders all canvas objects from state
   * 4. Restores the previous selection state
   *
   * This ensures the canvas always reflects the current state while preserving
   * user selections across state updates.
   */
  $effect(() => {
    if (!appState.currentSlide) {
      // Dispose the canvas instance when there's no slide
      // This ensures a fresh canvas is created when a new slide loads
      // (The UI is destroyed when currentSlide is null, so we need to dispose the old canvas)
      if (fabCanvas) {
        clearMovePathOverlay()
        alignmentGuides?.dispose()
        alignmentGuides = undefined
        fabCanvas.dispose()
        fabCanvas = undefined
      }
      return
    }

    // canvasEl binding might not be ready yet after exiting presentation mode
    // Use requestAnimationFrame to defer to the next frame when DOM is ready
    if (!canvasEl) {
      requestAnimationFrame(() => {
        if (canvasEl && appState.currentSlide) {
          if (!fabCanvas) {
            fabCanvas = new Canvas(canvasEl)
            alignmentGuides?.dispose()
            alignmentGuides = installAlignmentGuides(fabCanvas, {
              isEnabled: () => appState.snapEnabled
            })
          }
          renderCanvasFromState().catch((err) => console.error('Canvas render failed:', err))
        }
      })
      return
    }

    // Step 1: Capture current selection state before re-rendering
    let selectionStateToRestore: SelectionState | null = null
    if (fabCanvas) {
      const activeObject = fabCanvas.getActiveObject()
      if (activeObject) {
        // Handle both single selection and multi-selection
        const selectedObjectIds =
          activeObject.type === 'activeselection'
            ? (activeObject as ActiveSelection).getObjects().map((o) => (o as TwigFabricObject).id!)
            : [(activeObject as TwigFabricObject).id!]

        selectionStateToRestore = {
          selectedObjectIds: selectedObjectIds
        }

        // For text objects, also save cursor/selection position
        if (activeObject instanceof Textbox) {
          selectionRangeToRestore = {
            start: activeObject.selectionStart!,
            end: activeObject.selectionEnd!
          }
          wasEditing = activeObject.isEditing
        }
      }
    }

    // Step 2: Create canvas if it doesn't exist yet OR if it's not connected to the current canvas element
    // This handles cases where the DOM element was recreated but fabCanvas still exists
    if (!fabCanvas || fabCanvas.getElement() !== canvasEl) {
      if (fabCanvas) {
        clearMovePathOverlay()
        alignmentGuides?.dispose()
        alignmentGuides = undefined
        fabCanvas.dispose()
      }
      fabCanvas = new Canvas(canvasEl)
      alignmentGuides = installAlignmentGuides(fabCanvas, {
        isEnabled: () => appState.snapEnabled
      })
    }

    // Step 3: Re-render all objects from state
    renderCanvasFromState().catch((err) => console.error('Canvas render failed:', err))

    // Step 4: Restore previous selection if it existed
    if (selectionStateToRestore && fabCanvas) {
      const objectsToSelect = fabCanvas
        .getObjects()
        .filter((o) =>
          selectionStateToRestore!.selectedObjectIds.includes((o as TwigFabricObject).id!)
        )

      if (objectsToSelect.length > 0) {
        let selection
        if (objectsToSelect.length === 1) {
          selection = objectsToSelect[0]
        } else {
          selection = createActiveSelectionWithLayout(objectsToSelect)
        }
        fabCanvas.setActiveObject(selection)
        fabCanvas.renderAll()

        // Restore text cursor/selection position if this is a text object
        if (selectionRangeToRestore && selection instanceof Textbox) {
          const range = { ...selectionRangeToRestore }
          selectionRangeToRestore = null
          setTimeout(() => {
            if (selection && selection instanceof Textbox) {
              selection.setSelectionStart(range.start)
              selection.setSelectionEnd(range.end)
              fabCanvas?.requestRenderAll()
              handleTextSelectionChange()
            }
          }, 10)
        }
      }
    }
  })

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Removes unwanted "transparent" values from fabric.js character styles.
   * fabric.js sometimes adds transparent values for fill, stroke, and textBackgroundColor
   * which we don't want to persist in the state.
   */
  function cleanStylesObject(
    styles: Record<string, Record<string, unknown>>
  ): Record<string, Record<string, unknown>> {
    const cleaned: Record<string, Record<string, unknown>> = {}

    Object.keys(styles).forEach((lineIndex) => {
      const lineStyles = styles[lineIndex]
      if (!lineStyles || typeof lineStyles !== 'object') return

      cleaned[lineIndex] = {}

      Object.keys(lineStyles).forEach((charIndex) => {
        const charStyle = lineStyles[charIndex]
        if (!charStyle || typeof charStyle !== 'object') return

        const cleanedCharStyle: Record<string, unknown> = {}

        Object.keys(charStyle).forEach((key) => {
          const value = charStyle[key]
          // Skip transparent values for these properties
          if (
            (key === 'fill' || key === 'stroke' || key === 'textBackgroundColor') &&
            value === 'transparent'
          ) {
            return
          }
          cleanedCharStyle[key] = value
        })

        // Only keep character style if it has properties
        if (Object.keys(cleanedCharStyle).length > 0) {
          cleaned[lineIndex][charIndex] = cleanedCharStyle
        }
      })

      // Only keep line if it has character styles
      if (Object.keys(cleaned[lineIndex]).length === 0) {
        delete cleaned[lineIndex]
      }
    })

    return cleaned
  }

  type ControlLayoutTarget = FabricObject & {
    controls?: Record<string, Control>
    cornerSize: number
    touchCornerSize: number
    padding: number
    setControlsVisibility(options: Record<string, boolean>): void
    getScaledWidth(): number
    getScaledHeight(): number
    setCoords(): void
  }

  type ControlLayoutOverrides = {
    widthPx?: number
    heightPx?: number
  }

  function applyControlLayout(
    obj: ControlLayoutTarget,
    overrides?: ControlLayoutOverrides
  ): void {
    const controls = obj.controls
    if (!controls || Object.keys(controls).length === 0) return

    // Creation sites may know only one reliable dimension up front (notably
    // Textbox height before Fabric finishes initial text layout). When an
    // override object is supplied, treat a missing axis as effectively
    // unconstrained instead of falling back to the object's live scaled size.
    const widthPx = overrides ? (overrides.widthPx ?? Infinity) : obj.getScaledWidth()
    const heightPx = overrides ? (overrides.heightPx ?? Infinity) : obj.getScaledHeight()

    const layout = resolveControlLayout({
      widthPx,
      heightPx,
      isArrow: Boolean(controls[ARROW_HEAD_CONTROL_KEY])
    })

    const visibility = Object.fromEntries(
      Object.entries(layout.visibility).filter(([key]) => Boolean(controls[key]))
    )

    obj.cornerSize = layout.cornerSize
    obj.touchCornerSize = layout.touchCornerSize
    obj.padding = layout.padding
    obj.setControlsVisibility(visibility)
    obj.setCoords()
  }

  function createActiveSelectionWithLayout(objects: FabricObject[]): ActiveSelection {
    const selection = new ActiveSelection(objects, { canvas: fabCanvas })
    selection.set(ROTATION_SNAP)
    applyControlLayout(selection as ControlLayoutTarget)
    return selection
  }

  /**
   * Escapes a font family name for use in CSS.
   * Handles special characters like quotes and backslashes.
   */
  function escapeCssFontFamily(fontFamily: string): string {
    // If the font name contains spaces or special characters, wrap in quotes
    // and escape any existing quotes or backslashes
    if (/["\\\s,]/.test(fontFamily)) {
      return `"${fontFamily.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return fontFamily
  }

  // ============================================================================
  // fabric.js Configuration and Canvas Rendering
  // ============================================================================

  /**
   * Renders the current slide's elements onto the fabric.js canvas.
   *
   * This function:
   * 1. Removes old event listeners
   * 2. Clears the canvas
   * 3. Creates fabric.js objects for each element in state
   * 4. Adds event listeners for object modifications
   *
   * Called whenever the current slide changes (via $effect).
   */
  async function renderCanvasFromState(): Promise<void> {
    if (!fabCanvas || !appState.currentSlide) {
      return Promise.resolve()
    }

    // Register any image src blobs for this slide so undo/redo can reconstruct them
    registerImageAssetsFromSlide(appState.currentSlide)

    // Stamp this render so async callbacks can detect staleness
    const generation = ++renderGeneration

    const currentSlide = appState.currentSlide

    // Null out the stale text object reference before clearing the canvas.
    // When selection is restored after re-render, handleSelection fires and would call
    // updateStateFromObject(activeTextObject) on the now-destroyed old fabric object.
    // That state mutation re-triggers this $effect, causing an infinite reactive loop.
    // Nulling here breaks the cycle: handleSelection's guard `if (activeTextObject)` is false.
    activeTextObject = null

    // Remove old event listeners to prevent duplicate handlers
    fabCanvas.off('object:modified', handleObjectModified)
    fabCanvas.off('object:moving', handleObjectMoving)
    fabCanvas.off('text:changed', handleTextChanged)
    fabCanvas.off('text:editing:entered', pushCheckpoint)
    fabCanvas.off('selection:created', handleSelection)
    fabCanvas.off('selection:updated', handleSelection)
    fabCanvas.off('selection:cleared', handleSelectionCleared)
    fabCanvas.off('contextmenu', handleContextMenu)
    fabCanvas.off('mouse:down:before', handleCanvasMouseDownBefore)

    // Read elements synchronously (before any await) so Svelte 5 tracks the
    // array within the $effect's reactive context. Accessing elements after an
    // await would put the read outside the tracking window, breaking the
    // dependency so that push() mutations no longer trigger a re-render.
    const sortedElements = [...currentSlide.elements].sort((a, b) => a.zIndex - b.zIndex)

    // Build a lookup of element id → zIndex for use by async image insertions
    const zIndexById = new Map(sortedElements.map((el) => [el.id, el.zIndex]))

    // Clear the canvas and apply background (may await for image backgrounds)
    fabCanvas.clear()
    await applySlideBackground(currentSlide.background)
    if (renderGeneration !== generation) {
      slideTransitionOverlaySrc = null
      return
    }

    // Add non-image elements synchronously in z-order
    sortedElements.forEach((element) => {
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
          id: element.id
        })
      } else if (element.type === 'ellipse') {
        fabObj = new Ellipse({
          left: element.x,
          top: element.y,
          rx: element.width / 2,
          ry: element.height / 2,
          angle: element.angle,
          fill: element.fill,
          id: element.id
        })
      } else if (element.type === 'triangle') {
        fabObj = new Triangle({
          left: element.x,
          top: element.y,
          width: element.width,
          height: element.height,
          angle: element.angle,
          fill: element.fill,
          id: element.id
        })
      } else if (element.type === 'star') {
        fabObj = new Polygon(makeStarPoints(), {
          left: element.x,
          top: element.y,
          angle: element.angle,
          fill: element.fill,
          id: element.id,
          scaleX: element.width / STAR_CANONICAL_W,
          scaleY: element.height / STAR_CANONICAL_H
        })
      } else if (element.type === 'arrow') {
        ensureArrowShape(element)
        const shape = element.arrowShape ?? DEFAULT_ARROW_SHAPE
        // Defensive: persisted rows (or a user typing a negative into the size
        // field) may arrive with signed dimensions. Normalize in state so the
        // fabric polygon and everything downstream see positive magnitudes.
        element.width = Math.abs(element.width)
        element.height = Math.abs(element.height)
        const arrowPoly = new Polygon(makeArrowPoints(element.width, element.height, shape), {
          left: element.x,
          top: element.y,
          angle: element.angle,
          fill: element.fill,
          id: element.id,
          width: element.width,
          height: element.height,
          pathOffset: new Point(element.width / 2, element.height / 2),
          scaleX: 1,
          scaleY: 1
        })
        installArrowAdjustmentHandles(arrowPoly, element)
        fabObj = arrowPoly
      } else if (element.type === 'text') {
        const cleanedStyles = element.styles ? cleanStylesObject(element.styles) : {}
        fabObj = new Textbox(element.text || 'Hello', {
          left: element.x,
          top: element.y,
          width: element.width,
          angle: element.angle,
          id: element.id,
          fill: element.fill,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          fontWeight: element.fontWeight,
          fontStyle: element.fontStyle,
          underline: element.underline,
          styles: cleanedStyles,
          ...getTextboxWrappingOptions(element.text),
          lockScalingY: true
        })
      }
      if (fabObj) {
        fabObj.set(ROTATION_SNAP)
        applyControlLayout(fabObj as ControlLayoutTarget, {
          widthPx: element.width,
          heightPx: element.height
        })
        fabCanvas.add(fabObj)
      }
    })

    // Add image elements asynchronously, inserting at the correct z-position.
    // When each image resolves, we count how many currently-present canvas objects
    // have a lower zIndex (via ID lookup) to find the right insertAt index.
    // insertAt gives correct intermediate rendering as each image arrives.
    // A Promise.allSettled correction pass below fixes any ordering errors that
    // occur when two images resolve in the same microtask and see identical state.
    const imageLoads: Promise<void>[] = []

    const applyImageElement = (
      htmlImg: HTMLImageElement,
      element: TwigElement,
      imageZIndex: number
    ): void => {
      if (!fabCanvas || renderGeneration !== generation) return
      const img = new FabricImage(htmlImg)
      const scaleX = element.width / (img.width || 1)
      const scaleY = element.height / (img.height || 1)
      img.set({
        left: element.x,
        top: element.y,
        angle: element.angle,
        scaleX,
        scaleY,
        id: element.id,
        ...ROTATION_SNAP
      })
      applyControlLayout(img as ControlLayoutTarget, {
        widthPx: element.width,
        heightPx: element.height
      })
      const insertIndex = (fabCanvas.getObjects() as TwigFabricObject[]).filter(
        (obj) => (obj.id ? (zIndexById.get(obj.id) ?? 0) : 0) < imageZIndex
      ).length
      fabCanvas.insertAt(insertIndex, img)
    }

    sortedElements.forEach((element) => {
      if (element.type !== 'image' || !element.src) return
      const imageZIndex = element.zIndex
      const cached = imageElementCache.get(element.src)

      if (cached) {
        // Synchronous path — cached element, no flicker
        applyImageElement(cached, element, imageZIndex)
      } else {
        // Async path — first load only
        const load = FabricImage.fromURL(element.src, { crossOrigin: 'anonymous' })
          .then((img) => {
            // Cache the underlying HTMLImageElement for future renders
            const el = img.getElement()
            if (el instanceof HTMLImageElement) {
              imageElementCache.set(element.src!, el)
            }
            if (!fabCanvas || renderGeneration !== generation) return
            const scaleX = element.width / (img.width || 1)
            const scaleY = element.height / (img.height || 1)
            img.set({
              left: element.x,
              top: element.y,
              angle: element.angle,
              scaleX,
              scaleY,
              id: element.id,
              ...ROTATION_SNAP
            })
            applyControlLayout(img as ControlLayoutTarget, {
              widthPx: element.width,
              heightPx: element.height
            })

            // Count objects already on the canvas whose zIndex is lower than ours
            const insertIndex = (fabCanvas.getObjects() as TwigFabricObject[]).filter(
              (obj) => (obj.id ? (zIndexById.get(obj.id) ?? 0) : 0) < imageZIndex
            ).length

            fabCanvas.insertAt(insertIndex, img)
            // Do NOT renderAll() here — wait for Promise.allSettled to do a single
            // batched render, avoiding N progressive re-renders that look like flicker.
          })
          .catch((error) => {
            console.error('Failed to load image:', error)
          })

        imageLoads.push(load)
      }
    })

    fabCanvas.renderAll()

    // Kick off background prefetch of adjacent slides' images — fire-and-forget
    prefetchAdjacentSlideImages().catch(() => {})

    // Re-attach event listeners
    fabCanvas.on('object:modified', handleObjectModified)
    fabCanvas.on('object:moving', handleObjectMoving)
    fabCanvas.on('text:changed', handleTextChanged)
    fabCanvas.on('text:editing:entered', pushCheckpoint)
    fabCanvas.on('selection:created', handleSelection)
    fabCanvas.on('selection:updated', handleSelection)
    fabCanvas.on('selection:cleared', handleSelectionCleared)
    fabCanvas.on('contextmenu', handleContextMenu)
    fabCanvas.on('mouse:down:before', handleCanvasMouseDownBefore)

    if (imageLoads.length === 0) {
      slideTransitionOverlaySrc = null
      applyPendingSelection()
      renderMovePathOverlay()
      captureAndStoreThumbnail().catch(console.error)
      return Promise.resolve()
    }

    // Once all images have settled, correct any ordering errors that occurred when
    // two images resolved simultaneously and computed the same insertAt index.
    // Uses the public moveTo() API (remove + splice at target index) in ascending
    // z-order so each placement is stable without triggering selection events.
    // The generation guard ensures this is a no-op if the slide changed while loading.
    return Promise.allSettled(imageLoads).then(() => {
      if (!fabCanvas || renderGeneration !== generation) {
        slideTransitionOverlaySrc = null
        return
      }
      if (imageLoads.length > 1) {
        const sorted = (fabCanvas.getObjects() as TwigFabricObject[])
          .slice()
          .sort((a, b) => (zIndexById.get(a.id ?? '') ?? 0) - (zIndexById.get(b.id ?? '') ?? 0))
        sorted.forEach((obj, targetIndex) => fabCanvas.moveObjectTo(obj, targetIndex))
      }
      fabCanvas.renderAll()
      slideTransitionOverlaySrc = null
      applyPendingSelection()
      renderMovePathOverlay()
      captureAndStoreThumbnail().catch(console.error)
    })
  }

  function applyPendingSelection(): void {
    if (pendingSelectionIds.length === 0 || !fabCanvas) return
    const ids = new Set(pendingSelectionIds)
    pendingSelectionIds = []
    const targets = fabCanvas.getObjects().filter((o) => ids.has((o as TwigFabricObject).id ?? ''))
    if (targets.length === 1) {
      fabCanvas.setActiveObject(targets[0])
    } else if (targets.length > 1) {
      const selection = createActiveSelectionWithLayout(targets)
      fabCanvas.setActiveObject(selection)
    }
    fabCanvas.renderAll()
  }

  /**
   * Handles the 'object:modified' event from fabric.js.
   * Syncs changes from the canvas back to the application state.
   */
  function handleObjectModified(event: { target?: TwigFabricObject | ActiveSelection }): void {
    if (!appState.currentSlide) return
    const target = event.target
    if (!target) return

    const overlayTarget = target as MovePathOverlayFabricObject
    if (overlayTarget.overlayRole === 'move-path-ghost' && movePathDragState) {
      const draggedElementId = movePathDragState.elementId
      setMoveActionTarget(
        draggedElementId,
        movePathDragState.actionId,
        overlayTarget.left ?? 0,
        overlayTarget.top ?? 0,
        true
      )
      appState.selectedObjectId = draggedElementId
      expandedMovePathElementId = draggedElementId
      movePathDragState = null
      movePathCheckpointPushed = false
      preserveSelectionAfterGhostDrag(draggedElementId)
      return
    }

    // Arrow adjustment-handle drags are self-contained: the Control callbacks
    // already pushed a pre-drag checkpoint (mouseDownHandler), mutated the
    // element's ratios and geometry live (actionHandler), and scheduled save
    // (mouseUpHandler). Re-running pushCheckpoint / updateStateFromObject here
    // would produce a duplicate no-op undo step and try to re-derive
    // width/height from scaleX/scaleY (both 1 during these drags).
    const actionName = (event as { transform?: { action?: string } }).transform?.action
    if (actionName === ARROW_HEAD_ACTION || actionName === ARROW_SHAFT_ACTION) {
      // Arrow adjustment drags mutate arrowShape in place and keep the nominal
      // width/height fixed, but re-apply the compact control layout here anyway
      // so the visible handle set is never left stale after the drag completes.
      applyControlLayout(target as ControlLayoutTarget)
      renderMovePathOverlay()
      return
    }

    // Capture state BEFORE updateStateFromObject mutates it — this is the pre-drag snapshot
    pushCheckpoint()

    // Handle both single and multi-selection modifications
    if (target.type === 'activeselection') {
      const selection = target as ActiveSelection
      selection.getObjects().forEach((obj) => {
        updateStateFromObject(obj as TwigFabricObject)
      })
      applyControlLayout(selection as unknown as ControlLayoutTarget)
    } else {
      updateStateFromObject(target as TwigFabricObject)
      applyControlLayout(target as ControlLayoutTarget)
    }

    // Trigger auto-save directly — the $effect doesn't subscribe to deep element
    // property changes, so we must call scheduleSave() explicitly here.
    renderMovePathOverlay()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  /**
   * Updates the application state to match a modified canvas object.
   *
   * This is the reverse direction of renderCanvasFromState():
   * Canvas changes → State updates
   *
   * Uses fabric.js's qrDecompose to extract position, rotation, and scale
   * from the object's transform matrix.
   */
  function updateStateFromObject(obj: TwigFabricObject): void {
    if (!obj.id || typeof obj.width !== 'number' || !appState.currentSlide) return

    const elementInState = appState.currentSlide.elements.find((el) => el.id === obj.id)
    if (!elementInState) return

    // Decompose the transform matrix to get position, rotation, and scale
    const transform = util.qrDecompose(obj.calcTransformMatrix())

    // Update state with the new transform values
    elementInState.x = transform.translateX
    elementInState.y = transform.translateY
    elementInState.angle = transform.angle
    elementInState.width = obj.width * transform.scaleX
    elementInState.height = obj.height * transform.scaleY

    // Arrow polygons re-derive their points from (width, height, arrowShape)
    // every time the nominal bbox changes. Reset scaleX/scaleY to 1 so the
    // state-to-canvas and canvas-to-state directions stay in sync.
    // Normalize dimensions to their magnitude — a drag past the opposite edge
    // produces a negative scaleX/scaleY, and signed intrinsic dimensions
    // would poison fabric's bbox/hit-testing on the next modify/save cycle.
    if (elementInState.type === 'arrow' && obj instanceof Polygon) {
      elementInState.width = Math.abs(elementInState.width)
      elementInState.height = Math.abs(elementInState.height)
      ensureArrowShape(elementInState)
      applyArrowGeometry(obj, elementInState)
    }

    // For text objects, also update text content and styling
    if (elementInState.type === 'text' && obj instanceof Textbox) {
      elementInState.text = obj.text
      elementInState.fontSize = obj.fontSize
      elementInState.fontFamily = obj.fontFamily
      elementInState.fontWeight = obj.fontWeight
      elementInState.fontStyle = obj.fontStyle
      elementInState.underline = obj.underline
      elementInState.fill = obj.fill as string
      // Clean up any unwanted transparent values before saving to state
      elementInState.styles = obj.styles ? cleanStylesObject(obj.styles) : undefined
    }
  }

  function syncTextEditState(obj: Textbox | null | undefined): void {
    if (!obj?.id || !appState.currentSlide) return

    const elementInState = appState.currentSlide.elements.find((el) => el.id === obj.id)
    if (!elementInState || elementInState.type !== 'text') return

    elementInState.text = obj.text
    elementInState.fontSize = obj.fontSize
    elementInState.fontFamily = obj.fontFamily
    elementInState.fontWeight = obj.fontWeight
    elementInState.fontStyle = obj.fontStyle
    elementInState.underline = obj.underline
    elementInState.fill = obj.fill as string
    elementInState.styles = obj.styles ? cleanStylesObject(obj.styles) : undefined
  }

  /**
   * Syncs property panel changes (x, y, width, height, angle, fill) from state
   * back to the live Fabric object, then schedules a save.
   *
   * The $effect that drives renderCanvasFromState() only tracks the elements
   * array reference, not deep property mutations — so we must push changes
   * to the canvas object directly instead of relying on a full re-render.
   */
  function handlePropertyChange(): void {
    const el = appState.currentSlide?.elements.find((e) => e.id === appState.selectedObjectId)
    const obj = fabCanvas
      ?.getObjects()
      .find((o) => (o as TwigFabricObject).id === appState.selectedObjectId)
    if (el && obj) {
      // Shape-type-specific sync: ellipse uses rx/ry; polygons use scaleX/scaleY
      // against their canonical bounding box; rect/triangle use raw width/height.
      if (el.type === 'ellipse' && obj instanceof Ellipse) {
        obj.set({
          left: el.x,
          top: el.y,
          angle: el.angle,
          fill: el.fill,
          rx: el.width / 2,
          ry: el.height / 2,
          scaleX: 1,
          scaleY: 1
        })
      } else if (el.type === 'star') {
        obj.set({
          left: el.x,
          top: el.y,
          angle: el.angle,
          fill: el.fill,
          scaleX: el.width / STAR_CANONICAL_W,
          scaleY: el.height / STAR_CANONICAL_H
        })
      } else if (el.type === 'arrow' && obj instanceof Polygon) {
        ensureArrowShape(el)
        obj.set({
          left: el.x,
          top: el.y,
          angle: el.angle,
          fill: el.fill
        })
        applyArrowGeometry(obj, el)
      } else {
        // rect, triangle: state stores effective dimensions; reset scale to 1.
        obj.set({
          left: el.x,
          top: el.y,
          angle: el.angle,
          fill: el.fill,
          scaleX: 1,
          scaleY: 1,
          width: el.width,
          height: el.height
        })
      }
      obj.setCoords()
      applyControlLayout(obj as ControlLayoutTarget)
      fabCanvas?.renderAll()
    }
    renderMovePathOverlay()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  // ============================================================================
  // Animation Handlers
  // ============================================================================

  function handleAnimationChange(elementId: string, animations: ElementAnimations): void {
    const el = appState.currentSlide?.elements.find((e) => e.id === elementId)
    if (!el || !appState.currentSlide) return

    const prev = el.animations ?? {}
    el.animations = Object.keys(animations).length > 0 ? animations : undefined

    let order = [...appState.currentSlide.animationOrder]
    for (const cat of ['buildIn', 'buildOut'] as const) {
      const wasSet = !!(prev as ElementAnimations)[cat]
      const isSet = !!(animations as ElementAnimations)[cat]
      if (!wasSet && isSet) {
        order = insertAnimationStep(order, { elementId, category: cat })
      }
    }

    const prevActionIds = new Set((prev.actions ?? []).map((a) => a.id))
    for (const action of animations.actions ?? []) {
      if (!prevActionIds.has(action.id)) {
        order = insertAnimationStep(order, { elementId, category: 'action', actionId: action.id })
      }
    }

    // Prune steps for removed categories
    appState.currentSlide.animationOrder = normalizeAnimationOrder({
      ...appState.currentSlide,
      animationOrder: order
    })

    renderMovePathOverlay()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  function handleRemoveAnimationStep(step: AnimationStep): void {
    if (!appState.currentSlide) return
    pushCheckpoint()

    const el = appState.currentSlide.elements.find((e) => e.id === step.elementId)
    if (el?.animations) {
      const updated = { ...el.animations }
      if (step.category === 'action' && step.actionId) {
        const remaining = (updated.actions ?? []).filter((a) => a.id !== step.actionId)
        if (remaining.length > 0) updated.actions = remaining
        else delete updated.actions
      } else {
        delete updated[step.category as 'buildIn' | 'buildOut']
      }
      el.animations = Object.keys(updated).length > 0 ? updated : undefined
    }

    appState.currentSlide.animationOrder = normalizeAnimationOrder(appState.currentSlide)

    renderMovePathOverlay()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  // ============================================================================
  // Selection Handling
  // ============================================================================

  /**
   * Handles selection creation and update events from fabric.js.
   * Updates app state and manages rich text editor visibility.
   */
  function handleSelection(event: { selected?: TwigFabricObject[] }): void {
    if (isRestoringHistory) {
      return
    }

    const selection = event.selected?.[0] as MovePathOverlayFabricObject | undefined
    if (selection?.overlayRole === 'move-path-ghost') {
      return
    }
    if (selection?.overlayRole) {
      restoreSelectedCanvasObject()
      return
    }

    const previousSelectedId = appState.selectedObjectId

    if (event.selected && event.selected.length === 1) {
      appState.selectedObjectId = event.selected[0].id || null
    } else {
      appState.selectedObjectId = null
    }

    if (appState.selectedObjectId !== previousSelectedId) {
      expandedMovePathElementId = null
    }

    // Sync previous text object state before switching - object:modified doesn't always fire
    if (activeTextObject) {
      updateStateFromObject(activeTextObject as TwigFabricObject)
      // Explicit call: $effect doesn't subscribe to deep element property changes
      scheduleSave()
    }

    // Remove old text selection change listener
    activeTextObject?.off('selection:changed', handleTextSelectionChange)

    const selectedObject = event.selected?.[0]
    if (selectedObject instanceof Textbox) {
      // Text object selected - enable rich text controls
      activeTextObject = selectedObject

      // Update formatting button states based on the selected text object
      handleTextSelectionChange()

      // If user was editing before, restore editing mode
      if (wasEditing) {
        activeTextObject.enterEditing()
        wasEditing = false
      }

      // Listen for text selection changes to update formatting buttons
      activeTextObject.on('selection:changed', handleTextSelectionChange)
      handleTextSelectionChange()
    } else {
      // Non-text object selected
      activeTextObject = null
      isSelectionBold = false
      isSelectionItalic = false
      isSelectionUnderlined = false
      wasEditing = false
    }

    // Marquee/shift-click selections are created by Fabric internally and
    // never flow through createActiveSelectionWithLayout, so apply the compact
    // layout here to cover every selection entry path.
    const activeObj = fabCanvas?.getActiveObject()
    if (activeObj) {
      applyControlLayout(activeObj as ControlLayoutTarget)
    }

    renderMovePathOverlay()
  }

  /**
   * Handles selection cleared event - resets selection state.
   */
  function handleSelectionCleared(): void {
    if (isRestoringHistory) {
      return
    }

    if (movePathDragState) {
      return
    }
    if (suppressMovePathSelectionClear) {
      restoreSelectedCanvasObject()
      return
    }

    // Sync state before clearing - object:modified doesn't always fire reliably
    if (activeTextObject) {
      updateStateFromObject(activeTextObject as TwigFabricObject)
      // Explicit call: $effect doesn't subscribe to deep element property changes
      scheduleSave()
    }
    activeTextObject?.off('selection:changed', handleTextSelectionChange)
    appState.selectedObjectId = null
    expandedMovePathElementId = null
    activeTextObject = null
    isSelectionBold = false
    isSelectionItalic = false
    isSelectionUnderlined = false
    selectionFontSize = 40
    selectionFillColor = '#333333'
    wasEditing = false
    lastTextSelectionRange = null
    suppressSelectionTracking = false
    clearMovePathOverlay()
    fabCanvas?.requestRenderAll()
  }

  function handleTextChanged(event: { target?: TwigFabricObject }): void {
    const target = event.target
    if (!(target instanceof Textbox)) return
    const wrappingChanged = syncTextboxWrapping(target)
    if (wrappingChanged) {
      fabCanvas?.requestRenderAll()
    }
    syncTextEditState(target)
    scheduleSave()
    scheduleThumbnailCapture()
  }

  // ============================================================================
  // Rich Text Formatting
  // ============================================================================

  /**
   * Applies a style to the currently selected text range.
   * If no text is selected, applies the style to the entire text object.
   */
  function applyStyleToSelection(style: Record<string, string | number | boolean>): void {
    if (!activeTextObject) return

    const hasSelection = activeTextObject.selectionStart !== activeTextObject.selectionEnd

    if (hasSelection) {
      // Apply to selected text range
      // Instead of using setSelectionStyles (which can accumulate styles incorrectly),
      // manually manage character-level styles to avoid corruption
      const start = activeTextObject.selectionStart ?? 0
      const end = activeTextObject.selectionEnd ?? 0

      for (let i = start; i < end; i++) {
        const loc = activeTextObject.get2DCursorLocation(i, true)
        const lineIndex = loc.lineIndex
        const charIndex = loc.charIndex

        // Ensure the styles structure exists
        if (!activeTextObject.styles[lineIndex]) {
          activeTextObject.styles[lineIndex] = {}
        }
        if (!activeTextObject.styles[lineIndex][charIndex]) {
          activeTextObject.styles[lineIndex][charIndex] = {}
        }

        // Apply each style property
        Object.keys(style).forEach((key) => {
          const newValue = style[key]
          const baseValue = activeTextObject[key]

          if (newValue === baseValue) {
            // New value matches base - remove character-level override
            delete activeTextObject.styles[lineIndex][charIndex][key]
          } else {
            // New value differs from base - set character-level style
            activeTextObject.styles[lineIndex][charIndex][key] = newValue
          }
        })

        // Clean up empty style objects
        if (Object.keys(activeTextObject.styles[lineIndex][charIndex]).length === 0) {
          delete activeTextObject.styles[lineIndex][charIndex]
        }
        if (Object.keys(activeTextObject.styles[lineIndex]).length === 0) {
          delete activeTextObject.styles[lineIndex]
        }
      }

      activeTextObject.dirty = true
      activeTextObject.initDimensions()

      // Clean up any transparent values that fabric.js might have added during initDimensions
      if (activeTextObject.styles) {
        activeTextObject.styles = cleanStylesObject(activeTextObject.styles)
      }

      handleTextSelectionChange()
    } else {
      // No selection - apply style to the entire text object
      // Just update the base properties - do NOT use setSelectionStyles which creates
      // character-level overrides that accumulate as the user types
      Object.keys(style).forEach((key) => {
        activeTextObject[key] = style[key]
      })

      // Update any character-level overrides with the new values
      // This ensures all characters use the new font/color/etc, even if they have other formatting
      if (activeTextObject.styles) {
        const styleKeys = Object.keys(style)
        Object.keys(activeTextObject.styles).forEach((lineIndex) => {
          const lineNum = parseInt(lineIndex)
          if (!activeTextObject.styles[lineNum]) return
          Object.keys(activeTextObject.styles[lineNum]).forEach((charIndex) => {
            const charNum = parseInt(charIndex)
            const charStyles = activeTextObject.styles[lineNum][charNum]
            if (!charStyles) return

            // Update the properties we're changing at the base level
            // This is important for properties like fontFamily - if a character has
            // { fontFamily: 'Arial', fontWeight: 'bold' } and we change the whole text
            // to 'Helvetica', we want { fontFamily: 'Helvetica', fontWeight: 'bold' }
            styleKeys.forEach((key) => {
              if (charStyles[key] !== undefined) {
                charStyles[key] = style[key]
              }
            })

            // If no styles left, remove the character entry
            if (Object.keys(charStyles).length === 0) {
              delete activeTextObject.styles[lineNum][charNum]
            }
          })
          // If no characters left in line, remove line entry
          if (Object.keys(activeTextObject.styles[lineNum]).length === 0) {
            delete activeTextObject.styles[lineNum]
          }
        })
      }

      // Mark as dirty so fabric.js re-renders
      activeTextObject.dirty = true
      activeTextObject.initDimensions()

      // Clean up any transparent values that fabric.js might have added during initDimensions
      if (activeTextObject.styles) {
        activeTextObject.styles = cleanStylesObject(activeTextObject.styles)
      }

      // Update UI state
      if (style.fontWeight !== undefined) {
        isSelectionBold = style.fontWeight === 'bold'
      }
      if (style.fontStyle !== undefined) {
        isSelectionItalic = style.fontStyle === 'italic'
      }
      if (style.underline !== undefined) {
        isSelectionUnderlined = style.underline === true
      }
      if (style.fontSize !== undefined) {
        selectionFontSize = style.fontSize as number
      }
      if (style.fontFamily !== undefined) {
        selectionFontFamily = style.fontFamily as string
      }

      // Update button states based on actual text state (not just what we applied)
      handleTextSelectionChange()
    }

    fabCanvas?.renderAll()
    syncTextEditState(activeTextObject)
    scheduleSave()
    scheduleThumbnailCapture()
  }

  /** Toggles bold formatting on the selected text */
  function toggleBold(): void {
    applyStyleToSelection({ fontWeight: isSelectionBold ? 'normal' : 'bold' })
  }

  /** Toggles italic formatting on the selected text */
  function toggleItalic(): void {
    applyStyleToSelection({ fontStyle: isSelectionItalic ? 'normal' : 'italic' })
  }

  /** Toggles underline formatting on the selected text */
  function toggleUnderline(): void {
    applyStyleToSelection({ underline: !isSelectionUnderlined })
  }

  /** Changes the font size of the selected text */
  function changeFontSize(event: Event): void {
    const size = parseInt((event.target as HTMLInputElement).value)
    if (!isNaN(size) && size > 0 && activeTextObject) {
      applyStyleToSelection({ fontSize: size })
      // Note: Do NOT call updateStateFromObject() here - it would re-render and lose cursor
    }
  }

  /**
   * Updates the formatting button states based on the current text selection.
   * Checks if the selected text has bold, italic, underline, font size, and font family.
   */
  function handleTextSelectionChange(): void {
    if (!activeTextObject) return

    const hasSelection = activeTextObject.selectionStart !== activeTextObject.selectionEnd
    const textLength = activeTextObject.text?.length ?? 0

    // Helper to get effective style value using fabric's getValueOfPropertyAt
    // which properly handles base + character-level style inheritance
    type StyleProperty =
      | 'fontWeight'
      | 'fontStyle'
      | 'underline'
      | 'fontFamily'
      | 'fontSize'
      | 'fill'
    const getEffectiveStyle = (charIndex: number, property: StyleProperty): unknown => {
      const loc = activeTextObject.get2DCursorLocation(charIndex, true)
      return activeTextObject.getValueOfPropertyAt(loc.lineIndex, loc.charIndex, property)
    }

    if (hasSelection) {
      if (!suppressSelectionTracking) {
        lastTextSelectionRange = {
          start: activeTextObject.selectionStart ?? 0,
          end: activeTextObject.selectionEnd ?? 0
        }
      }

      const start = activeTextObject.selectionStart ?? 0
      const end = activeTextObject.selectionEnd ?? 0

      // Check effective styles for all characters in selection
      let allBold = true
      let allItalic = true
      let allUnderlined = true
      const fontFamilies = new SvelteSet<string>()
      let firstFontSize: number | null = null

      for (let i = start; i < end; i++) {
        if (getEffectiveStyle(i, 'fontWeight') !== 'bold') allBold = false
        if (getEffectiveStyle(i, 'fontStyle') !== 'italic') allItalic = false
        if (getEffectiveStyle(i, 'underline') !== true) allUnderlined = false
        fontFamilies.add(String(getEffectiveStyle(i, 'fontFamily') || activeTextObject.fontFamily))
        if (firstFontSize === null) {
          firstFontSize = (getEffectiveStyle(i, 'fontSize') as number) || activeTextObject.fontSize
        }
      }

      isSelectionBold = end > start && allBold
      isSelectionItalic = end > start && allItalic
      isSelectionUnderlined = end > start && allUnderlined

      if (firstFontSize !== null) {
        selectionFontSize = firstFontSize
      } else if (activeTextObject.fontSize) {
        selectionFontSize = activeTextObject.fontSize
      }

      if (fontFamilies.size > 1) {
        selectionFontFamily = 'Multiple'
      } else if (fontFamilies.size === 1) {
        selectionFontFamily = fontFamilies.values().next().value
      } else if (activeTextObject.fontFamily) {
        selectionFontFamily = activeTextObject.fontFamily
      }

      // Read fill color from first selected character
      if (end > start) {
        selectionFillColor =
          (getEffectiveStyle(start, 'fill') as string) ||
          (activeTextObject.fill as string) ||
          '#333333'
      }
    } else {
      if (!suppressSelectionTracking) {
        lastTextSelectionRange = null
      }

      // No text selection - check effective styles for ALL characters
      let allBold = true
      let allItalic = true
      let allUnderlined = true
      const fontFamilies = new SvelteSet<string>()
      let firstFontSize: number | null = null

      for (let i = 0; i < textLength; i++) {
        if (getEffectiveStyle(i, 'fontWeight') !== 'bold') allBold = false
        if (getEffectiveStyle(i, 'fontStyle') !== 'italic') allItalic = false
        if (getEffectiveStyle(i, 'underline') !== true) allUnderlined = false
        fontFamilies.add(String(getEffectiveStyle(i, 'fontFamily') || activeTextObject.fontFamily))
        if (firstFontSize === null) {
          firstFontSize = (getEffectiveStyle(i, 'fontSize') as number) || activeTextObject.fontSize
        }
      }

      isSelectionBold = textLength > 0 && allBold
      isSelectionItalic = textLength > 0 && allItalic
      isSelectionUnderlined = textLength > 0 && allUnderlined

      if (firstFontSize !== null) {
        selectionFontSize = firstFontSize
      } else if (activeTextObject.fontSize) {
        selectionFontSize = activeTextObject.fontSize
      }

      if (fontFamilies.size > 1) {
        selectionFontFamily = 'Multiple'
      } else if (fontFamilies.size === 1) {
        selectionFontFamily = fontFamilies.values().next().value
      } else if (activeTextObject.fontFamily) {
        selectionFontFamily = activeTextObject.fontFamily
      }

      // Read fill color from first character
      if (textLength > 0) {
        selectionFillColor =
          (getEffectiveStyle(0, 'fill') as string) || (activeTextObject.fill as string) || '#333333'
      }
    }
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  function resolveTempPresentationGuard(choice: TempPresentationPromptChoice): void {
    const resolve = tempPresentationGuardResolver
    tempPresentationGuardResolver = null
    tempPresentationGuardOpen = false
    resolve?.(choice)
  }

  function promptToAbandonTempPresentation(): Promise<TempPresentationPromptChoice> {
    if (tempPresentationGuardResolver) {
      return Promise.resolve('cancel')
    }

    tempPresentationGuardOpen = true
    return new Promise((resolve) => {
      tempPresentationGuardResolver = resolve
    })
  }

  function resolveCloseFailureGuard(shouldClose: boolean): void {
    const resolve = closeFailureGuardResolver
    closeFailureGuardResolver = null
    closeFailureGuardOpen = false
    closeFailureGuardMessage = ''
    resolve?.(shouldClose)
  }

  function promptToForceCloseAfterFailure(error: unknown): Promise<boolean> {
    if (closeFailureGuardResolver) {
      return Promise.resolve(false)
    }

    const errorMessage = error instanceof Error ? error.message : String(error)
    closeFailureGuardMessage = errorMessage || 'Unknown error'
    closeFailureGuardOpen = true
    return new Promise((resolve) => {
      closeFailureGuardResolver = resolve
    })
  }

  function cancelPendingPersistence(): void {
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId)
      saveTimeoutId = null
    }
    if (thumbnailTimeoutId) {
      clearTimeout(thumbnailTimeoutId)
      thumbnailTimeoutId = null
    }
  }

  async function restorePresentationState(
    filePath: string,
    slideId: string | null = null
  ): Promise<void> {
    clearAllHistory()
    imageElementCache.clear()
    prefetchedSlideIds.clear()
    loadingScreenPhase = 'opening'
    await loadPresentation(filePath)

    if (slideId && slideId !== appState.currentSlide?.id && appState.slideIds.includes(slideId)) {
      await loadSlide(slideId)
    }

    setSaveStatus('saved')
    prefetchAllSlideImages().catch(() => {})
  }

  async function openPresentationAtPath(filePath: string): Promise<boolean> {
    loadingScreenPhase = 'opening'
    clearAllHistory()
    imageElementCache.clear()
    prefetchedSlideIds.clear()
    await loadPresentation(filePath)
    setSaveStatus('saved')
    prefetchAllSlideImages().catch(() => {})
    return true
  }

  async function withPresentationTransitionLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = activePresentationTransitionPromise
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    activePresentationTransitionPromise = current

    try {
      if (previous) {
        await previous
      }
      return await action()
    } finally {
      release()
      if (activePresentationTransitionPromise === current) {
        activePresentationTransitionPromise = null
      }
    }
  }

  interface PresentationTransitionAttempt {
    completed: boolean
    mutatedState: boolean
  }

  async function runGuardedPresentationTransition(
    replacePresentation: () => Promise<PresentationTransitionAttempt>
  ): Promise<boolean> {
    return withPresentationTransitionLock(() =>
      switchPresentationWithTempGuard({
        currentFilePath: appState.currentFilePath,
        isTempFile: appState.isTempFile,
        flushPendingSave,
        isBootstrapPresentation: (filePath) => window.api.db.isBootstrapPresentation(filePath),
        promptToAbandonTemp: promptToAbandonTempPresentation,
        saveTempPresentation: saveCurrentPresentationAs,
        replacePresentation: async (_decision) => {
          // Snapshot after the guard resolves because choosing "Save" may move
          // a temp presentation to a new on-disk location.
          const restoreFilePath = appState.currentFilePath
          const restoreSlideId = appState.currentSlide?.id ?? null

          try {
            const transition = await replacePresentation()

            if (!transition.completed && transition.mutatedState && restoreFilePath) {
              try {
                await restorePresentationState(restoreFilePath, restoreSlideId)
              } catch (restoreError) {
                console.error(
                  'Failed to restore previous presentation after canceled switch:',
                  restoreError
                )
              }
            }

            return transition.completed
          } catch (error) {
            if (restoreFilePath) {
              try {
                await restorePresentationState(restoreFilePath, restoreSlideId)
              } catch (restoreError) {
                console.error(
                  'Failed to restore previous presentation after switch error:',
                  restoreError
                )
              }
            }
            throw error
          }
        },
        deleteTempPresentation: (filePath) => window.api.db.deleteTemp(filePath),
        onDeleteTempFailure: (filePath, error) => {
          console.error(`Failed to delete abandoned temp file ${filePath}:`, error)
        }
      })
    )
  }

  async function handleCloseRequest(): Promise<boolean> {
    return withPresentationTransitionLock(() =>
      closePresentationWithTempGuard({
        currentFilePath: appState.currentFilePath,
        isTempFile: appState.isTempFile,
        flushPendingSave,
        isBootstrapPresentation: (filePath) => window.api.db.isBootstrapPresentation(filePath),
        promptToAbandonTemp: promptToAbandonTempPresentation,
        saveTempPresentation: saveCurrentPresentationAs,
        cancelPendingPersistence,
        deleteTempPresentation: (filePath) => window.api.db.deleteTemp(filePath),
        promptToForceCloseOnError: promptToForceCloseAfterFailure,
        onClosePreparationFailure: (error) => {
          console.error('Failed to resolve close request:', error)
        },
        onDeleteTempFailure: (filePath, error) => {
          console.error(`Failed to delete temp file during close for ${filePath}:`, error)
        }
      })
    )
  }

  /**
   * Creates a new, unsaved presentation with one blank slide in a temp database.
   */
  async function createNewPresentationInternal(): Promise<boolean> {
    loadingScreenPhase = 'creating'
    let retryCount = 0
    const maxRetries = 3
    let userInitiatedRetries = 0
    const maxUserRetries = 2 // Cap user-initiated retries to prevent infinite loops

    while (retryCount < maxRetries) {
      let tempPath: string | null = null

      try {
        clearAllHistory()

        // Clear current slide to prevent any accidental saves to new database
        appState.currentSlide = null
        appState.currentSlideIndex = -1
        imageElementCache.clear()
        prefetchedSlideIds.clear()

        // Close any existing database connection
        if (appState.currentFilePath) {
          await window.api.db.closeConnection(appState.currentFilePath)
        }

        // Create a new temp database
        tempPath = await window.api.db.createTemp()

        // Create the first slide in the temp database
        const newSlide = await window.api.db.createSlide(tempPath)

        // Update state
        appState.currentFilePath = tempPath
        appState.isTempFile = true
        appState.slideIds = [newSlide.id]
        appState.currentSlide = newSlide
        appState.currentSlideIndex = 0
        appState.selectedObjectId = null

        console.log('Created new presentation with temp database:', tempPath)
        setSaveStatus('saved')
        return true
      } catch (error) {
        console.error(
          `Failed to create new presentation (attempt ${retryCount + 1}/${maxRetries}):`,
          error
        )

        // Clean up the temp file if it was created
        if (tempPath) {
          try {
            await window.api.db.deleteTemp(tempPath)
            console.log(`Cleaned up failed temp file: ${tempPath}`)
          } catch (cleanupError) {
            console.error('Failed to clean up temp file:', cleanupError)
            // If cleanup fails, the file will be cleaned up by the 24-hour orphan cleanup
            // This is non-fatal, so we continue with the retry
          }
        }

        retryCount++

        if (retryCount >= maxRetries) {
          // All retries failed - show error and offer recovery
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          const retry = confirm(
            `Failed to create new presentation after ${maxRetries} attempts: ${errorMessage}\n\n` +
              'This might be due to:\n' +
              '• Insufficient disk space\n' +
              '• Permission issues\n' +
              '• Corrupted temp directory\n\n' +
              'Would you like to try again?'
          )

          if (retry) {
            // Cap user-initiated retries to prevent infinite looping
            userInitiatedRetries++
            if (userInitiatedRetries > maxUserRetries) {
              alert(
                'Unable to create a new presentation after multiple attempts. ' +
                  'Please check your system resources and try again later.'
              )
              return false
            }
            retryCount = 0 // Reset and try again
          } else {
            // User gave up - leave them with current state (if any)
            return false
          }
        } else {
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, NEW_PRESENTATION_RETRY_DELAY_MS))
        }
      }
    }

    return false
  }

  /**
   * Creates a new, unsaved presentation with one blank slide in a temp database.
   * Checks for temp presentation destruction before proceeding.
   */
  async function handleNewPresentation(): Promise<void> {
    try {
      await runGuardedPresentationTransition(async () => ({
        completed: await createNewPresentationInternal(),
        mutatedState: true
      }))
    } catch (error) {
      console.error('Failed to create new presentation:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to create new presentation: ${errorMessage}`)
    }
  }

  /**
   * Opens a file dialog and loads the selected presentation.
   * Checks for temp presentation destruction before proceeding.
   */
  async function handleOpen(): Promise<void> {
    try {
      await runGuardedPresentationTransition(async () => {
        const filePath = await window.api.dialog.showOpenDialog()
        if (!filePath) {
          return { completed: false, mutatedState: false }
        }

        await openPresentationAtPath(filePath)
        return { completed: true, mutatedState: true }
      })
    } catch (error) {
      console.error('Failed to open presentation:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to open presentation: ${errorMessage}`)
    }
  }

  /**
   * Saves the current slide to the existing file.
   * If this is a temp file, triggers Save As instead.
   * Uses promise lock to prevent concurrent save operations.
   */
  async function handleSave(): Promise<void> {
    // If this is a temp file (unsaved presentation), delegate to Save As
    if (appState.isTempFile) {
      await saveCurrentPresentationAs()
      return
    }

    // Flush any pending auto-save immediately
    await flushPendingSave()
    console.log('Saved to', appState.currentFilePath)
  }

  /**
   * Opens a save dialog and saves the presentation to a new file.
   * For temp files, moves the database. For saved files, copies the database.
   * Prevents concurrent save operations using promise lock.
   */
  async function saveCurrentPresentationAs(): Promise<boolean> {
    // Save original state in case we need to recover from an error
    const originalFilePath = appState.currentFilePath
    const originalSlideId = appState.currentSlide?.id

    try {
      if (!appState.currentFilePath) {
        throw new Error('No current file path')
      }

      cancelPendingPersistence()

      // Save current slide to database first to flush all edits
      await performSave(true)

      // Show save dialog
      const newPath = await window.api.dialog.showSaveDialog()
      if (!newPath) return false

      // Remember which slide we're currently viewing so we can restore it
      const currentSlideId = appState.currentSlide?.id

      // Move or copy the database depending on whether it's a temp file
      let resultPath: string
      if (appState.isTempFile) {
        // For temp files, move the database to the new location
        resultPath = await window.api.db.saveToLocation(appState.currentFilePath, newPath)
      } else {
        // For saved files, copy the database to the new location
        resultPath = await window.api.db.copyToLocation(appState.currentFilePath, newPath)
      }

      // Update state
      appState.currentFilePath = resultPath
      appState.isTempFile = false

      // Reload slide IDs from the new file
      const ids = await window.api.db.getSlideIds(resultPath)
      appState.slideIds = ids

      // Restore the slide the user was viewing
      if (currentSlideId && appState.slideIds.includes(currentSlideId)) {
        try {
          await loadSlide(currentSlideId)
        } catch (slideLoadError) {
          console.error('Failed to restore original slide:', slideLoadError)
          // Not critical - load the first slide instead
          if (ids.length > 0) {
            await loadSlide(ids[0])
          }
        }
      }

      console.log(`Saved presentation to ${resultPath}`)
      return true
    } catch (error) {
      console.error('Save As operation failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      alert(`Failed to save presentation: ${errorMessage}`)

      // Try to recover original state if we changed files
      if (originalFilePath && appState.currentFilePath !== originalFilePath) {
        try {
          loadingScreenPhase = 'opening'
          await loadPresentation(originalFilePath)
          if (originalSlideId) {
            await loadSlide(originalSlideId)
          }
        } catch (recoveryError) {
          console.error('Failed to recover original state:', recoveryError)
        }
      }

      return false
    }
  }

  async function handleSaveAs(): Promise<void> {
    await saveCurrentPresentationAs()
  }

  /**
   * Keyboard shortcut handler for Cmd/Ctrl+S (Save)
   */
  keys.onKeys(['meta', 's'], async () => {
    await handleSave()
  })

  // ============================================================================
  // Font Management
  // ============================================================================

  /**
   * Loads system fonts and initializes the available fonts list.
   * Called once on mount.
   */
  /**
   * Determines if a font should be excluded from the user-facing font list.
   * Based on common patterns used by professional software like LibreOffice.
   */
  function shouldExcludeFont(family: string): boolean {
    // Filter out private system fonts (starting with .)
    if (family.startsWith('.')) return true

    // Filter out Noto variants for specialized scripts
    // Keep base "Noto Sans" and "Noto Serif" (without space after)
    if (family.startsWith('Noto Sans ') || family.startsWith('Noto Serif ')) return true

    // Filter out STIX math symbol variants
    // Keep only main STIX Two variants
    if (family.startsWith('STIX') && !['STIX Two Math', 'STIX Two Text'].includes(family))
      return true

    // Symbol and dingbat fonts (cross-platform)
    const symbolFonts = [
      'Webdings',
      'Wingdings',
      'Wingdings 2',
      'Wingdings 3',
      'Zapf Dingbats',
      'Symbol',
      'Apple Symbols',
      'Apple Braille',
      'OpenSymbol',
      'Standard Symbols'
    ]
    if (symbolFonts.includes(family)) return true

    // Ornamental and decorative variants
    if (family.includes('Ornaments')) return true
    if (family.includes('Dingbats')) return true

    // Bitmap fonts (often low quality)
    if (family.includes('Bitmap')) return true

    // Filter out font variants that are for internal use
    if (family.includes('UI Font')) return true
    if (family.includes('System Font')) return true

    return false
  }

  async function loadSystemFonts(): Promise<void> {
    try {
      systemFonts = await window.api.fonts.getSystemFonts()
      // Extract unique font families, filtering out unwanted fonts
      const families = Array.from(new Set(systemFonts.map((f) => f.family))).filter(
        (family) => !shouldExcludeFont(family)
      )
      availableFonts = [...new Set([...availableFonts, ...families])].sort()
      console.log(
        `Loaded ${families.length} system fonts (${systemFonts.length - families.length} filtered out)`
      )
    } catch (error) {
      console.error('Failed to load system fonts:', error)
      // Continue with default fonts
    }
  }

  /**
   * Loads embedded fonts from the database and injects them via CSS @font-face.
   * Should be called after opening a presentation file.
   */
  async function loadEmbeddedFonts(): Promise<void> {
    if (!appState.currentFilePath) return

    try {
      const embeddedFonts = await window.api.fonts.getEmbeddedFonts(appState.currentFilePath)

      // Get unique font families from embedded fonts
      const embeddedFamilies = Array.from(new Set(embeddedFonts.map((f) => f.fontFamily)))

      // Add embedded fonts to available fonts list if not already present
      for (const family of embeddedFamilies) {
        if (!availableFonts.includes(family)) {
          availableFonts = [...availableFonts, family].sort()
        }
      }

      // Inject the fonts into the page
      for (const font of embeddedFonts) {
        await injectFontFace(font.fontFamily, font.fontData, font.format, font.variant)
      }

      if (document?.fonts?.ready) {
        await document.fonts.ready
      }

      if (embeddedFonts.length > 0) {
        console.log(
          `Loaded ${embeddedFonts.length} embedded fonts from presentation (${embeddedFamilies.length} families)`
        )
        refreshTextRendering()
      }
    } catch (error) {
      console.error('Failed to load embedded fonts:', error)
    }
  }

  function refreshTextRendering(): void {
    if (!fabCanvas) return
    fabCanvas.getObjects().forEach((obj) => {
      if (obj instanceof Textbox) {
        obj.dirty = true
        obj.initDimensions()
      }
    })
    fabCanvas.requestRenderAll()
  }

  async function ensureFontReady(fontFamily: string, weight: string, style: string): Promise<void> {
    if (!document?.fonts?.load) return

    const normalizedStyle = style === 'italic' ? 'italic' : 'normal'
    const normalizedWeight = weight === 'bold' ? 'bold' : 'normal'

    try {
      await document.fonts.load(`${normalizedStyle} ${normalizedWeight} 16px '${fontFamily}'`)
    } catch (error) {
      console.warn(`Failed to load font via FontFaceSet: ${fontFamily}`, error)
    }
  }

  /**
   * Injects a font into the page using CSS @font-face.
   *
   * @param fontFamily - The font family name
   * @param fontData - Binary font data as Buffer
   * @param format - Font format (ttf, otf, woff, woff2)
   * @param variant - Font variant (e.g., "normal-normal", "bold-italic")
   */
  async function injectFontFace(
    fontFamily: string,
    fontData: Buffer,
    format: string,
    variant: string = 'normal-normal'
  ): Promise<void> {
    const key = `${fontFamily}-${variant}`
    if (loadedFonts.has(key)) {
      return // Already loaded
    }

    try {
      // Convert Buffer to base64 for data URI
      const base64 = fontDataToBase64(fontData)

      // Determine font format for @font-face
      const normalizedFormat = format === 'ttc' ? 'ttf' : format
      let fontFormat = normalizedFormat
      if (normalizedFormat === 'ttf') fontFormat = 'truetype'
      else if (normalizedFormat === 'otf') fontFormat = 'opentype'

      // Parse variant to get weight and style
      const [weight, style] = variant.split('-')

      // Create @font-face CSS rule
      const fontFaceRule = `
        @font-face {
          font-family: '${fontFamily}';
          src: url(data:font/${normalizedFormat};base64,${base64}) format('${fontFormat}');
          font-weight: ${weight};
          font-style: ${style};
        }
      `

      // Inject into document
      const styleEl = document.createElement('style')
      styleEl.textContent = fontFaceRule
      document.head.appendChild(styleEl)

      loadedFonts.add(key)
      await ensureFontReady(fontFamily, weight, style)
      cache.clearFontCache(fontFamily)
      console.log(`Injected font: ${fontFamily} (${variant})`)
    } catch (error) {
      console.error(`Failed to inject font ${fontFamily}:`, error)
    }
  }

  /**
   * List of web-safe fonts that are available in browsers by default.
   * These fonts don't need to be embedded or loaded via @font-face.
   */
  const WEB_SAFE_FONTS = [
    'Arial',
    'Helvetica',
    'Times New Roman',
    'Times',
    'Courier New',
    'Courier',
    'Verdana',
    'Georgia',
    'Palatino',
    'Garamond',
    'Bookman',
    'Comic Sans MS',
    'Trebuchet MS',
    'Impact'
  ]

  /**
   * Embeds a font file into the database.
   * Called when a user selects a font that hasn't been embedded yet.
   *
   * @param fontFamily - The font family name to embed
   */
  async function embedFontIfNeeded(fontFamily: string): Promise<void> {
    // Skip embedding for web-safe fonts that are already available in browsers
    if (WEB_SAFE_FONTS.includes(fontFamily)) {
      console.log(`Skipping embed for web-safe font: ${fontFamily}`)
      return
    }

    // All presentations now have a currentFilePath (can be temp or saved)
    // If this check fails, it indicates a programming error
    if (!appState.currentFilePath) {
      throw new Error('Invariant violation: no currentFilePath when embedding font')
    }

    try {
      // Check if font is already embedded
      const existingFont = await window.api.fonts.getFontData(
        appState.currentFilePath,
        fontFamily,
        'normal-normal'
      )

      if (existingFont) {
        return // Already embedded
      }

      // Find the system font
      const systemFont = systemFonts.find((f) => f.family === fontFamily)
      if (!systemFont) {
        console.warn(`Font ${fontFamily} not found in system fonts`)
        return
      }

      // Embed the font
      await window.api.fonts.embedFont(
        appState.currentFilePath,
        systemFont.path,
        fontFamily,
        'normal-normal'
      )

      // Load the embedded font
      const fontData = await window.api.fonts.getFontData(
        appState.currentFilePath,
        fontFamily,
        'normal-normal'
      )

      if (fontData) {
        await injectFontFace(
          fontData.fontFamily,
          fontData.fontData,
          fontData.format,
          fontData.variant
        )
        console.log(`Embedded and loaded font: ${fontFamily}`)
      }
    } catch (error) {
      console.error(`Failed to embed font ${fontFamily}:`, error)
    }
  }

  /**
   * Loads a system font for preview in the font dropdown (without embedding in DB).
   *
   * @param fontFamily - The font family name to load for preview
   */
  async function loadFontForPreview(fontFamily: string): Promise<void> {
    // Skip loading for web-safe fonts that are already available in browsers
    if (WEB_SAFE_FONTS.includes(fontFamily)) {
      return
    }

    const key = `${fontFamily}-normal-normal`
    if (loadedFonts.has(key)) {
      return // Already loaded
    }

    try {
      // Find the system font
      const systemFont = systemFonts.find((f) => f.family === fontFamily)
      if (!systemFont) {
        return // Font not found
      }

      // Load font data directly from system path
      const fontData = await window.api.fonts.loadFontFile(systemFont.path)
      if (fontData) {
        await injectFontFace(fontFamily, fontData, systemFont.format, 'normal-normal')
      }
    } catch (error) {
      console.error(`Failed to load font for preview ${fontFamily}:`, error)
    }
  }

  /**
   * Queues a font for lazy loading and processes the queue in batches
   */
  function queueFontForLoading(fontFamily: string): void {
    fontLoadingQueue.add(fontFamily)
    processFontQueue()
  }

  /**
   * Processes the font loading queue in batches to avoid blocking the UI
   */
  async function processFontQueue(): Promise<void> {
    if (isLoadingFonts || fontLoadingQueue.size === 0) {
      return
    }

    isLoadingFonts = true

    // Process in small batches with breaks between
    const batch = Array.from(fontLoadingQueue).slice(0, 5)
    fontLoadingQueue = new SvelteSet(Array.from(fontLoadingQueue).slice(5))

    for (const font of batch) {
      await loadFontForPreview(font)
      // Small delay to prevent blocking the UI
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    isLoadingFonts = false

    // Continue processing if there are more fonts
    if (fontLoadingQueue.size > 0) {
      setTimeout(() => processFontQueue(), 50)
    }
  }

  /**
   * Toggles the custom font dropdown open/closed
   */
  function toggleFontDropdown(): void {
    fontDropdownOpen = !fontDropdownOpen
    if (fontDropdownOpen) {
      if (activeTextObject) {
        suppressSelectionTracking = true
        lastTextSelectionRange = {
          start: activeTextObject.selectionStart ?? 0,
          end: activeTextObject.selectionEnd ?? 0
        }
        const restoreStart = lastTextSelectionRange.start
        const restoreEnd = lastTextSelectionRange.end

        setTimeout(() => {
          if (!activeTextObject) {
            suppressSelectionTracking = false
            return
          }
          if (wasEditing || activeTextObject.isEditing) {
            activeTextObject.enterEditing()
          }
          activeTextObject.setSelectionStart(restoreStart)
          activeTextObject.setSelectionEnd(restoreEnd)
          fabCanvas?.requestRenderAll()
          suppressSelectionTracking = false
        }, 0)
      }
      fontSearchQuery = ''
      // Load the currently selected font and a few common ones
      if (selectionFontFamily !== 'Multiple') {
        queueFontForLoading(selectionFontFamily)
      }
      const commonFonts = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Verdana']
      commonFonts.forEach((font) => queueFontForLoading(font))
    } else {
      suppressSelectionTracking = false
    }
  }

  /**
   * Selects a font from the custom dropdown
   */
  async function selectFontFromDropdown(fontFamily: string): Promise<void> {
    fontDropdownOpen = false
    selectionFontFamily = fontFamily

    if (!activeTextObject) return

    // Embed the font if needed
    await embedFontIfNeeded(fontFamily)

    // Apply to selection
    applyStyleToSelection({ fontFamily })
    // Note: Do NOT call updateStateFromObject() here - it would re-render and lose cursor
  }

  // ============================================================================
  // Slide and Element Creation
  // ============================================================================

  /**
   * Adds a new text element to the current slide at a default position.
   */
  function nextZIndex(): number {
    if (!appState.currentSlide || appState.currentSlide.elements.length === 0) return 0
    return appState.currentSlide.elements.reduce((m, e) => Math.max(m, e.zIndex), -Infinity) + 1
  }

  function addText(): void {
    if (!appState.currentSlide) return
    pushCheckpoint()
    const newText: TwigElement = {
      type: 'text',
      id: `text_${uuid_v4()}`,
      x: 250,
      y: 150,
      width: 200,
      height: 50,
      angle: 0,
      text: 'Double-click to edit',
      fontSize: 40,
      fontFamily: 'Arial',
      fontWeight: 'normal',
      fontStyle: 'normal',
      underline: false,
      fill: '#333333',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(newText)
    scheduleSave()
  }

  /**
   * Adds a new rectangle element to the current slide at a default position.
   */
  function addRectangle(): void {
    if (!appState.currentSlide) return
    pushCheckpoint()
    const newRect: TwigElement = {
      type: 'rect',
      id: `rect_${uuid_v4()}`,
      x: 100,
      y: 100,
      width: 150,
      height: 100,
      angle: 0,
      fill: '#FF6F61',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(newRect)
    scheduleSave()
  }

  function addEllipse(): void {
    if (!appState.currentSlide) return
    pushCheckpoint()
    const el: TwigElement = {
      type: 'ellipse',
      id: `ellipse_${uuid_v4()}`,
      x: 100,
      y: 100,
      width: 150,
      height: 150,
      angle: 0,
      fill: '#FF6F61',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(el)
    scheduleSave()
  }

  function addTriangle(): void {
    if (!appState.currentSlide) return
    pushCheckpoint()
    const el: TwigElement = {
      type: 'triangle',
      id: `triangle_${uuid_v4()}`,
      x: 100,
      y: 100,
      width: 150,
      height: 130,
      angle: 0,
      fill: '#FF6F61',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(el)
    scheduleSave()
  }

  function addStar(): void {
    if (!appState.currentSlide) return
    pushCheckpoint()
    const el: TwigElement = {
      type: 'star',
      id: `star_${uuid_v4()}`,
      x: 100,
      y: 100,
      width: 150,
      height: 150,
      angle: 0,
      fill: '#FF6F61',
      zIndex: nextZIndex()
    }
    appState.currentSlide.elements.push(el)
    scheduleSave()
  }

  function addArrow(): void {
    if (!appState.currentSlide) return
    pushCheckpoint()
    const el: TwigElement = {
      type: 'arrow',
      id: `arrow_${uuid_v4()}`,
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      angle: 0,
      fill: '#FF6F61',
      zIndex: nextZIndex(),
      arrowShape: { ...DEFAULT_ARROW_SHAPE }
    }
    appState.currentSlide.elements.push(el)
    scheduleSave()
  }

  /**
   * Opens an image file dialog and adds the selected image to the current slide.
   * The image is loaded as a base64 data URI and stored in the slide data.
   */
  async function addImage(): Promise<void> {
    if (!appState.currentSlide) return

    try {
      const imageData = await window.api.dialog.showImageDialog()

      if (!imageData) {
        return // User cancelled
      }

      // Create a temporary image element to get the natural dimensions
      const tempImg = new Image()
      tempImg.src = imageData.src

      await new Promise<void>((resolve, reject) => {
        tempImg.onload = () => resolve()
        tempImg.onerror = () => reject(new Error('Failed to load image'))
      })

      // Calculate default size (max 400px while maintaining aspect ratio)
      const maxSize = 400
      let width = tempImg.naturalWidth
      let height = tempImg.naturalHeight

      // SVGs often report naturalWidth/naturalHeight as 0 when they only have a viewBox.
      // Fall back to parsing the SVG XML for dimensions.
      if ((width === 0 || height === 0) && imageData.src.includes('image/svg')) {
        try {
          const svgContent = atob(imageData.src.split(',')[1])
          const parser = new DOMParser()
          const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml')
          const svgEl = svgDoc.documentElement
          const svgW = parseFloat(svgEl.getAttribute('width') ?? '0')
          const svgH = parseFloat(svgEl.getAttribute('height') ?? '0')
          if (svgW > 0 && svgH > 0) {
            width = svgW
            height = svgH
          } else {
            const viewBox = svgEl.getAttribute('viewBox')
            if (viewBox) {
              const parts = viewBox.trim().split(/[\s,]+/)
              if (parts.length === 4) {
                width = parseFloat(parts[2])
                height = parseFloat(parts[3])
              }
            }
          }
        } catch {
          // ignore parsing errors
        }
        // Final fallback
        if (width === 0 || height === 0) {
          width = 400
          height = 300
        }
      }

      if (width > maxSize || height > maxSize) {
        const aspectRatio = width / height
        if (width > height) {
          width = maxSize
          height = maxSize / aspectRatio
        } else {
          height = maxSize
          width = maxSize * aspectRatio
        }
      }

      // Rasterize SVGs to PNG so fabric.js always gets a bitmap with concrete
      // naturalWidth/naturalHeight. SVGs with %-based or missing dimensions have
      // naturalWidth=0, which causes fabric's 9-arg drawImage to draw nothing.
      let src = imageData.src
      if (imageData.src.includes('image/svg')) {
        const rasterCanvas = document.createElement('canvas')
        rasterCanvas.width = width
        rasterCanvas.height = height
        rasterCanvas.getContext('2d')?.drawImage(tempImg, 0, 0, width, height)
        src = rasterCanvas.toDataURL('image/png')
      }

      // Create the image element
      const newImage: TwigElement = {
        type: 'image',
        id: `image_${uuid_v4()}`,
        x: 480, // Center of 960px canvas
        y: 270, // Center of 540px canvas
        width: width,
        height: height,
        angle: 0,
        src,
        filename: imageData.filename,
        zIndex: nextZIndex()
      }

      pushCheckpoint()
      imageAssets.set(newImage.id, newImage.src!)
      appState.currentSlide.elements.push(newImage)
      scheduleSave()
    } catch (error) {
      console.error('Failed to add image:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to add image: ${errorMessage}`)
    }
  }

  /**
   * Creates a new blank slide and adds it to the presentation.
   * Handles both saved (file-based) and unsaved (in-memory) presentations.
   */
  async function addNewSlide(): Promise<void> {
    if (!appState.currentFilePath) {
      console.error('Cannot add slide: no current file path')
      return
    }

    let newSlideId: string | null = null
    try {
      // Create new slide in the database (works for both temp and saved files)
      const newSlide = await window.api.db.createSlide(appState.currentFilePath)
      newSlideId = newSlide.id

      // Apply default background if one is set.
      // Use $state.snapshot() to strip the Svelte 5 reactive Proxy before
      // sending over IPC — structured clone cannot handle Proxy objects.
      if (defaultSlideBackground) {
        newSlide.background = $state.snapshot(defaultSlideBackground) as SlideBackground
        await window.api.db.saveSlide(appState.currentFilePath, newSlide)
      }

      // Update slideIds
      appState.slideIds = [...appState.slideIds, newSlide.id]

      // Load the new slide
      await loadSlide(newSlide.id)
    } catch (error) {
      console.error('Failed to create new slide:', error)

      // Roll back slideIds if it was added but loading failed
      if (newSlideId) {
        appState.slideIds = appState.slideIds.filter((id) => id !== newSlideId)
      }

      // Show user-friendly error message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      alert(`Failed to create new slide: ${errorMessage}`)
    }
  }

  /**
   * Flush any pending save for the current slide then navigate to the target slide.
   * Captures the current canvas as a bitmap overlay before switching to avoid blank-canvas flicker.
   */
  async function handleSlideSelect(slideId: string): Promise<void> {
    if (slideId === appState.currentSlide?.id) return

    // Capture BEFORE any async work (sync, so canvas is still showing old slide)
    const snapshot = captureCanvasSnapshot(0.85)

    try {
      const prevId = appState.currentSlide?.id
      if (snapshot) slideTransitionOverlaySrc = snapshot
      await loadSlide(slideId) // loadSlide flushes pending saves internally
      // If loadSlide aborted without changing slides, clear overlay immediately
      if (appState.currentSlide?.id === prevId) {
        slideTransitionOverlaySrc = null
      }
    } catch (err) {
      slideTransitionOverlaySrc = null
      throw err
    }
  }

  /**
   * Deletes a slide by ID. Navigates to an adjacent slide if the current one is deleted.
   * No-ops if this is the last slide.
   */
  async function deleteSlideById(slideId: string): Promise<void> {
    if (appState.isPresentingMode) return
    if (appState.slideIds.length <= 1) return
    const filePath = appState.currentFilePath
    if (!filePath) return

    await flushPendingSave()

    const slideIds = [...appState.slideIds]
    const deleteIndex = slideIds.indexOf(slideId)
    if (deleteIndex === -1) return

    const isDeletingCurrent = slideId === appState.currentSlide?.id
    let nextSlideId: string | null = null
    if (isDeletingCurrent) {
      nextSlideId = deleteIndex > 0 ? slideIds[deleteIndex - 1] : slideIds[deleteIndex + 1]
    }

    // Optimistic state update — save rollback values before mutating
    const savedHistory = historyBySlideId.get(slideId)
    const newSlideIds = slideIds.filter((id) => id !== slideId)
    appState.slideIds = newSlideIds
    const remainingThumbnails = Object.fromEntries(
      Object.entries(appState.thumbnails).filter(([id]) => id !== slideId)
    )
    appState.thumbnails = remainingThumbnails
    historyBySlideId.delete(slideId)
    historyRevision++

    if (isDeletingCurrent && nextSlideId) {
      await loadSlide(nextSlideId)
    } else {
      appState.currentSlideIndex = newSlideIds.indexOf(appState.currentSlide?.id ?? '')
    }

    try {
      await window.api.db.deleteSlide(filePath, slideId)
    } catch (error) {
      console.error('Failed to delete slide:', error)
      // Rollback by reloading from DB
      const ids = await window.api.db.getSlideIds(filePath)
      appState.slideIds = ids
      appState.thumbnails = await window.api.db.getThumbnails(filePath)
      appState.currentSlideIndex = ids.indexOf(appState.currentSlide?.id ?? '')
      if (savedHistory) historyBySlideId.set(slideId, savedHistory)
      if (isDeletingCurrent) await loadSlide(slideId)
    }
  }

  /**
   * Reorders slides to match newOrderIds. Optimistically updates state and persists to DB.
   */
  async function handleSlideReorder(newOrderIds: string[]): Promise<void> {
    if (appState.isPresentingMode) return
    const filePath = appState.currentFilePath
    if (!filePath) return

    const previousIds = [...appState.slideIds]
    appState.slideIds = newOrderIds
    appState.currentSlideIndex = newOrderIds.indexOf(appState.currentSlide?.id ?? '')

    try {
      await window.api.db.reorderSlides(filePath, newOrderIds)
    } catch (error) {
      console.error('Failed to reorder slides:', error)
      appState.slideIds = previousIds
      appState.currentSlideIndex = previousIds.indexOf(appState.currentSlide?.id ?? '')
    }
  }

  function onSlideDragStart(e: DragEvent, id: string): void {
    if (!e.dataTransfer) return
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    slideDragSourceId = id
  }

  function onSlideDragOver(e: DragEvent, id: string): void {
    e.preventDefault()
    if (!e.dataTransfer || id === slideDragSourceId) return
    e.dataTransfer.dropEffect = 'move'
    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    slideDragOverId = id
    slideDragOverPosition = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function onSlideDragLeave(e: DragEvent): void {
    const target = e.currentTarget as HTMLElement
    if (target.contains(e.relatedTarget as Node)) return
    slideDragOverId = null
  }

  function onSlideDrop(e: DragEvent, targetId: string): void {
    e.preventDefault()
    const sourceId = slideDragSourceId
    const dropPosition = slideDragOverPosition
    slideDragSourceId = null
    slideDragOverId = null
    if (!sourceId || sourceId === targetId || loadingState.isLoadingSlide) return

    const newIds = [...appState.slideIds]
    const sourceIndex = newIds.indexOf(sourceId)
    if (sourceIndex === -1) return
    newIds.splice(sourceIndex, 1)

    const newTargetIndex = newIds.indexOf(targetId)
    if (newTargetIndex === -1) return
    const insertAt = dropPosition === 'before' ? newTargetIndex : newTargetIndex + 1
    newIds.splice(insertAt, 0, sourceId)

    handleSlideReorder(newIds)
  }

  function onSlideDragEnd(): void {
    slideDragSourceId = null
    slideDragOverId = null
    slideDragOverPosition = 'before'
  }

  /**
   * Deletes the currently selected object(s) from the canvas and state.
   * Supports deleting multiple objects when a multi-selection is active.
   */
  function deleteSelectedObject(): void {
    if (!fabCanvas || !appState.currentSlide) return

    const activeObjects = fabCanvas.getActiveObjects()
    if (activeObjects.length === 0) return

    // Collect IDs of objects to delete
    const idsToDelete = activeObjects.map((obj) => (obj as TwigFabricObject).id).filter((id) => id)

    if (idsToDelete.length > 0) {
      pushCheckpoint()
      // Remove elements from state
      appState.currentSlide.elements = appState.currentSlide.elements.filter(
        (el) => !idsToDelete.includes(el.id)
      )
      // Prune animation steps for deleted elements
      appState.currentSlide.animationOrder = normalizeAnimationOrder(appState.currentSlide)
      // Clear the canvas selection
      fabCanvas.discardActiveObject()
      scheduleSave()
    }
  }

  // ============================================================================
  // Layer Reorder Helpers (used by StackPanel and ContextMenu)
  // ============================================================================

  /**
   * Compact all element zIndex values to sequential integers 0..n-1 after any
   * reorder operation. Mutates elements in-place on appState. Keeps DB values clean.
   */
  function compactZIndexes(): void {
    if (!appState.currentSlide) return
    const sorted = [...appState.currentSlide.elements].sort((a, b) => a.zIndex - b.zIndex)
    sorted.forEach((el, i) => {
      el.zIndex = i
    })
  }

  /**
   * Reorders existing canvas objects to match the current zIndex values in state
   * without clearing or reloading the canvas. Used by all layer reorder operations
   * (buttons and drag) to avoid triggering async image reloads and flicker.
   *
   * All objects are already on the canvas when this runs, so selection restore is
   * synchronous — no Promise needed and no generation guard required.
   */
  function applyZOrderToCanvas(): void {
    if (!fabCanvas || !appState.currentSlide) return
    const sorted = [...appState.currentSlide.elements].sort((a, b) => a.zIndex - b.zIndex)
    const objs = fabCanvas.getObjects() as TwigFabricObject[]
    sorted.forEach((el, targetIndex) => {
      const obj = objs.find((o) => o.id === el.id)
      if (obj) fabCanvas.moveObjectTo(obj, targetIndex)
    })
    const savedId = appState.selectedObjectId
    if (savedId) {
      const obj = (fabCanvas.getObjects() as TwigFabricObject[]).find((o) => o.id === savedId)
      if (obj) fabCanvas.setActiveObject(obj)
    }
    fabCanvas.requestRenderAll()
  }

  function layerBringToFront(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    pushCheckpoint()
    const max = appState.currentSlide.elements.reduce((m, e) => Math.max(m, e.zIndex), -Infinity)
    el.zIndex = max + 1
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  function layerSendToBack(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    pushCheckpoint()
    const min = appState.currentSlide.elements.reduce((m, e) => Math.min(m, e.zIndex), Infinity)
    el.zIndex = min - 1
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  function layerMoveUp(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    const above = appState.currentSlide.elements
      .filter((e) => e.zIndex > el.zIndex)
      .sort((a, b) => a.zIndex - b.zIndex)[0]
    if (!above) return
    pushCheckpoint()
    ;[el.zIndex, above.zIndex] = [above.zIndex, el.zIndex]
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  function layerMoveDown(id: string): void {
    if (!appState.currentSlide) return
    const el = appState.currentSlide.elements.find((e) => e.id === id)
    if (!el) return
    const below = appState.currentSlide.elements
      .filter((e) => e.zIndex < el.zIndex)
      .sort((a, b) => b.zIndex - a.zIndex)[0]
    if (!below) return
    pushCheckpoint()
    ;[el.zIndex, below.zIndex] = [below.zIndex, el.zIndex]
    compactZIndexes()
    applyZOrderToCanvas()
    scheduleSave()
    scheduleThumbnailCapture()
  }

  // ============================================================================
  // Keyboard and Mouse Event Handlers
  // ============================================================================

  // ============================================================================
  // Copy / Cut / Paste
  // ============================================================================

  function shouldBypassClipboard(event: ClipboardEvent): boolean {
    if (activeTextObject?.isEditing) return true
    const target = event.target as HTMLElement | null
    if (!target) return false
    if (target instanceof HTMLSelectElement) return true
    return isNativeTextTarget(target)
  }

  function handleCopy(event: ClipboardEvent): boolean {
    if (shouldBypassClipboard(event)) return false
    const activeObjects = fabCanvas?.getActiveObjects() ?? []
    if (activeObjects.length === 0) return false
    const ids = new Set(activeObjects.map((o) => (o as TwigFabricObject).id).filter(Boolean))
    const elements = (appState.currentSlide?.elements ?? [])
      .filter((el) => ids.has(el.id))
      .map((el) => ({
        ...el,
        src: el.type === 'image' ? (imageAssets.get(el.id) ?? el.src) : undefined
      }))
    // copyId is an intentional uniqueness nonce: it makes every copy's JSON string
    // distinct so raw !== lastCopiedPayload reliably resets pasteCount even when
    // the same selection is copied again (including from another window).
    const payload = JSON.stringify({ __twig_clipboard__: true, copyId: uuid_v4(), elements })
    event.clipboardData?.setData('text/plain', payload)
    event.preventDefault()
    pasteCount = 0
    lastCopiedPayload = payload
    return true
  }

  function handleCut(event: ClipboardEvent): void {
    if (handleCopy(event)) {
      deleteSelectedObject()
    }
  }

  /** Copies selected elements to the clipboard programmatically (e.g. from context menu). */
  function copySelected(): void {
    const activeObjects = fabCanvas?.getActiveObjects() ?? []
    if (activeObjects.length === 0) return
    const ids = new Set(activeObjects.map((o) => (o as TwigFabricObject).id).filter(Boolean))
    const elements = (appState.currentSlide?.elements ?? [])
      .filter((el) => ids.has(el.id))
      .map((el) => ({
        ...el,
        src: el.type === 'image' ? (imageAssets.get(el.id) ?? el.src) : undefined
      }))
    const payload = JSON.stringify({ __twig_clipboard__: true, copyId: uuid_v4(), elements })
    navigator.clipboard.writeText(payload).catch(() => {})
    pasteCount = 0
    lastCopiedPayload = payload
  }

  /** Cuts selected elements (copy + delete) programmatically (e.g. from context menu). */
  function cutSelected(): void {
    copySelected()
    deleteSelectedObject()
  }

  async function handlePaste(event: ClipboardEvent): Promise<void> {
    console.log('[paste] fired', {
      target: event.target,
      activeTextEditing: activeTextObject?.isEditing
    })
    if (shouldBypassClipboard(event)) {
      console.log(
        '[paste] bypassed — target:',
        event.target,
        'isEditing:',
        activeTextObject?.isEditing
      )
      return
    }

    // --- Twig element clipboard ---
    const raw = event.clipboardData?.getData('text/plain') ?? ''
    console.log(
      '[paste] raw length:',
      raw.length,
      'isTwigPayload:',
      raw.includes('__twig_clipboard__')
    )
    let parsed: { __twig_clipboard__?: boolean; elements?: unknown[] } = {}
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* not JSON */
    }
    if (parsed.__twig_clipboard__ && Array.isArray(parsed.elements) && appState.currentSlide) {
      const validElements = parsed.elements.filter((el): el is TwigElement => {
        if (typeof el !== 'object' || el === null) return false
        const e = el as Record<string, unknown>
        const type = e.type
        if (typeof e.id !== 'string') return false
        if (
          type !== 'rect' &&
          type !== 'ellipse' &&
          type !== 'triangle' &&
          type !== 'star' &&
          type !== 'arrow' &&
          type !== 'text' &&
          type !== 'image'
        )
          return false
        if (typeof e.x !== 'number' || typeof e.y !== 'number') return false
        if (typeof e.width !== 'number' || typeof e.height !== 'number') return false
        if (typeof e.angle !== 'number' || typeof e.zIndex !== 'number') return false
        if (type === 'image' && typeof e.src !== 'string') return false
        return true
      })
      console.log('[paste] validElements:', validElements.length, 'of', parsed.elements?.length)
      if (validElements.length === 0) {
        console.log('[paste] all elements failed validation')
        return
      }
      event.preventDefault()

      if (raw !== lastCopiedPayload) {
        console.log('[paste] new payload detected, resetting pasteCount')
        pasteCount = 0
        lastCopiedPayload = raw
      }
      pasteCount++
      console.log('[paste] pasting', validElements.length, 'elements, pasteCount:', pasteCount)
      const offset = pasteCount * 20
      const baseZ = nextZIndex()

      const CANVAS_W = 960,
        CANVAS_H = 540
      const sortedElements = [...validElements].sort((a, b) => a.zIndex - b.zIndex)
      const newElements: TwigElement[] = sortedElements.map((el, i) => {
        const prefix = el.id.split('_')[0] ?? el.type
        const newId = `${prefix}_${uuid_v4()}`
        if (el.type === 'image' && el.src) imageAssets.set(newId, el.src)
        // Clamp so repeated pastes don't walk elements off canvas
        const x = Math.min(el.x + offset, CANVAS_W - 1)
        const y = Math.min(el.y + offset, CANVAS_H - 1)
        // Pasted elements start with no animation config (new IDs, no stale steps)
        const cloned: TwigElement = {
          ...el,
          id: newId,
          x,
          y,
          zIndex: baseZ + i,
          animations: undefined
        }
        ensureArrowShape(cloned)
        return cloned
      })

      pushCheckpoint()
      appState.currentSlide.elements.push(...newElements)
      pendingSelectionIds = newElements.map((el) => el.id)
      scheduleSave()
      return
    }

    // --- Raw image from clipboard (screenshot, copied image, etc.) ---
    const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) =>
      item.type.startsWith('image/')
    )
    if (!imageItem || !appState.currentSlide) return
    event.preventDefault()

    const blob = imageItem.getAsFile()
    if (!blob) return

    try {
      const src = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })

      const tempImg = new Image()
      tempImg.src = src
      await new Promise<void>((resolve, reject) => {
        tempImg.onload = () => resolve()
        tempImg.onerror = reject
      })

      // Convert physical pixels → logical pixels, then cap to canvas size
      const dpr = window.devicePixelRatio || 1
      const CANVAS_W = 960,
        CANVAS_H = 540
      let width = Math.round((tempImg.naturalWidth || 200) / dpr)
      let height = Math.round((tempImg.naturalHeight || 200) / dpr)
      const scale = Math.min(1, CANVAS_W / width, CANVAS_H / height)
      width = Math.round(width * scale)
      height = Math.round(height * scale)

      const newImage: TwigElement = {
        type: 'image',
        id: `image_${uuid_v4()}`,
        x: 480, // Center of 960px canvas
        y: 270, // Center of 540px canvas
        width,
        height,
        angle: 0,
        src,
        zIndex: nextZIndex()
      }

      pushCheckpoint()
      imageAssets.set(newImage.id, src)
      appState.currentSlide.elements.push(newImage)
      pendingSelectionIds = [newImage.id]
      scheduleSave()
    } catch (error) {
      console.error('Failed to paste image from clipboard:', error)
    }
  }

  /**
   * Global keyboard event handler for shortcuts.
   * Handles Cmd/Ctrl+A (Select All), Delete/Backspace (Delete object), Cmd/Ctrl+Shift+D (Debug Window), and Cmd/Ctrl+, (Settings).
   */
  function isNativeTextTarget(t: EventTarget | null): boolean {
    if (!t || !(t instanceof HTMLElement)) return false
    return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable
  }

  function handleKeyDown(event: KeyboardEvent): void {
    const nativeTextTarget = isNativeTextTarget(event.target)

    // Cmd/Ctrl+,: Settings
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault()
      settingsOpen = true
      return
    }

    // Cmd/Ctrl+Z: Undo
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      if (!nativeTextTarget && !activeTextObject?.isEditing) {
        event.preventDefault()
        performUndo()
        return
      }
    }

    // Cmd/Ctrl+Shift+Z or Ctrl+Y: Redo
    if (
      ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'z') ||
      (event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'y')
    ) {
      if (!nativeTextTarget && !activeTextObject?.isEditing) {
        event.preventDefault()
        performRedo()
        return
      }
    }

    // Cmd/Ctrl+Shift+D: Open debug window
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      openDebugWindow()
      return
    }

    // Cmd/Ctrl+A: Select all objects on the canvas (unless editing text)
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      // Don't intercept if user is editing text - let them select text normally.
      if (nativeTextTarget || (activeTextObject && activeTextObject.isEditing)) {
        return
      }

      event.preventDefault()
      if (fabCanvas) {
        const allObjects = fabCanvas.getObjects()
        if (allObjects.length > 0) {
          const selection = createActiveSelectionWithLayout(allObjects)
          fabCanvas.setActiveObject(selection)
          fabCanvas.renderAll()
        }
      }
      return
    }

    // Cmd/Ctrl+Backspace: Delete current slide (not while editing text, not last slide)
    if ((event.metaKey || event.ctrlKey) && event.key === 'Backspace') {
      if (!nativeTextTarget && !activeTextObject?.isEditing && appState.currentSlide) {
        event.preventDefault()
        deleteSlideById(appState.currentSlide.id)
        return
      }
    }

    // Delete/Backspace: Delete selected object (but not while editing text)
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Let native form fields handle text deletion/editing themselves.
      if (nativeTextTarget || (activeTextObject && activeTextObject.isEditing)) {
        return
      }
      event.preventDefault()
      deleteSelectedObject()
    }
  }

  /**
   * Handles right-click events on the canvas.
   * Shows a context menu if an object is clicked, hides it otherwise.
   */
  function handleContextMenu(opt: { e: MouseEvent; target?: FabricObject }): void {
    opt.e.preventDefault()
    if (!fabCanvas) return

    if (opt.target) {
      // Object was clicked - select it and show context menu
      if (!fabCanvas.getActiveObjects().includes(opt.target)) {
        fabCanvas.discardActiveObject()
        fabCanvas.setActiveObject(opt.target)
        fabCanvas.requestRenderAll()
      }
      contextMenuPosition = { x: opt.e.clientX, y: opt.e.clientY }
      contextMenuVisible = true
    } else {
      // Empty space was clicked - clear selection and hide menu
      fabCanvas.discardActiveObject()
      fabCanvas.requestRenderAll()
      contextMenuVisible = false
    }
  }

  /**
   * Hides the context menu.
   * Called when clicking anywhere outside the context menu.
   */
  function hideContextMenu(): void {
    contextMenuVisible = false
  }

  // ============================================================================
  // Presentation Mode
  // ============================================================================

  /**
   * Sends the current slide state to the presentation window.
   */
  function sendPresentationState(): void {
    if (!appState.isPresentingMode || !appState.currentSlide) return
    window.api?.presentation?.sendStateUpdate({
      slideId: appState.currentSlide.id,
      slideIndex: appState.currentSlideIndex,
      slideCount: appState.slideIds.length,
      filePath: appState.currentFilePath
    })
  }

  // Keep presentation window in sync whenever the current slide changes
  $effect(() => {
    if (appState.isPresentingMode && appState.currentSlide) {
      sendPresentationState()
    }
  })

  /**
   * Opens the presentation window and begins presenting.
   * isPresentingMode is set to true by the onWindowReady callback once the
   * presentation window has registered its state listener, avoiding a
   * wasted IPC round-trip before the window is ready.
   */
  function enterPresentationMode(): void {
    window.api?.presentation?.openWindow()
    // isPresentingMode is set to true inside onWindowReady (see onMount)
  }

  /**
   * Closes the presentation window and exits presenting.
   */
  function exitPresentationMode(): void {
    window.api?.presentation?.closeWindow()
    appState.isPresentingMode = false
  }

  /**
   * Keyboard shortcut handler for F5 (Start Presentation)
   */
  keys.onKeys(['F5'], (event) => {
    event.preventDefault()
    if (!appState.isPresentingMode) {
      enterPresentationMode()
    }
  })

  /**
   * Keyboard shortcut handler for Cmd/Ctrl+Shift+D (Open Debug Window)
   */
  keys.onKeys(['meta', 'shift', 'd'], () => {
    openDebugWindow()
  })
</script>

<svelte:window
  onkeydown={handleKeyDown}
  onclick={hideContextMenu}
  oncopy={handleCopy}
  oncut={handleCut}
  onpaste={handlePaste}
/>

<SettingsModal bind:open={settingsOpen} />
<TempPresentationGuardModal
  open={tempPresentationGuardOpen}
  onSave={() => resolveTempPresentationGuard('save')}
  onDiscard={() => resolveTempPresentationGuard('discard')}
  onCancel={() => resolveTempPresentationGuard('cancel')}
/>
<CloseFailureModal
  open={closeFailureGuardOpen}
  errorMessage={closeFailureGuardMessage}
  onCloseAnyway={() => resolveCloseFailureGuard(true)}
  onCancel={() => resolveCloseFailureGuard(false)}
/>

{#if appState.currentSlide}
  <div class="flex flex-col h-screen font-sans" role="application">
    {#if contextMenuVisible}
      <ContextMenu
        x={contextMenuPosition.x}
        y={contextMenuPosition.y}
        onCopy={() => {
          copySelected()
          hideContextMenu()
        }}
        onCut={() => {
          cutSelected()
          hideContextMenu()
        }}
        onDelete={() => {
          deleteSelectedObject()
          hideContextMenu()
        }}
        onBringToFront={appState.selectedObjectId
          ? () => {
              layerBringToFront(appState.selectedObjectId!)
              hideContextMenu()
            }
          : undefined}
        onMoveUp={appState.selectedObjectId
          ? () => {
              layerMoveUp(appState.selectedObjectId!)
              hideContextMenu()
            }
          : undefined}
        onMoveDown={appState.selectedObjectId
          ? () => {
              layerMoveDown(appState.selectedObjectId!)
              hideContextMenu()
            }
          : undefined}
        onSendToBack={appState.selectedObjectId
          ? () => {
              layerSendToBack(appState.selectedObjectId!)
              hideContextMenu()
            }
          : undefined}
        isAtFront={selectedIsAtFront}
        isAtBack={selectedIsAtBack}
      />
    {/if}
    <div class="flex items-center px-2 py-1 bg-gray-100 border-b border-gray-300 shadow-sm gap-0.5">
      <!-- Group 1: File -->
      <button
        onclick={handleNewPresentation}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.new')}
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-40-64a8,8,0,0,1-8,8H136v16a8,8,0,0,1-16,0V160H104a8,8,0,0,1,0-16h16V128a8,8,0,0,1,16,0v16h16A8,8,0,0,1,160,152Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.new')}</span>
      </button>
      <button
        onclick={handleOpen}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.open')}
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.open')}</span>
      </button>
      <button
        onclick={handleSave}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.save')}
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M219.31,72,184,36.69A15.86,15.86,0,0,0,172.69,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V83.31A15.86,15.86,0,0,0,219.31,72ZM168,208H88V152h80Zm40,0H184V152a16,16,0,0,0-16-16H88a16,16,0,0,0-16,16v56H48V48H172.69L208,83.31ZM160,72a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h56A8,8,0,0,1,160,72Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.save')}</span>
      </button>
      <button
        onclick={handleSaveAs}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.save_as')}
      >
        <svg
          class="w-5 h-5"
          viewBox="0 0 256 256"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="16"
        >
          <!-- back disk -->
          <g transform="translate(-14,-14) scale(0.89)">
            <path
              d="M216,83.31V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V48a8,8,0,0,1,8-8H172.69a8,8,0,0,1,5.65,2.34l35.32,35.32A8,8,0,0,1,216,83.31Z"
            />
            <path d="M80,216V152a8,8,0,0,1,8-8h80a8,8,0,0,1,8,8v64" />
            <line x1="152" y1="72" x2="96" y2="72" />
          </g>
          <!-- front disk -->
          <g transform="translate(14,14) scale(0.89)">
            <path
              d="M216,83.31V208a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V48a8,8,0,0,1,8-8H172.69a8,8,0,0,1,5.65,2.34l35.32,35.32A8,8,0,0,1,216,83.31Z"
              fill="#f3f4f6"
            />
            <path d="M80,216V152a8,8,0,0,1,8-8h80a8,8,0,0,1,8,8v64" />
            <line x1="152" y1="72" x2="96" y2="72" />
          </g>
        </svg>
        <span class="text-[10px] font-medium leading-none text-gray-500"
          >{$_('toolbar.save_as')}</span
        >
      </button>

      <div class="h-8 w-px bg-gray-300 mx-1"></div>

      <!-- Group 2: Edit -->
      <button
        onclick={performUndo}
        disabled={!canUndo}
        title={$_('toolbar.undo')}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M232,112a64.07,64.07,0,0,1-64,64H51.31l34.35,34.34a8,8,0,0,1-11.32,11.32l-48-48a8,8,0,0,1,0-11.32l48-48a8,8,0,0,1,11.32,11.32L51.31,160H168a48,48,0,0,0,0-96H80a8,8,0,0,1,0-16h88A64.07,64.07,0,0,1,232,112Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.undo')}</span>
      </button>
      <button
        onclick={performRedo}
        disabled={!canRedo}
        title={$_('toolbar.redo')}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M229.66,173.66l-48,48a8,8,0,0,1-11.32-11.32L204.69,176H88A64,64,0,0,1,88,48h88a8,8,0,0,1,0,16H88a48,48,0,0,0,0,96H204.69l-34.35-34.34a8,8,0,0,1,11.32-11.32l48,48A8,8,0,0,1,229.66,173.66Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.redo')}</span>
      </button>

      <!-- Save status indicator -->
      <div class="flex items-center ml-1 mr-1 w-24">
        {#if saveStatus === 'idle' && lastSavedAt !== null}
          <span class="flex items-center gap-1 text-xs text-gray-400">
            <!-- Phosphor FloppyDisk -->
            <svg class="w-3 h-3 shrink-0" viewBox="0 0 256 256" fill="currentColor"
              ><path
                d="M219.31,72,184,36.69A15.86,15.86,0,0,0,172.69,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V83.31A15.86,15.86,0,0,0,219.31,72ZM168,208H88V152h80Zm40,0H184V152a16,16,0,0,0-16-16H88a16,16,0,0,0-16,16v56H48V48H172.69L208,83.31ZM160,72a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h56A8,8,0,0,1,160,72Z"
              /></svg
            >
            {formatRelativeTime(lastSavedAt)}
          </span>
        {:else if saveStatus === 'pending'}
          <span class="flex items-center gap-1 text-xs text-gray-400">
            <!-- Phosphor Circle -->
            <svg class="w-3 h-3" viewBox="0 0 256 256" fill="currentColor"
              ><path
                d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Z"
              /></svg
            >
            {$_('status.unsaved')}
          </span>
        {:else if saveStatus === 'saving'}
          <span class="flex items-center gap-1 text-xs text-blue-500">
            <!-- Phosphor ArrowsClockwise (spin) -->
            <svg class="w-3 h-3 animate-spin" viewBox="0 0 256 256" fill="currentColor"
              ><path
                d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16h28.69L195.64,79A80,80,0,1,0,207.6,193a8,8,0,1,1,11,11.53A96,96,0,1,1,187.07,67.21L204,84.28V56a8,8,0,0,1,16,0Z"
              /></svg
            >
            {$_('status.saving')}
          </span>
        {:else if saveStatus === 'saved'}
          <span class="flex items-center gap-1 text-xs text-green-600">
            <!-- Phosphor CheckCircle -->
            <svg class="w-3 h-3" viewBox="0 0 256 256" fill="currentColor"
              ><path
                d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"
              /></svg
            >
            {$_('status.saved')}
          </span>
        {:else if saveStatus === 'error'}
          <span
            class="flex items-center gap-1 text-xs text-red-500"
            title={$_('status.save_failed')}
          >
            <!-- Phosphor WarningCircle -->
            <svg class="w-3 h-3" viewBox="0 0 256 256" fill="currentColor"
              ><path
                d="M236,128A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-16,0a92,92,0,1,0-92,92A92.1,92.1,0,0,0,220,128Zm-92,36a12,12,0,1,0,12,12A12,12,0,0,0,128,164Zm-8-92v56a8,8,0,0,0,16,0V72a8,8,0,0,0-16,0Z"
              /></svg
            >
            {$_('status.save_failed')}
          </span>
        {/if}
      </div>
      {#if appState.isTempFile}
        <span
          class="flex items-center gap-1 px-2 py-0.5 mr-1 text-xs font-medium text-amber-700 bg-amber-100 border border-amber-300 rounded-md"
          title={$_('status.unsaved_file.title')}
        >
          <!-- Phosphor Warning -->
          <svg class="w-3 h-3" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M236.8,188.09,149.35,36.22a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09Zm-13.86,15.71a8.5,8.5,0,0,1-7.49,4.2H40.55a8.5,8.5,0,0,1-7.49-4.2,7.59,7.59,0,0,1,0-7.72L120.51,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.94,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"
            /></svg
          >
          {$_('status.unsaved')}
        </span>
      {/if}

      <div class="h-8 w-px bg-gray-300 mx-1"></div>

      <!-- Group 3: Present -->
      <button
        onclick={appState.isPresentingMode ? exitPresentationMode : enterPresentationMode}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={appState.isPresentingMode ? $_('toolbar.stop') : $_('toolbar.play')}
      >
        {#if appState.isPresentingMode}
          <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M200,40H56A16,16,0,0,0,40,56V200a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,160H56V56H200V200Z"
            /></svg
          >
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('toolbar.stop')}</span
          >
        {:else}
          <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,39.87V216.13A15.94,15.94,0,0,0,80,232a16.07,16.07,0,0,0,8.36-2.35L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.94V40l143.83,88Z"
            /></svg
          >
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('toolbar.play')}</span
          >
        {/if}
      </button>
      <button
        onclick={openDebugWindow}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.debug')}
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M144,92a12,12,0,1,1,12,12A12,12,0,0,1,144,92ZM100,80a12,12,0,1,0,12,12A12,12,0,0,0,100,80Zm116,64A87.76,87.76,0,0,1,213,167l22.24,9.72A8,8,0,0,1,232,192a7.89,7.89,0,0,1-3.2-.67L207.38,182a88,88,0,0,1-158.76,0L27.2,191.33A7.89,7.89,0,0,1,24,192a8,8,0,0,1-3.2-15.33L43,167A87.76,87.76,0,0,1,40,144v-8H16a8,8,0,0,1,0-16H40v-8a87.76,87.76,0,0,1,3-23L20.8,79.33a8,8,0,1,1,6.4-14.66L48.62,74a88,88,0,0,1,158.76,0l21.42-9.36a8,8,0,0,1,6.4,14.66L213,89.05a87.76,87.76,0,0,1,3,23v8h24a8,8,0,0,1,0,16H216ZM56,120H200v-8a72,72,0,0,0-144,0Zm64,95.54V136H56v8A72.08,72.08,0,0,0,120,215.54ZM200,144v-8H136v79.54A72.08,72.08,0,0,0,200,144Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.debug')}</span
        >
      </button>

      <div class="h-8 w-px bg-gray-300 mx-1"></div>

      <!-- Group 4: Insert -->
      <button
        onclick={addText}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.text')}
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M112,40a8,8,0,0,0-8,8V64H24A16,16,0,0,0,8,80v96a16,16,0,0,0,16,16h80v16a8,8,0,0,0,16,0V48A8,8,0,0,0,112,40ZM24,176V80h80v96ZM248,80v96a16,16,0,0,1-16,16H144a8,8,0,0,1,0-16h88V80H144a8,8,0,0,1,0-16h88A16,16,0,0,1,248,80ZM88,112a8,8,0,0,1-8,8H72v24a8,8,0,0,1-16,0V120H48a8,8,0,0,1,0-16H80A8,8,0,0,1,88,112Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.text')}</span>
      </button>
      <div class="relative">
        <button
          bind:this={shapePickerButtonRef}
          onclick={() => (showShapePicker = !showShapePicker)}
          class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
          class:bg-gray-200={showShapePicker}
          title={$_('toolbar.shape')}
        >
          <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M71.59,61.47a8,8,0,0,0-15.18,0l-40,120A8,8,0,0,0,24,192h80a8,8,0,0,0,7.59-10.53ZM35.1,176,64,89.3,92.9,176ZM208,76a52,52,0,1,0-52,52A52.06,52.06,0,0,0,208,76Zm-88,0a36,36,0,1,1,36,36A36,36,0,0,1,120,76Zm104,68H136a8,8,0,0,0-8,8v56a8,8,0,0,0,8,8h88a8,8,0,0,0,8-8V152A8,8,0,0,0,224,144Zm-8,56H144V160h72Z"
            /></svg
          >
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('toolbar.shape')}</span
          >
        </button>
        {#if showShapePicker}
          <div
            bind:this={shapePickerRef}
            class="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-1 flex flex-col gap-0.5 min-w-[120px]"
          >
            <button
              onclick={() => {
                addRectangle()
                showShapePicker = false
              }}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 text-left w-full"
            >
              <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"
                ><rect x="2" y="6" width="20" height="12" rx="1" /></svg
              >
              {$_('shape.rect')}
            </button>
            <button
              onclick={() => {
                addEllipse()
                showShapePicker = false
              }}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 text-left w-full"
            >
              <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"
                ><ellipse cx="12" cy="12" rx="10" ry="7" /></svg
              >
              {$_('shape.ellipse')}
            </button>
            <button
              onclick={() => {
                addTriangle()
                showShapePicker = false
              }}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 text-left w-full"
            >
              <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"
                ><polygon points="12,3 22,21 2,21" /></svg
              >
              {$_('shape.triangle')}
            </button>
            <button
              onclick={() => {
                addStar()
                showShapePicker = false
              }}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 text-left w-full"
            >
              <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"
                ><polygon
                  points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"
                /></svg
              >
              {$_('shape.star')}
            </button>
            <button
              onclick={() => {
                addArrow()
                showShapePicker = false
              }}
              class="flex items-center gap-2 px-3 py-1.5 rounded text-sm text-gray-700 hover:bg-gray-100 text-left w-full"
            >
              <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor"
                ><polygon points="2,9 14,9 14,5 22,12 14,19 14,15 2,15" /></svg
              >
              {$_('shape.arrow')}
            </button>
          </div>
        {/if}
      </div>
      <button
        onclick={addImage}
        class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
        title={$_('toolbar.media')}
      >
        <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
          ><path
            d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,16V158.75l-26.07-26.06a16,16,0,0,0-22.63,0l-20,20-44-44a16,16,0,0,0-22.62,0L40,149.37V56ZM40,172l52-52,80,80H40Zm176,28H194.63l-36-36,20-20L216,181.38V200ZM144,100a12,12,0,1,1,12,12A12,12,0,0,1,144,100Z"
          /></svg
        >
        <span class="text-[10px] font-medium leading-none text-gray-500">{$_('toolbar.media')}</span
        >
      </button>

      <!-- Panel toggles — pushed to the far right -->
      <div class="ml-auto flex items-center pr-2">
        <div class="h-8 w-px bg-gray-300 mx-2"></div>
        <button
          onclick={() => (activeSidePanel = 'properties')}
          class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none"
          class:bg-gray-200={activeSidePanel === 'properties'}
          class:text-gray-700={activeSidePanel === 'properties'}
          class:text-gray-600={activeSidePanel !== 'properties'}
          class:hover:bg-gray-200={activeSidePanel !== 'properties'}
          title={$_('panel.properties')}
        >
          <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M230.64,25.36a32,32,0,0,0-45.26,0q-.21.21-.42.45L131.55,88.22,121,77.64a24,24,0,0,0-33.95,0l-76.69,76.7a8,8,0,0,0,0,11.31l80,80a8,8,0,0,0,11.31,0L178.36,169a24,24,0,0,0,0-33.95l-10.58-10.57L230.19,71c.15-.14.31-.28.45-.43A32,32,0,0,0,230.64,25.36ZM96,228.69,79.32,212l22.34-22.35a8,8,0,0,0-11.31-11.31L68,200.68,55.32,188l22.34-22.35a8,8,0,0,0-11.31-11.31L44,176.68,27.31,160,72,115.31,140.69,184ZM219.52,59.1l-68.71,58.81a8,8,0,0,0-.46,11.74L167,146.34a8,8,0,0,1,0,11.31l-15,15L83.32,104l15-15a8,8,0,0,1,11.31,0l16.69,16.69a8,8,0,0,0,11.74-.46L196.9,36.48A16,16,0,0,1,219.52,59.1Z"
            /></svg
          >
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('panel.properties')}</span
          >
        </button>
        <button
          onclick={() => (activeSidePanel = 'layers')}
          class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none"
          class:bg-gray-200={activeSidePanel === 'layers'}
          class:text-gray-700={activeSidePanel === 'layers'}
          class:text-gray-600={activeSidePanel !== 'layers'}
          class:hover:bg-gray-200={activeSidePanel !== 'layers'}
          title={$_('panel.layers')}
        >
          <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M230.91,172A8,8,0,0,1,228,182.91l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,36,169.09l92,53.65,92-53.65A8,8,0,0,1,230.91,172ZM220,121.09l-92,53.65L36,121.09A8,8,0,0,0,28,134.91l96,56a8,8,0,0,0,8.06,0l96-56A8,8,0,1,0,220,121.09ZM24,80a8,8,0,0,1,4-6.91l96-56a8,8,0,0,1,8.06,0l96,56a8,8,0,0,1,0,13.82l-96,56a8,8,0,0,1-8.06,0l-96-56A8,8,0,0,1,24,80Zm23.88,0L128,126.74,208.12,80,128,33.26Z"
            /></svg
          >
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('panel.layers')}</span
          >
        </button>
        <button
          onclick={() => (activeSidePanel = 'animate')}
          class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none"
          class:bg-gray-200={activeSidePanel === 'animate'}
          class:text-gray-700={activeSidePanel === 'animate'}
          class:text-gray-600={activeSidePanel !== 'animate'}
          class:hover:bg-gray-200={activeSidePanel !== 'animate'}
          title={$_('panel.animate')}
        >
          <svg
            class="w-5 h-5"
            viewBox="0 0 256 256"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
          >
            <circle cx="96" cy="128" r="72" stroke-width="16" stroke-dasharray="0.1 27" />
            <circle cx="160" cy="128" r="72" stroke-width="16" />
          </svg>
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('panel.animate')}</span
          >
        </button>
        <button
          onclick={() => (settingsOpen = true)}
          class="flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[44px] focus:outline-none text-gray-600 hover:bg-gray-200"
          title={$_('toolbar.settings')}
        >
          <svg class="w-5 h-5" viewBox="0 0 256 256" fill="currentColor"
            ><path
              d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"
            /></svg
          >
          <span class="text-[10px] font-medium leading-none text-gray-500"
            >{$_('toolbar.settings')}</span
          >
        </button>
      </div>
    </div>
    {#if updateAvailableVersion}
      <div
        class="flex items-center justify-center gap-3 px-4 py-1.5 bg-violet-600 text-white text-xs"
      >
        <span>{$_('update.banner', { values: { version: updateAvailableVersion } })}</span>
        <button
          onclick={() => window.api?.app?.installUpdate()}
          class="px-2.5 py-0.5 rounded bg-white text-violet-700 font-medium hover:bg-violet-50"
        >
          {$_('update.restart')}
        </button>
        <button
          onclick={() => (updateAvailableVersion = null)}
          class="ml-1 opacity-70 hover:opacity-100"
          title={$_('update.dismiss')}>✕</button
        >
      </div>
    {/if}
    <div class="flex flex-1 overflow-hidden">
      <div
        role="list"
        class="basis-32 py-2 overflow-y-auto bg-gray-50 border-r border-gray-300 flex flex-col items-center gap-1"
      >
        {#each appState.slideIds as slideId, index (slideId)}
          <div
            class="relative w-full group"
            class:opacity-40={slideDragSourceId === slideId}
            draggable={!loadingState.isLoadingSlide}
            ondragstart={(e) => onSlideDragStart(e, slideId)}
            ondragover={(e) => onSlideDragOver(e, slideId)}
            ondragleave={onSlideDragLeave}
            ondrop={(e) => onSlideDrop(e, slideId)}
            ondragend={onSlideDragEnd}
            role="listitem"
          >
            {#if slideDragOverId === slideId && slideDragOverPosition === 'before'}
              <div
                class="absolute top-0 left-0 right-0 h-0.5 bg-indigo-500 z-10 pointer-events-none"
              ></div>
            {/if}
            <button
              class="w-full px-2 py-2 rounded-lg cursor-pointer hover:bg-gray-200 flex flex-col items-center gap-1"
              class:bg-gray-200={slideId === appState.currentSlide.id}
              onclick={async () => await handleSlideSelect(slideId)}
              disabled={loadingState.isLoadingSlide}
            >
              {#if appState.thumbnails[slideId]}
                <img
                  src={appState.thumbnails[slideId]}
                  alt="Slide {index + 1}"
                  class="w-full block rounded-md shadow-md"
                />
              {:else}
                <div
                  class="w-full bg-white rounded-md shadow-md flex items-center justify-center text-gray-400 text-xs"
                  style="aspect-ratio: 16/9;"
                ></div>
              {/if}
              <div class="w-full text-xs text-left text-gray-500">{index + 1}</div>
            </button>
            {#if appState.slideIds.length > 1}
              <button
                class="absolute top-2 right-3 opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-opacity z-10"
                onclick={() => {
                  if (confirm(get(_)('slide.delete.confirm'))) deleteSlideById(slideId)
                }}
                title={$_('slide.delete')}
                aria-label={$_('slide.delete')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  class="w-3 h-3"
                >
                  <path
                    fill-rule="evenodd"
                    d="M5 3.25V4H2.75a.75.75 0 0 0 0 1.5h.3l.815 8.15A1.5 1.5 0 0 0 5.357 15h5.285a1.5 1.5 0 0 0 1.493-1.35l.815-8.15h.3a.75.75 0 0 0 0-1.5H11v-.75A2.25 2.25 0 0 0 8.75 1h-1.5A2.25 2.25 0 0 0 5 3.25Zm2.25-.75a.75.75 0 0 0-.75.75V4h3v-.75a.75.75 0 0 0-.75-.75h-1.5ZM6.05 6a.75.75 0 0 1 .787.713l.275 5.5a.75.75 0 0 1-1.498.075l-.275-5.5A.75.75 0 0 1 6.05 6Zm3.9 0a.75.75 0 0 1 .712.787l-.275 5.5a.75.75 0 0 1-1.498-.075l.275-5.5a.75.75 0 0 1 .786-.712Z"
                    clip-rule="evenodd"
                  />
                </svg>
              </button>
            {/if}
            {#if slideDragOverId === slideId && slideDragOverPosition === 'after'}
              <div
                class="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo-500 z-10 pointer-events-none"
              ></div>
            {/if}
          </div>
        {/each}
        <button
          onclick={addNewSlide}
          class="w-[calc(100%-1rem)] mt-1 p-1.5 text-sm font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-200"
        >
          {$_('slide.new')}
        </button>
      </div>
      <div class="flex-1 p-4 bg-gray-200">
        <div class="flex items-center justify-center h-full overflow-auto">
          <div class="bg-white shadow-lg relative">
            <canvas bind:this={canvasEl} width="960" height="540"></canvas>
            {#if loadingState.isLoadingSlide}
              <div
                class="absolute inset-0 z-30 flex items-center justify-center bg-white/72 backdrop-blur-[2px]"
              >
                <div
                  class="rounded-[28px] border border-white/80 bg-[#f7f6f3]/95 shadow-[0_24px_60px_-32px_rgba(15,23,42,0.5)]"
                >
                  <LoadingScreen phase="switching" compact={true} />
                </div>
              </div>
            {/if}
            {#if slideTransitionOverlaySrc}
              <img
                src={slideTransitionOverlaySrc}
                alt=""
                class="absolute inset-0 w-full h-full z-10 pointer-events-none select-none"
                aria-hidden="true"
                draggable="false"
              />
            {/if}
            {#if movePathIndicatorUi.visible}
              <button
                class="absolute z-20 w-5 h-5 border-2 border-white shadow-sm flex items-center justify-center"
                style="left: {movePathIndicatorUi.left}px; top: {movePathIndicatorUi.top}px; transform: translate(-50%, -50%) rotate(45deg); background: #e86b3a;"
                onmousedown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onclick={toggleExpandedMovePath}
                aria-label="Toggle move path editor"
                title="Toggle move path editor"
              >
                {#if expandedMovePathElementId === appState.selectedObjectId}
                  <svg
                    viewBox="0 0 16.4746 1.76758"
                    width="9"
                    height="2"
                    style="transform: rotate(-45deg);"
                    fill="white"
                    aria-hidden="true"
                  >
                    <path
                      d="M0.869141 1.76758L15.2441 1.76758C15.7129 1.76758 16.1133 1.36719 16.1133 0.888672C16.1133 0.410156 15.7129 0.0195312 15.2441 0.0195312L0.869141 0.0195312C0.400391 0.0195312 0 0.410156 0 0.888672C0 1.36719 0.400391 1.76758 0.869141 1.76758Z"
                    />
                  </svg>
                {:else}
                  <svg
                    viewBox="0 0 16.4746 16.123"
                    width="9"
                    height="9"
                    style="transform: rotate(-45deg);"
                    fill="white"
                    aria-hidden="true"
                  >
                    <path
                      d="M8.93555 15.2441L8.93555 0.869141C8.93555 0.400391 8.53516 0 8.05664 0C7.57812 0 7.1875 0.400391 7.1875 0.869141L7.1875 15.2441C7.1875 15.7129 7.57812 16.1133 8.05664 16.1133C8.53516 16.1133 8.93555 15.7129 8.93555 15.2441ZM0.869141 8.92578L15.2441 8.92578C15.7129 8.92578 16.1133 8.53516 16.1133 8.05664C16.1133 7.57812 15.7129 7.17773 15.2441 7.17773L0.869141 7.17773C0.400391 7.17773 0 7.57812 0 8.05664C0 8.53516 0.400391 8.92578 0.869141 8.92578Z"
                    />
                  </svg>
                {/if}
              </button>
            {/if}
          </div>
        </div>
      </div>
      <!-- Unified side panel with tab bar -->
      <div
        class="bg-gray-50 border-l border-gray-300 overflow-hidden flex flex-col relative flex-shrink-0"
        style="width: {stackPanelWidth}px;"
      >
        <!-- Resize handle on the left edge -->
        <div
          class="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400 active:bg-indigo-500 z-10"
          onmousedown={startStackPanelResize}
          role="separator"
          aria-label="Resize panel"
        ></div>
        <!-- Panel content -->
        {#if activeSidePanel === 'layers'}
          <!--
            onLayerChange is only called by the drag-to-reorder path in StackPanel.
            The button paths (onBringToFront etc.) call layerBringToFront/layerMoveUp/
            layerMoveDown/layerSendToBack directly, which already invoke
            applyZOrderToCanvas + scheduleSave internally, so they do NOT call
            onLayerChange to avoid a double canvas update.
          -->
          <StackPanel
            onBeforeLayerChange={pushCheckpoint}
            onLayerChange={() => {
              applyZOrderToCanvas()
              scheduleSave()
              scheduleThumbnailCapture()
            }}
            onSelect={(id) => {
              if (!fabCanvas) return
              const obj = fabCanvas.getObjects().find((o) => (o as TwigFabricObject).id === id)
              if (obj) {
                fabCanvas.discardActiveObject()
                fabCanvas.setActiveObject(obj)
                fabCanvas.requestRenderAll()
              }
            }}
            onBringToFront={layerBringToFront}
            onMoveUp={layerMoveUp}
            onMoveDown={layerMoveDown}
            onSendToBack={layerSendToBack}
          />
        {:else if activeSidePanel === 'animate'}
          <AnimationOrderPanel
            onBeforeChange={pushCheckpoint}
            onAfterChange={() => {
              renderMovePathOverlay()
              scheduleSave()
              scheduleThumbnailCapture()
            }}
            onRemoveStep={handleRemoveAnimationStep}
          />
        {:else}
          <PropertiesPanel
            onPropertyChange={handlePropertyChange}
            onBeforePropertyChange={pushCheckpoint}
            onAnimationChange={handleAnimationChange}
            slideTransition={appState.currentSlide?.transition}
            onSlideTransitionChange={(t) => {
              if (!appState.currentSlide) return
              if (!transitionCheckpointPushed) {
                pushCheckpoint()
                transitionCheckpointPushed = true
              }
              appState.currentSlide.transition = t
              scheduleSave()
            }}
            richText={{
              isBold: isSelectionBold,
              isItalic: isSelectionItalic,
              isUnderlined: isSelectionUnderlined,
              fontSize: selectionFontSize,
              fontFamily: selectionFontFamily,
              fillColor: selectionFillColor,
              fontDropdownOpen,
              fontSearchQuery,
              availableFonts,
              toggleBold,
              toggleItalic,
              toggleUnderline,
              changeFontSize,
              applyStyle: applyStyleToSelection,
              toggleFontDropdown,
              selectFont: selectFontFromDropdown,
              previewFont: queueFontForLoading,
              escapeFont: escapeCssFontFamily,
              closeFontDropdown: () => {
                fontDropdownOpen = false
              },
              setFontSearchQuery: (q) => {
                fontSearchQuery = q
              }
            }}
            onSlideBackgroundChange={async (bg) => {
              if (appState.currentSlide) {
                if (!bgCheckpointPushed) {
                  pushCheckpoint()
                  bgCheckpointPushed = true
                }
                const plain: SlideBackground = JSON.parse(JSON.stringify(bg))
                appState.currentSlide.background = plain
                await applySlideBackground(plain)
                fabCanvas!.renderAll()
                scheduleSave()
                scheduleThumbnailCapture()
              }
            }}
            onSetAsDefault={async (bg) => {
              if (!appState.currentFilePath) return
              // JSON round-trip strips any Svelte 5 reactive Proxy before IPC/storage
              const plain: SlideBackground | null = bg ? JSON.parse(JSON.stringify(bg)) : null
              defaultSlideBackground = plain ?? undefined
              await window.api.db.setSetting(
                appState.currentFilePath,
                'default_background',
                plain ? JSON.stringify(plain) : null
              )
            }}
            onApplyToAll={async (bg) => {
              if (!appState.currentFilePath || !appState.currentSlide) return
              // Snapshot every slide before the DB write so each slide's undo history
              // has a restore point. Non-current slides must be fetched from the DB first.
              const filePath = appState.currentFilePath
              await Promise.all(
                appState.slideIds.map(async (id) => {
                  if (id === appState.currentSlide?.id) {
                    pushCheckpoint()
                  } else {
                    const slide = await window.api.db.getSlide(filePath, id)
                    if (slide) pushCheckpointForSlide(slide)
                  }
                })
              )
              const plain: SlideBackground | null = bg ? JSON.parse(JSON.stringify(bg)) : null
              try {
                await window.api.db.applyBackgroundToAll(appState.currentFilePath, plain)
              } catch (err) {
                console.error('applyBackgroundToAll failed:', err)
                return
              }
              if (!appState.currentSlide) return
              appState.currentSlide.background = plain ?? undefined
              await applySlideBackground(plain ?? undefined)
              fabCanvas?.renderAll()
              scheduleThumbnailCapture()
              scheduleSave()
              // Regenerate thumbnails for all other slides in the background
              regenerateAllThumbnails(plain ?? undefined).catch(console.error)
            }}
          />
        {/if}
      </div>
    </div>
  </div>
{:else}
  <LoadingScreen phase={loadingScreenPhase} />
{/if}
