import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GifAnimationManager,
  isGifDataUrl,
  type GifAnimationManagerOptions,
  type GifDocument
} from '@renderer/lib/gif'
import type { ParsedFrame, ParsedGif } from 'gifuct-js'
import type { Canvas as FabricCanvas, FabricImage } from 'fabric'
import type { TwigElement } from '@renderer/lib/types'

// ============================================================================
// Test scaffolding: controllable schedulers, mock canvas/context, fake decoder
// ============================================================================

type Recorded2DCall =
  | { op: 'clearRect'; args: [number, number, number, number] }
  | { op: 'putImageData'; args: [unknown, number, number] }
  | { op: 'drawImage'; args: unknown[] }

interface MockCanvas {
  width: number
  height: number
  ctx: MockContext
  getContext(): MockContext
}

interface MockContext {
  calls: Recorded2DCall[]
  clearRect: (x: number, y: number, w: number, h: number) => void
  putImageData: (data: unknown, dx: number, dy: number) => void
  drawImage: (...args: unknown[]) => void
}

function makeMockCanvas(width: number, height: number): MockCanvas {
  const ctx: MockContext = {
    calls: [],
    clearRect: (x, y, w, h) => ctx.calls.push({ op: 'clearRect', args: [x, y, w, h] }),
    putImageData: (data, dx, dy) => ctx.calls.push({ op: 'putImageData', args: [data, dx, dy] }),
    drawImage: (...args) => ctx.calls.push({ op: 'drawImage', args })
  }
  return {
    width,
    height,
    ctx,
    getContext: () => ctx
  }
}

interface AfterPaintScheduler {
  schedule: (cb: () => void) => () => void
  flush: () => void
  pending: () => number
}

function makeAfterPaintScheduler(): AfterPaintScheduler {
  const queue: Array<{ cb: () => void; cancelled: boolean }> = []
  return {
    schedule: (cb: () => void): (() => void) => {
      const task = { cb, cancelled: false }
      queue.push(task)
      return (): void => {
        task.cancelled = true
      }
    },
    flush(): void {
      const tasks = queue.splice(0)
      for (const t of tasks) if (!t.cancelled) t.cb()
    },
    pending(): number {
      return queue.filter((t) => !t.cancelled).length
    }
  }
}

interface TimeoutScheduler {
  schedule: (cb: () => void, delay: number) => unknown
  clear: (handle: unknown) => void
  fireAll: () => void
  fireOne: (id?: number) => void
  delays: () => number[]
  size: () => number
}

function makeTimeoutScheduler(): TimeoutScheduler {
  let nextId = 1
  const timers = new Map<number, { cb: () => void; delay: number }>()
  return {
    schedule(cb: () => void, delay: number): unknown {
      const id = nextId++
      timers.set(id, { cb, delay })
      return id
    },
    clear(handle: unknown): void {
      timers.delete(handle as number)
    },
    fireAll(): void {
      const entries = Array.from(timers.entries())
      timers.clear()
      for (const [, t] of entries) t.cb()
    },
    fireOne(id?: number): void {
      const useId = id ?? Array.from(timers.keys())[0]
      const t = timers.get(useId)
      if (t) {
        timers.delete(useId)
        t.cb()
      }
    },
    delays(): number[] {
      return Array.from(timers.values()).map((t) => t.delay)
    },
    size(): number {
      return timers.size
    }
  }
}

function makeMockDocument(initialHidden = false): GifDocument & { setHidden(v: boolean): void } {
  const listeners = new Set<() => void>()
  let hidden = initialHidden
  return {
    get hidden() {
      return hidden
    },
    addEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.delete(listener)
    },
    setHidden(v: boolean) {
      hidden = v
      for (const l of Array.from(listeners)) l()
    }
  }
}

interface MockFabricImage {
  canvas: unknown
  setElement: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  scaleX: number
  scaleY: number
}

interface MockFabricCanvas {
  objects: MockFabricImage[]
  requestRenderAll: ReturnType<typeof vi.fn>
  getObjects(): MockFabricImage[]
}

function makeMockFabricCanvas(): MockFabricCanvas {
  const canvas: MockFabricCanvas = {
    objects: [],
    requestRenderAll: vi.fn(),
    getObjects: () => canvas.objects
  }
  return canvas
}

function makeMockFabricImage(canvas: MockFabricCanvas): MockFabricImage {
  const img: MockFabricImage = {
    canvas,
    setElement: vi.fn(),
    set: vi.fn(),
    scaleX: 1,
    scaleY: 1
  }
  canvas.objects.push(img)
  return img
}

