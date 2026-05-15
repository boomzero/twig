/**
 * Animated GIF playback for fabric.js images in the presentation window.
 *
 * Constraints:
 * - Editor canvas GIFs stay static — this module is only wired into
 *   Presentation.svelte.
 * - Storage, DB schema, and IPC are unchanged; we read element.src as-is.
 * - register() is fire-and-forget. renderSlide() must never await it.
 *
 * Future video support should follow the same per-canvas singleton shape:
 * one manager next to the canvas, reset() per slide, dispose() on teardown.
 * But it must be a separate manager — do not overload this one.
 */

import {
  parseGIF as defaultParseGIF,
  decompressFrames as defaultDecompressFrames,
  type ParsedGif,
  type ParsedFrame
} from 'gifuct-js'
import type { Canvas as FabricCanvas, FabricImage } from 'fabric'
import type { TwigElement } from './types'

// ============================================================================
// Public API
// ============================================================================

const GIF_DATA_URL_PATTERN = /^data:image\/gif(?:;[^,]*)?;base64,/i

/** Recognizes base64 GIF data URLs, case- and parameter-tolerant. */
export function isGifDataUrl(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false
  return GIF_DATA_URL_PATTERN.test(value)
}

/**
 * Decodes the first frame of a GIF data URL into a PNG data URL so the result
 * can be used as a static `<img src>` in editor UI (e.g. background preview).
 *
 * The plan keeps GIFs static in the editor; native `<img>` tags animate them
 * automatically, so anywhere we want a still preview we need to render frame
 * zero explicitly. Falls back to returning the original URL on any failure
 * (better an animated preview than a broken one).
 */
const firstFrameCache = new Map<string, string>()

export async function getGifFirstFrameDataUrl(gifDataUrl: string): Promise<string> {
  const cached = firstFrameCache.get(gifDataUrl)
  if (cached) return cached
  try {
    const commaIdx = gifDataUrl.indexOf(',')
    if (commaIdx < 0) return gifDataUrl
    const base64 = gifDataUrl.slice(commaIdx + 1)
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const parsed = defaultParseGIF(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    )
    const frames = defaultDecompressFrames(parsed, true)
    if (frames.length === 0) return gifDataUrl
    const frame = frames[0]
    const W = parsed.lsd.width
    const H = parsed.lsd.height
    if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return gifDataUrl
    const composite = document.createElement('canvas')
    composite.width = W
    composite.height = H
    const ctx = composite.getContext('2d')
    if (!ctx) return gifDataUrl
    const scratch = document.createElement('canvas')
    scratch.width = frame.dims.width
    scratch.height = frame.dims.height
    const sctx = scratch.getContext('2d')
    if (!sctx) return gifDataUrl
    sctx.putImageData(
      new ImageData(
        frame.patch as unknown as Uint8ClampedArray<ArrayBuffer>,
        frame.dims.width,
        frame.dims.height
      ),
      0,
      0
    )
    ctx.drawImage(
      scratch,
      0,
      0,
      frame.dims.width,
      frame.dims.height,
      frame.dims.left,
      frame.dims.top,
      frame.dims.width,
      frame.dims.height
    )
    const pngUrl = composite.toDataURL('image/png')
    firstFrameCache.set(gifDataUrl, pngUrl)
    return pngUrl
  } catch {
    return gifDataUrl
  }
}

type AfterPaintCancel = () => void
type TimeoutHandle = unknown

/**
 * Internal/test injection hook. Production usage is `new GifAnimationManager(canvas)`.
 * Tests can override the decoder, schedulers, document, and canvas factory so
 * we don't need a real DOM canvas under Node.
 */
export interface GifAnimationManagerOptions {
  parseGIF?: typeof defaultParseGIF
  decompressFrames?: typeof defaultDecompressFrames
  scheduleAfterPaint?: (cb: () => void) => AfterPaintCancel
  scheduleTimeout?: (cb: () => void, delayMs: number) => TimeoutHandle
  clearScheduledTimeout?: (handle: TimeoutHandle) => void
  documentRef?: GifDocument | null
  createCanvas?: (width: number, height: number) => HTMLCanvasElement
  createImageData?: (data: Uint8ClampedArray, width: number, height: number) => ImageData
  isLive?: (manager: GifAnimationManager, fabricImage: FabricImage) => boolean
  now?: () => number
  /** Override encoded-size limit (bytes). Defaults to 25 MB. Test hook. */
  maxEncodedSizeBytes?: number
}