function makeFakeFrame(opts: {
  width: number
  height: number
  left?: number
  top?: number
  delay?: number
  disposalType?: number
  // patch bytes; if omitted, fills with 0xff
  patchBytes?: Uint8ClampedArray
}): ParsedFrame {
  const { width, height, left = 0, top = 0, delay = 100, disposalType = 0 } = opts
  const patch = opts.patchBytes ?? new Uint8ClampedArray(width * height * 4).fill(0xff)
  return {
    dims: { width, height, left, top },
    delay,
    disposalType,
    patch,
    colorTable: [],
    pixels: [],
    transparentIndex: -1
  }
}

function makeFakeParsedGif(width: number, height: number, frameCount: number): ParsedGif {
  return {
    frames: Array.from({ length: frameCount }, () => ({
      gce: {
        byteSize: 0,
        codes: [],
        delay: 10,
        terminator: 0,
        transparentColorIndex: 0,
        extras: {
          userInput: false,
          transparentColorGiven: false,
          future: 0,
          disposal: 0
        }
      },
      image: {
        code: 0,
        data: { minCodeSize: 0, blocks: [] },
        descriptor: {
          top: 0,
          left: 0,
          width,
          height,
          lct: { exists: false, future: 0, interlaced: false, size: 0, sort: false }
        }
      }
    })),
    gct: [],
    header: { signature: 'GIF', version: '89a' },
    lsd: {
      backgroundColorIndex: 0,
      gct: { exists: false, resolution: 0, size: 0, sort: false },
      width,
      height,
      pixelAspectRatio: 0
    }
  }
}

function makeGifDataUrl(size = 8): string {
  const bytes = new Uint8Array(size)
  return `data:image/gif;base64,${Buffer.from(bytes).toString('base64')}`
}

function makeGifElement(id: string, width = 64, height = 32): TwigElement {
  return {
    id,
    type: 'image',
    x: 0,
    y: 0,
    width,
    height,
    angle: 0,
    zIndex: 0,
    src: makeGifDataUrl()
  }
}

interface Harness {
  manager: GifAnimationManager
  fabricCanvas: MockFabricCanvas
  afterPaint: ReturnType<typeof makeAfterPaintScheduler>
  timeouts: ReturnType<typeof makeTimeoutScheduler>
  doc: ReturnType<typeof makeMockDocument>
  parseGIF: ReturnType<typeof vi.fn>
  decompressFrames: ReturnType<typeof vi.fn>
  createdCanvases: MockCanvas[]
  imageDatas: Array<{ data: Uint8ClampedArray; width: number; height: number }>
}