/** Subset of `document` we depend on, for injection. */
export interface GifDocument {
  hidden: boolean
  addEventListener: (type: 'visibilitychange', listener: () => void) => void
  removeEventListener: (type: 'visibilitychange', listener: () => void) => void
}

// ============================================================================
// Constants
// ============================================================================

const MAX_ENCODED_SIZE_BYTES = 25 * 1024 * 1024
const MAX_LOGICAL_DIMENSION = 4096
const MAX_FRAME_COUNT = 300
const MAX_DECODE_WALLCLOCK_MS = 2000
const MEMORY_BUDGET_BYTES = 64 * 1024 * 1024
const MAX_DECODE_CONCURRENCY = 4
const MIN_DELAY_MS = 20
const DEFAULT_DELAY_MS = 100

// ============================================================================
// Internal state types
// ============================================================================

interface ReservationToken {
  bytes: number
  /**
   * 'reserved'  — bytes counted in manager.reservedBytes
   * 'committed' — bytes counted in manager.committedBytes
   * 'released'  — bytes refunded to nothing; further releases are no-ops
   */
  state: 'reserved' | 'committed' | 'released'
}

interface NormalizedFrame {
  dims: { left: number; top: number; width: number; height: number }
  delayMs: number
  disposalType: number
  patch: Uint8ClampedArray
}

interface GifState {
  elementId: string
  element: TwigElement
  fabricImage: FabricImage
  generation: number
  frames: NormalizedFrame[]
  composite: HTMLCanvasElement
  compositeCtx: CanvasRenderingContext2D
  scratch: HTMLCanvasElement
  scratchCtx: CanvasRenderingContext2D
  logicalWidth: number
  logicalHeight: number
  /** Index of the most-recently-drawn frame on the composite. */
  drawnIndex: number
  /** Disposal type of the frame currently sitting on the composite. */
  pendingDisposal: number
  timer: TimeoutHandle | null
  reservation: ReservationToken
}

interface QueuedTask {
  element: TwigElement
  fabricImage: FabricImage
  generation: number
}

type WarningKey =
  | 'lowDelay'
  | 'encodedSize'
  | 'badMetadata'
  | 'frameCount'
  | 'decodeWallclock'
  | 'memoryBudget'
  | 'decodeFailure'

// ============================================================================
// Default schedulers
// ============================================================================

function defaultScheduleAfterPaint(cb: () => void): AfterPaintCancel {
  let cancelled = false
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  // Decode after the next paint so the static Fabric image renders first.
  // RAF alone runs *before* the next paint; pairing with setTimeout(0) defers
  // heavy work until after the browser has actually painted.
  const rafId = requestAnimationFrame(() => {
    if (cancelled) return
    timeoutId = setTimeout(() => {
      if (cancelled) return
      cb()
    }, 0)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(rafId)
    if (timeoutId != null) clearTimeout(timeoutId)
  }
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function defaultCreateImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  // gifuct-js patches are backed by a regular ArrayBuffer, but TS's lib types
  // type Uint8ClampedArray as Uint8ClampedArray<ArrayBufferLike>, which the
  // ImageData ctor rejects (it wants <ArrayBuffer>). Cast through unknown.
  return new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height)
}

function defaultIsLive(manager: GifAnimationManager, fabricImage: FabricImage): boolean {
  if (fabricImage.canvas !== manager.canvas) return false
  return manager.canvas.getObjects().includes(fabricImage)
}

// ============================================================================
// GifAnimationManager
// ============================================================================

export class GifAnimationManager {
  readonly canvas: FabricCanvas
  private readonly opts: Required<Omit<GifAnimationManagerOptions, 'documentRef'>> & {
    documentRef: GifDocument | null
  }

  private generation = 0
  private running = false
  private disposed = false
  private readonly states = new Map<string, GifState>()
  private readonly queue: QueuedTask[] = []
  private readonly afterPaintCancels = new Set<AfterPaintCancel>()
  private inFlight = 0
  private reservedBytes = 0
  private committedBytes = 0
  private readonly warned = new Set<WarningKey>()
  private readonly visibilityListener: () => void
  private visibilityRegistered = false

  constructor(canvas: FabricCanvas, options: GifAnimationManagerOptions = {}) {
    this.canvas = canvas
    const docRef =
      options.documentRef === undefined
        ? typeof document !== 'undefined'
          ? document
          : null
        : options.documentRef
    this.opts = {
      parseGIF: options.parseGIF ?? defaultParseGIF,
      decompressFrames: options.decompressFrames ?? defaultDecompressFrames,
      scheduleAfterPaint: options.scheduleAfterPaint ?? defaultScheduleAfterPaint,
      scheduleTimeout:
        options.scheduleTimeout ??
        ((cb, delay) => setTimeout(cb, delay) as unknown as TimeoutHandle),
      clearScheduledTimeout:
        options.clearScheduledTimeout ??
        ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
      documentRef: docRef,
      createCanvas: options.createCanvas ?? defaultCreateCanvas,
      createImageData: options.createImageData ?? defaultCreateImageData,
      isLive: options.isLive ?? defaultIsLive,
      now:
        options.now ??
        (typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? () => performance.now()
          : () => Date.now()),
      maxEncodedSizeBytes: options.maxEncodedSizeBytes ?? MAX_ENCODED_SIZE_BYTES
    }

    this.visibilityListener = () => this.handleVisibilityChange()
    if (this.opts.documentRef) {
      this.opts.documentRef.addEventListener('visibilitychange', this.visibilityListener)
      this.visibilityRegistered = true
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Clears all pending and active GIFs but keeps the manager reusable. */
  reset(): void {
    this.generation++
    this.running = false
    this.cancelAllAfterPaint()
    this.queue.length = 0
    this.clearAllTimers()
    this.releaseAllStates()
  }

  /** Permanently shuts down the manager. */
  dispose(): void {
    this.generation++
    this.disposed = true
    this.running = false
    this.cancelAllAfterPaint()
    this.queue.length = 0
    this.clearAllTimers()
    this.releaseAllStates()
    if (this.visibilityRegistered && this.opts.documentRef) {
      this.opts.documentRef.removeEventListener('visibilitychange', this.visibilityListener)
      this.visibilityRegistered = false
    }
  }

  /** Schedules decode of the given GIF element. Fire-and-forget. */
  register(element: TwigElement, fabricImage: FabricImage): void {
    if (this.disposed) return
    if (!isGifDataUrl(element.src)) return
    this.queue.push({ element, fabricImage, generation: this.generation })
    this.pumpQueue()
  }

  /**
   * Starts playback of all decoded GIFs. Idempotent: extra calls do not
   * duplicate timers. No timers scheduled while the document is hidden.
   */
  start(): void {
    if (this.disposed) return
    this.running = true
    if (this.opts.documentRef?.hidden) return
    for (const state of this.states.values()) {
      if (state.timer == null) this.scheduleNextTick(state)
    }
  }

  // --------------------------------------------------------------------------
  // Queue / decode pipeline
  // --------------------------------------------------------------------------

  private pumpQueue(): void {
    while (!this.disposed && this.inFlight < MAX_DECODE_CONCURRENCY && this.queue.length > 0) {
      const task = this.queue.shift()!
      if (task.generation !== this.generation) continue
      this.inFlight++
      const cancel = this.opts.scheduleAfterPaint(() => {
        this.afterPaintCancels.delete(cancel)
        try {
          this.runDecode(task)
        } finally {
          this.inFlight--
          this.pumpQueue()
        }
      })
      this.afterPaintCancels.add(cancel)
    }
  }

  private runDecode(task: QueuedTask): void {
    if (this.disposed) return
    if (task.generation !== this.generation) return
    if (!this.opts.isLive(this, task.fabricImage)) return

    const src = task.element.src
    if (!isGifDataUrl(src)) return

    let reservation: ReservationToken | null = null

    try {
      const encoded = base64FromDataUrl(src!)
      if (encoded == null) return

      const approxEncodedBytes = approxBase64DecodedSize(encoded.length)
      if (approxEncodedBytes > this.opts.maxEncodedSizeBytes) {
        this.warnOnce(
          'encodedSize',
          `GIF rejected: encoded size > ${this.opts.maxEncodedSizeBytes} bytes`
        )
        return
      }

      const bytes = decodeBase64ToBytes(encoded)
      if (!bytes) return
      if (bytes.byteLength > this.opts.maxEncodedSizeBytes) {
        this.warnOnce(
          'encodedSize',
          `GIF rejected: decoded size > ${this.opts.maxEncodedSizeBytes} bytes`
        )
        return
      }

      const t0 = this.opts.now()
      let parsed: ParsedGif
      try {
        parsed = this.opts.parseGIF(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        )
      } catch (err) {
        this.warnOnce('decodeFailure', `GIF parseGIF failed: ${describeError(err)}`)
        return
      }

      const logicalWidth = parsed.lsd?.width ?? 0
      const logicalHeight = parsed.lsd?.height ?? 0
      if (!isValidLogicalDimension(logicalWidth) || !isValidLogicalDimension(logicalHeight)) {
        this.warnOnce(
          'badMetadata',
          `GIF rejected: invalid logical dimensions ${logicalWidth}x${logicalHeight}`
        )
        return
      }

      const frameCount = parsed.frames.filter((f) => 'image' in f).length
      if (frameCount <= 0 || frameCount > MAX_FRAME_COUNT) {
        this.warnOnce('frameCount', `GIF rejected: frame count ${frameCount} out of range`)
        return
      }

      // Preflight estimate. Patch rects are unknown until decompress, so fail
      // closed with worst-case bytes per frame.
      const compositeBytes = logicalWidth * logicalHeight * 4
      const worstScratchBytes = compositeBytes
      const estimatedPatchBytes = compositeBytes * frameCount
      const estimatedTotal = estimatedPatchBytes + compositeBytes + worstScratchBytes
      if (!Number.isFinite(estimatedTotal) || estimatedTotal <= 0) {
        this.warnOnce('badMetadata', `GIF rejected: estimated bytes not finite`)
        return
      }
      reservation = this.tryReserve(estimatedTotal)
      if (!reservation) {
        this.warnOnce('memoryBudget', `GIF rejected: memory budget exceeded (preflight)`)
        return
      }

      let frames: ParsedFrame[]
      try {
        frames = this.opts.decompressFrames(parsed, true)
      } catch (err) {
        this.warnOnce('decodeFailure', `GIF decompressFrames failed: ${describeError(err)}`)
        return
      }

      const elapsed = this.opts.now() - t0
      if (elapsed > MAX_DECODE_WALLCLOCK_MS) {
        this.warnOnce(
          'decodeWallclock',
          `GIF rejected: decode wallclock ${elapsed}ms > ${MAX_DECODE_WALLCLOCK_MS}ms`
        )
        return
      }

      if (frames.length === 0 || frames.length > MAX_FRAME_COUNT) {
        this.warnOnce(
          'frameCount',
          `GIF rejected: decompressed frame count ${frames.length} out of range`
        )
        return
      }

      let maxPatchW = 0
      let maxPatchH = 0
      let actualPatchBytes = 0
      const normalized: NormalizedFrame[] = []
      for (const frame of frames) {
        const dims = frame.dims
        if (
          !isFiniteDim(dims.width) ||
          !isFiniteDim(dims.height) ||
          dims.width <= 0 ||
          dims.height <= 0
        ) {
          this.warnOnce(
            'badMetadata',
            `GIF rejected: invalid patch dimensions ${dims.width}x${dims.height}`
          )
          return
        }
        if (!Number.isFinite(dims.left) || !Number.isFinite(dims.top)) {
          this.warnOnce('badMetadata', `GIF rejected: non-finite patch offset`)
          return
        }
        if (
          dims.left < 0 ||
          dims.top < 0 ||
          dims.left + dims.width > logicalWidth ||
          dims.top + dims.height > logicalHeight
        ) {
          this.warnOnce('badMetadata', `GIF rejected: patch rect outside logical canvas bounds`)
          return
        }
        if (!frame.patch || frame.patch.byteLength === 0) {
          this.warnOnce('badMetadata', `GIF rejected: missing patch data`)
          return
        }

        const rawDelay = typeof frame.delay === 'number' ? frame.delay : 0
        let delayMs = rawDelay
        if (!Number.isFinite(delayMs) || delayMs <= 0) delayMs = DEFAULT_DELAY_MS
        if (delayMs < MIN_DELAY_MS) {
          this.warnOnce('lowDelay', `GIF delay ${delayMs}ms clamped to ${MIN_DELAY_MS}ms`)
          delayMs = MIN_DELAY_MS
        }

        normalized.push({
          dims: { left: dims.left, top: dims.top, width: dims.width, height: dims.height },
          delayMs,
          disposalType: frame.disposalType ?? 0,
          patch: frame.patch
        })

        actualPatchBytes += frame.patch.byteLength
        if (dims.width > maxPatchW) maxPatchW = dims.width
        if (dims.height > maxPatchH) maxPatchH = dims.height
      }

      const scratchBytes = maxPatchW * maxPatchH * 4
      const actualTotal = actualPatchBytes + compositeBytes + scratchBytes
      if (!Number.isFinite(actualTotal) || actualTotal <= 0) {
        this.warnOnce('badMetadata', `GIF rejected: actual bytes not finite`)
        return
      }

      // Reconcile reservation against actual.
      if (actualTotal > reservation.bytes) {
        const extra = actualTotal - reservation.bytes
        if (!this.tryTopUpReservation(reservation, extra)) {
          this.warnOnce('memoryBudget', `GIF rejected: memory budget exceeded (actual)`)
          return
        }
      } else if (actualTotal < reservation.bytes) {
        const surplus = reservation.bytes - actualTotal
        this.releaseReservation(reservation, surplus)
      }

      // After top-up `reservation.bytes === actualTotal` (or it was already
      // equal). Re-verify liveness and generation before allocating.
      if (this.disposed) return
      if (task.generation !== this.generation) return
      if (!this.opts.isLive(this, task.fabricImage)) return

      const composite = this.opts.createCanvas(logicalWidth, logicalHeight)
      const compositeCtx = composite.getContext('2d')
      const scratch = this.opts.createCanvas(maxPatchW, maxPatchH)
      const scratchCtx = scratch.getContext('2d')
      if (!compositeCtx || !scratchCtx) {
        this.warnOnce('decodeFailure', `GIF rejected: 2D context unavailable`)
        return
      }

      const state: GifState = {
        elementId: task.element.id,
        element: task.element,
        fabricImage: task.fabricImage,
        generation: task.generation,
        frames: normalized,
        composite,
        compositeCtx,
        scratch,
        scratchCtx,
        logicalWidth,
        logicalHeight,
        drawnIndex: -1,
        pendingDisposal: 0,
        timer: null,
        reservation
      }

      this.drawFrame(state, 0)
      state.pendingDisposal = normalized[0].disposalType
      state.drawnIndex = 0

      this.installCompositeOnFabricImage(state)

      // Promote reservation → committed and hand ownership to the state.
      // Setting reservation = null prevents the finally from refunding bytes
      // we've now committed into the state.
      this.commitReservation(reservation)
      reservation = null

      this.states.set(task.element.id, state)

      if (this.running && !this.opts.documentRef?.hidden) {
        this.scheduleNextTick(state)
      }
    } catch (err) {
      this.warnOnce('decodeFailure', `GIF unexpected error: ${describeError(err)}`)
    } finally {
      if (reservation && reservation.state === 'reserved') {
        this.releaseReservation(reservation, reservation.bytes)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Drawing
  // --------------------------------------------------------------------------

  private drawFrame(state: GifState, frameIndex: number): void {
    const frame = state.frames[frameIndex]
    const { compositeCtx, scratchCtx, scratch } = state

    // Apply pending disposal from previously drawn frame.
    if (state.drawnIndex >= 0 && state.drawnIndex !== frameIndex) {
      const prev = state.frames[state.drawnIndex]
      this.applyDisposal(state, prev, state.pendingDisposal)
    }

    // Compose the patch via a scratch canvas so transparent GIF pixels do not
    // erase what's already on the composite (drawImage uses source-over by
    // default, which is what we want for cumulative GIF rendering).
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height)
    const imageData = this.opts.createImageData(frame.patch, frame.dims.width, frame.dims.height)
    scratchCtx.putImageData(imageData, 0, 0)
    compositeCtx.drawImage(
      scratch,
      0,
      0,
      frame.dims.width,
      frame.dims.height,
      frame.dims.left,
      frame.dims.top,
      frame.dims.width,
      frame.dims.height
    )

    state.drawnIndex = frameIndex
    state.pendingDisposal = frame.disposalType
  }

  private applyDisposal(state: GifState, drawnFrame: NormalizedFrame, disposalType: number): void {
    // 0 / 1: leave in place.
    // 2: clear the previous frame's rect before drawing next.
    // 3: "restore to previous" — treated as clear-rect (disposal 2) here.
    //    A full implementation would snapshot pre-frame pixels; we omit that
    //    to keep memory bounded.
    if (disposalType === 2 || disposalType === 3) {
      state.compositeCtx.clearRect(
        drawnFrame.dims.left,
        drawnFrame.dims.top,
        drawnFrame.dims.width,
        drawnFrame.dims.height
      )
    }
  }

  private installCompositeOnFabricImage(state: GifState): void {
    const img = state.fabricImage
    const targetW = state.element.width
    const targetH = state.element.height
    img.setElement(state.composite)
    img.scaleX = targetW / state.composite.width
    img.scaleY = targetH / state.composite.height
    img.set({ dirty: true })
    this.canvas.requestRenderAll()
  }

  // --------------------------------------------------------------------------
  // Tick scheduling
  // --------------------------------------------------------------------------

  private scheduleNextTick(state: GifState): void {
    if (this.disposed) return
    if (!this.running) return
    if (this.opts.documentRef?.hidden) return
    if (state.timer != null) {
      this.opts.clearScheduledTimeout(state.timer)
      state.timer = null
    }
    const frame = state.frames[state.drawnIndex >= 0 ? state.drawnIndex : 0]
    const delay = frame.delayMs
    state.timer = this.opts.scheduleTimeout(() => this.tick(state), delay)
  }

  private tick(state: GifState): void {
    state.timer = null
    if (this.disposed) return
    if (state.generation !== this.generation) {
      this.releaseState(state.elementId)
      return
    }
    if (!this.opts.isLive(this, state.fabricImage)) {
      this.releaseState(state.elementId)
      return
    }

    const nextIndex = (state.drawnIndex + 1) % state.frames.length
    this.drawFrame(state, nextIndex)
    state.fabricImage.set({ dirty: true })
    this.canvas.requestRenderAll()

    if (this.running && !this.opts.documentRef?.hidden) {
      this.scheduleNextTick(state)
    }
  }

  // --------------------------------------------------------------------------
  // Memory reservations
  // --------------------------------------------------------------------------

  private tryReserve(bytes: number): ReservationToken | null {
    if (this.committedBytes + this.reservedBytes + bytes > MEMORY_BUDGET_BYTES) return null
    this.reservedBytes += bytes
    return { bytes, state: 'reserved' }
  }

  private tryTopUpReservation(token: ReservationToken, extra: number): boolean {
    if (token.state !== 'reserved') return false
    if (this.committedBytes + this.reservedBytes + extra > MEMORY_BUDGET_BYTES) return false
    this.reservedBytes += extra
    token.bytes += extra
    return true
  }

  /**
   * Releases `amount` bytes from the token. Idempotent — repeated calls past
   * full release are no-ops. Only valid while the token is in 'reserved'.
   */
  private releaseReservation(token: ReservationToken, amount: number): void {
    if (token.state !== 'reserved') return
    const released = Math.min(amount, token.bytes)
    this.reservedBytes -= released
    token.bytes -= released
    if (token.bytes <= 0) {
      token.bytes = 0
      token.state = 'released'
    }
  }

  /** Move the token's bytes from reserved → committed accounting. */
  private commitReservation(token: ReservationToken): void {
    if (token.state !== 'reserved') return
    this.committedBytes += token.bytes
    this.reservedBytes -= token.bytes
    token.state = 'committed'
  }

  private releaseAllStates(): void {
    for (const id of Array.from(this.states.keys())) {
      this.releaseState(id)
    }
    // Any non-zero reservedBytes here would be accounting from tasks whose
    // finally block hasn't run yet (synchronous decode pipeline means this is
    // unreachable in practice). Defensive clear:
    this.reservedBytes = 0
    this.committedBytes = 0
  }

  private releaseState(elementId: string): void {
    const state = this.states.get(elementId)
    if (!state) return
    if (state.timer != null) {
      this.opts.clearScheduledTimeout(state.timer)
      state.timer = null
    }
    if (state.reservation.state === 'committed') {
      this.committedBytes -= state.reservation.bytes
    } else if (state.reservation.state === 'reserved') {
      this.reservedBytes -= state.reservation.bytes
    }
    state.reservation.bytes = 0
    state.reservation.state = 'released'
    this.states.delete(elementId)
  }

  private clearAllTimers(): void {
    for (const state of this.states.values()) {
      if (state.timer != null) {
        this.opts.clearScheduledTimeout(state.timer)
        state.timer = null
      }
    }
  }

  private cancelAllAfterPaint(): void {
    for (const cancel of this.afterPaintCancels) {
      try {
        cancel()
      } catch {
        /* ignore */
      }
    }
    this.afterPaintCancels.clear()
    // Cancelled callbacks never run their try/finally, so reset the in-flight
    // counter manually. Otherwise subsequent register() calls would be capped
    // below MAX_DECODE_CONCURRENCY forever.
    this.inFlight = 0
  }

  // --------------------------------------------------------------------------
  // Visibility
  // --------------------------------------------------------------------------

  private handleVisibilityChange(): void {
    if (this.disposed) return
    const hidden = this.opts.documentRef?.hidden ?? false
    if (hidden) {
      // Cancel pending timers but preserve drawnIndex/pendingDisposal so we
      // can resume seamlessly.
      for (const state of this.states.values()) {
        if (state.timer != null) {
          this.opts.clearScheduledTimeout(state.timer)
          state.timer = null
        }
      }
    } else if (this.running) {
      for (const state of this.states.values()) {
        if (state.timer == null) this.scheduleNextTick(state)
      }
    }
  }

  // --------------------------------------------------------------------------
  // Warning policy
  // --------------------------------------------------------------------------

  private warnOnce(key: WarningKey, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(`[gif] ${message}`)
  }
}

// ============================================================================
// Helpers
// ============================================================================

function base64FromDataUrl(dataUrl: string): string | null {
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx < 0) return null
  return dataUrl.slice(commaIdx + 1)
}

function approxBase64DecodedSize(base64Length: number): number {
  // Ignores padding refinement; an upper bound is fine for the cheap preflight.
  return Math.floor((base64Length * 3) / 4)
}

function decodeBase64ToBytes(base64: string): Uint8Array | null {
  try {
    if (typeof atob === 'function') {
      const binary = atob(base64)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
      return out
    }
    // Fallback path for Node (tests use injected decoder, but be safe).
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(base64, 'base64')
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
  } catch {
    return null
  }
  return null
}

function isValidLogicalDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_LOGICAL_DIMENSION
}

function isFiniteDim(value: number): boolean {
  return Number.isFinite(value)
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unknown>'
  }
}