function makeHarness(
  framesProvider: (gif: ParsedGif) => ParsedFrame[],
  parsedProvider?: (bytes: ArrayBuffer) => ParsedGif,
  overrides: Partial<GifAnimationManagerOptions> = {}
): Harness {
  const fabricCanvas = makeMockFabricCanvas()
  const afterPaint = makeAfterPaintScheduler()
  const timeouts = makeTimeoutScheduler()
  const doc = makeMockDocument(false)
  const createdCanvases: MockCanvas[] = []
  const imageDatas: Array<{ data: Uint8ClampedArray; width: number; height: number }> = []

  const parseGIF = vi.fn(parsedProvider ?? ((): ParsedGif => makeFakeParsedGif(8, 8, 2)))
  const decompressFrames = vi.fn((gif: ParsedGif) => framesProvider(gif))

  const manager = new GifAnimationManager(fabricCanvas as unknown as FabricCanvas, {
    parseGIF: parseGIF as unknown as GifAnimationManagerOptions['parseGIF'],
    decompressFrames: decompressFrames as unknown as GifAnimationManagerOptions['decompressFrames'],
    scheduleAfterPaint: afterPaint.schedule,
    scheduleTimeout: timeouts.schedule,
    clearScheduledTimeout: timeouts.clear,
    documentRef: doc,
    createCanvas: (w, h) => {
      const c = makeMockCanvas(w, h)
      createdCanvases.push(c)
      return c as unknown as HTMLCanvasElement
    },
    createImageData: (data, width, height) => {
      const entry = { data, width, height }
      imageDatas.push(entry)
      return entry as unknown as ImageData
    },
    isLive: (mgr, img) =>
      img.canvas === mgr.canvas &&
      (mgr.canvas.getObjects() as unknown as MockFabricImage[]).includes(
        img as unknown as MockFabricImage
      ),
    now: () => 0,
    ...overrides
  })

  return {
    manager,
    fabricCanvas,
    afterPaint,
    timeouts,
    doc,
    parseGIF,
    decompressFrames,
    createdCanvases,
    imageDatas
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('isGifDataUrl', () => {
  it('accepts canonical base64 GIF data URLs', () => {
    expect(isGifDataUrl('data:image/gif;base64,AAAA')).toBe(true)
  })

  it('accepts case-mixed prefixes', () => {
    expect(isGifDataUrl('DATA:IMAGE/GIF;BASE64,AAAA')).toBe(true)
  })

  it('accepts extra parameters before base64', () => {
    expect(isGifDataUrl('data:image/gif;charset=utf-8;base64,AAAA')).toBe(true)
  })

  it('rejects non-base64 GIF data URLs', () => {
    expect(isGifDataUrl('data:image/gif,raw')).toBe(false)
  })

  it('rejects other MIME types', () => {
    expect(isGifDataUrl('data:image/png;base64,AAAA')).toBe(false)
    expect(isGifDataUrl('data:image/svg+xml;base64,AAAA')).toBe(false)
  })

  it('handles null/undefined/empty', () => {
    expect(isGifDataUrl(null)).toBe(false)
    expect(isGifDataUrl(undefined)).toBe(false)
    expect(isGifDataUrl('')).toBe(false)
  })
})

describe('GifAnimationManager scheduling', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('does not run heavy decode work synchronously in register()', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    const el = makeGifElement('a')

    h.manager.register(el, img as unknown as FabricImage)

    expect(h.parseGIF).not.toHaveBeenCalled()
    expect(h.decompressFrames).not.toHaveBeenCalled()
    expect(img.setElement).not.toHaveBeenCalled()
    expect(h.afterPaint.pending()).toBe(1)

    h.afterPaint.flush()

    expect(h.parseGIF).toHaveBeenCalledTimes(1)
    expect(h.decompressFrames).toHaveBeenCalledTimes(1)
    expect(img.setElement).toHaveBeenCalledTimes(1)
  })

  it('returns immediately from register() (fire-and-forget)', () => {
    const h = makeHarness(() => [makeFakeFrame({ width: 8, height: 8 })])
    const img = makeMockFabricImage(h.fabricCanvas)
    const result = h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    expect(result).toBeUndefined()
  })

  it('clamps low frame delays to MIN_DELAY_MS', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8, delay: 5 }),
      makeFakeFrame({ width: 8, height: 8, delay: 0 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    expect(h.timeouts.delays()[0]).toBe(20)
  })

  it('uses default delay when frame delay is missing or non-finite', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8, delay: NaN }),
      makeFakeFrame({ width: 8, height: 8, delay: 100 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    expect(h.timeouts.delays()[0]).toBe(100)
  })
})

describe('GifAnimationManager validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('rejects to static when logical dimensions are zero', () => {
    const h = makeHarness(
      () => [makeFakeFrame({ width: 0, height: 8 })],
      () => makeFakeParsedGif(0, 8, 1)
    )
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img.setElement).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('rejects to static when logical dimensions exceed 4096', () => {
    const h = makeHarness(
      () => [makeFakeFrame({ width: 4097, height: 8 })],
      () => makeFakeParsedGif(4097, 8, 1)
    )
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img.setElement).not.toHaveBeenCalled()
  })

  it('rejects to static when frame count exceeds 300', () => {
    const big = 400
    const h = makeHarness(
      () => Array.from({ length: big }, () => makeFakeFrame({ width: 8, height: 8 })),
      () => makeFakeParsedGif(8, 8, big)
    )
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img.setElement).not.toHaveBeenCalled()
    expect(h.decompressFrames).not.toHaveBeenCalled()
  })

  it('rejects to static when patch rect escapes logical bounds', () => {
    const h = makeHarness(
      () => [makeFakeFrame({ width: 8, height: 8, left: 5, top: 5 })],
      () => makeFakeParsedGif(8, 8, 1)
    )
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img.setElement).not.toHaveBeenCalled()
  })

  it('rejects oversize encoded data URLs', () => {
    // Injects a low ceiling so the test doesn't have to allocate a multi-MB
    // base64 string just to trigger the production guardrail.
    const h = makeHarness(
      () => [makeFakeFrame({ width: 8, height: 8 })],
      () => makeFakeParsedGif(8, 8, 1),
      { maxEncodedSizeBytes: 4 }
    )
    const img = makeMockFabricImage(h.fabricCanvas)
    const el: TwigElement = {
      ...makeGifElement('huge'),
      // base64 length 12 → approx 9 decoded bytes > 4 byte cap.
      src: `data:image/gif;base64,AAAAAAAAAAAA`
    }
    h.manager.register(el, img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(h.parseGIF).not.toHaveBeenCalled()
    expect(img.setElement).not.toHaveBeenCalled()
  })

  it('rejects when decode wallclock exceeds budget', () => {
    let nowVal = 0
    const h = makeHarness(
      () => [makeFakeFrame({ width: 8, height: 8 })],
      () => makeFakeParsedGif(8, 8, 1),
      { now: () => nowVal }
    )
    // Simulate elapsed > 2s by advancing the clock between parse and after-decode check.
    h.decompressFrames.mockImplementation(() => {
      nowVal = 3000
      return [makeFakeFrame({ width: 8, height: 8 })]
    })
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img.setElement).not.toHaveBeenCalled()
  })
})

describe('GifAnimationManager rendering and disposal', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('initializes frame 0 on the composite and recomputes scale', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    const el = makeGifElement('a', 64, 32)
    h.manager.register(el, img as unknown as FabricImage)
    h.afterPaint.flush()

    // Composite + scratch canvases allocated.
    expect(h.createdCanvases.length).toBe(2)
    const [composite, scratch] = h.createdCanvases
    expect(composite.width).toBe(8)
    expect(composite.height).toBe(8)
    expect(scratch.width).toBeGreaterThan(0)

    // Fabric image swapped to composite + scale recomputed.
    expect(img.setElement).toHaveBeenCalledWith(composite)
    expect(img.scaleX).toBe(64 / 8)
    expect(img.scaleY).toBe(32 / 8)
    expect(h.fabricCanvas.requestRenderAll).toHaveBeenCalled()
  })

  it('composites patches via scratch canvas (transparency-safe)', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 4, height: 4 }),
      makeFakeFrame({ width: 4, height: 4 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()

    const [composite, scratch] = h.createdCanvases
    // Composite ctx must have had drawImage called, not putImageData.
    const compositeOps = composite.ctx.calls.map((c) => c.op)
    expect(compositeOps).toContain('drawImage')
    expect(compositeOps).not.toContain('putImageData')
    // Scratch ctx must have had clearRect followed by putImageData.
    const scratchOps = scratch.ctx.calls.map((c) => c.op)
    expect(scratchOps[0]).toBe('clearRect')
    expect(scratchOps[1]).toBe('putImageData')
  })

  it('clears prior frame rect on disposal type 2', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 4, height: 4, left: 2, top: 2, disposalType: 2 }),
      makeFakeFrame({ width: 4, height: 4, left: 0, top: 0, disposalType: 0 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    // Capture composite call list before tick.
    const composite = h.createdCanvases[0]
    const callsBefore = composite.ctx.calls.length
    h.timeouts.fireAll()
    const newCalls = composite.ctx.calls.slice(callsBefore)
    // The disposal of frame 0 (rect 2,2 4x4) should run before drawImage for frame 1.
    const firstNew = newCalls[0]
    expect(firstNew.op).toBe('clearRect')
    expect(firstNew.args).toEqual([2, 2, 4, 4])
  })

  it('leaves prior pixels in place on disposal type 0/1', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 4, height: 4, disposalType: 1 }),
      makeFakeFrame({ width: 4, height: 4, disposalType: 0 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    const composite = h.createdCanvases[0]
    const before = composite.ctx.calls.length
    h.timeouts.fireAll()
    const newCalls = composite.ctx.calls.slice(before)
    // No clearRect should run before frame 1's drawImage.
    expect(newCalls[0].op).toBe('drawImage')
  })
})

describe('GifAnimationManager generation guard', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('aborts decode if reset() is called before scheduler fires', () => {
    const h = makeHarness(() => [makeFakeFrame({ width: 8, height: 8 })])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.manager.reset()
    h.afterPaint.flush()
    // Cancelled callbacks should not invoke the decoder, but even if they did,
    // the generation guard would skip them.
    expect(img.setElement).not.toHaveBeenCalled()
  })

  it('aborts ticks once the state generation no longer matches', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    const composite = h.createdCanvases[0]
    const callsBefore = composite.ctx.calls.length
    // Advance generation, then fire the timer.
    h.manager.reset()
    h.timeouts.fireAll()
    expect(composite.ctx.calls.length).toBe(callsBefore)
  })
})

describe('GifAnimationManager lifecycle', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('reset() cancels timers and clears states', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    expect(h.timeouts.size()).toBe(1)
    h.manager.reset()
    expect(h.timeouts.size()).toBe(0)
  })

  it('dispose() removes the visibility listener', () => {
    const h = makeHarness(() => [makeFakeFrame({ width: 8, height: 8 })])
    h.manager.dispose()
    h.doc.setHidden(true)
    // No throw + no state — manager is unusable but does not crash.
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img.setElement).not.toHaveBeenCalled()
  })

  it('start() does not schedule when document is hidden', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    h.doc.setHidden(true)
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    expect(h.timeouts.size()).toBe(0)
  })

  it('resumes scheduling on visibility return', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    h.doc.setHidden(true)
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    expect(h.timeouts.size()).toBe(0)
    h.doc.setHidden(false)
    expect(h.timeouts.size()).toBe(1)
  })

  it('repeated start() does not duplicate timers', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    h.manager.start()
    h.manager.start()
    expect(h.timeouts.size()).toBe(1)
  })

  it('stops playback when the Fabric image is removed from the canvas', () => {
    const h = makeHarness(() => [
      makeFakeFrame({ width: 8, height: 8 }),
      makeFakeFrame({ width: 8, height: 8 })
    ])
    const img = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img as unknown as FabricImage)
    h.afterPaint.flush()
    h.manager.start()
    expect(h.timeouts.size()).toBe(1)
    // Remove image from the canvas. The next tick should release the state.
    h.fabricCanvas.objects.length = 0
    h.timeouts.fireAll()
    expect(h.timeouts.size()).toBe(0)
  })
})

describe('GifAnimationManager memory budget', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('rejects GIFs that exceed the 64 MB budget at the preflight estimate', () => {
    // LSD 3500x3500x2 frames ≈ 98 MB worst-case preflight estimate, above the
    // 64 MB cap. Reject before decompressFrames is even called, so no big
    // allocations are needed in the mock.
    const W = 3500
    const H = 3500
    const h = makeHarness(
      () => {
        throw new Error('decompressFrames should not be called past preflight')
      },
      () => makeFakeParsedGif(W, H, 2)
    )
    const img1 = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a', W, H), img1 as unknown as FabricImage)
    h.afterPaint.flush()
    expect(h.decompressFrames).not.toHaveBeenCalled()
    expect(img1.setElement).not.toHaveBeenCalled()
  })

  it('cannot oversubscribe under concurrent registrations', () => {
    // 2100×2100 single-frame: composite ≈ 17.64 MB. Preflight =
    // 3×composite ≈ 53 MB, which fits. After reconcile, ~17.64 MB stays
    // committed. The second registration's preflight (~53 MB) plus the
    // first's committed (~17.64 MB) crosses the 64 MB budget.
    const W = 2100
    const H = 2100
    const smallPatch = new Uint8ClampedArray(4) // 1×1 patch placed inside logical bounds
    let call = 0
    const h = makeHarness(
      () => {
        call++
        // Patch dims 1×1 at (0,0): well inside 2000×2000 logical bounds. The
        // preflight reservation uses worst-case bytes; the actual reservation
        // shrinks during reconciliation but committed bytes still cover the
        // composite, which alone is 16 MB.
        return [makeFakeFrame({ width: 1, height: 1, left: 0, top: 0, patchBytes: smallPatch })]
      },
      () => makeFakeParsedGif(W, H, 1)
    )
    const img1 = makeMockFabricImage(h.fabricCanvas)
    const img2 = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a', W, H), img1 as unknown as FabricImage)
    h.manager.register(makeGifElement('b', W, H), img2 as unknown as FabricImage)
    h.afterPaint.flush()
    // First registration's preflight (48 MB) fits, decodes, commits its
    // (smaller, post-reconcile) actual. Second registration's preflight then
    // would push past 64 MB combined with the first's committed bytes.
    expect(img1.setElement).toHaveBeenCalled()
    expect(img2.setElement).not.toHaveBeenCalled()
    expect(call).toBe(1)
  })

  it('reset() frees memory so subsequent registrations succeed', () => {
    // Small GIF — fits within budget easily. Verify that after reset, a fresh
    // registration also succeeds (no leaked accounting).
    const h = makeHarness(() => [makeFakeFrame({ width: 8, height: 8 })])
    const img1 = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('a'), img1 as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img1.setElement).toHaveBeenCalled()
    h.manager.reset()
    const img2 = makeMockFabricImage(h.fabricCanvas)
    h.manager.register(makeGifElement('b'), img2 as unknown as FabricImage)
    h.afterPaint.flush()
    expect(img2.setElement).toHaveBeenCalled()
  })
})
