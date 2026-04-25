import type { Canvas, FabricObject, TOriginX, TOriginY } from 'fabric'
import { Point } from 'fabric'
import { getObjectAlignmentGeometry, isTextboxObject } from './geometry'
import { AligningGuidelines } from './vendor/index'

export type InstallOptions = {
  isEnabled: () => boolean
}

type MaybeNativeEvent = { metaKey?: boolean; ctrlKey?: boolean }
type TransformLike = { e?: MaybeNativeEvent; target?: FabricObject }

export class TwigAligningGuidelines extends AligningGuidelines {
  private opts: InstallOptions
  spacingTicks: Point[] = []

  constructor(canvas: Canvas, opts: InstallOptions) {
    super(canvas, {
      color: '#ffcc00',
      width: 1,
      margin: 6
    })
    this.opts = opts
  }

  private shouldBypass(e: TransformLike): boolean {
    if (!this.opts.isEnabled()) return true
    const native = e.e
    if (native && (native.metaKey || native.ctrlKey)) return true
    const target = e.target
    if (target && target.selectable === false && target.evented === false) return true
    return false
  }

  private clearAllState(): void {
    this.verticalLines.clear()
    this.horizontalLines.clear()
    this.spacingTicks = []
    this.cacheMap.clear()
    this.canvas.requestRenderAll()
  }

  moving(e: Parameters<AligningGuidelines['moving']>[0]): void {
    if (this.shouldBypass(e as TransformLike)) {
      this.clearAllState()
      return
    }
    this.spacingTicks = []
    super.moving(e)
    const target = (e as TransformLike).target
    if (target) this.collectSpacingHints(target)
  }

  scalingOrResizing(e: Parameters<AligningGuidelines['scalingOrResizing']>[0]): void {
    if (this.shouldBypass(e as TransformLike)) {
      this.clearAllState()
      return
    }
    this.spacingTicks = []
    super.scalingOrResizing(e)
  }

  mouseUp(): void {
    super.mouseUp()
    this.spacingTicks = []
  }

  getObjectsByTarget(target: FabricObject): Set<FabricObject> {
    const base = super.getObjectsByTarget(target)
    const filtered = new Set<FabricObject>()
    for (const o of base) {
      // Non-interactive overlay chrome (e.g. future locked background layers)
      if (o.selectable === false && o.evented === false) continue
      filtered.add(o)
    }
    return filtered
  }

  getExtraSnapPoints(): Point[] {
    const w = this.canvas.width ?? 0
    const h = this.canvas.height ?? 0
    return [
      new Point(0, 0),
      new Point(w, 0),
      new Point(w, h),
      new Point(0, h),
      new Point(w / 2, h / 2),
      new Point(w / 2, 0),
      new Point(w / 2, h),
      new Point(0, h / 2),
      new Point(w, h / 2)
    ]
  }

  getGuidePoints(object: FabricObject): Point[] {
    return getObjectAlignmentGeometry(object).guidePoints
  }

  shouldCacheGuidePoints(object: FabricObject): boolean {
    return !isTextboxObject(object)
  }

  applyTargetGuidePointSnap(
    target: FabricObject,
    point: Point,
    origin: [TOriginX, TOriginY],
    delta: Point
  ): void {
    if (isTextboxObject(target)) {
      target.setXY(target.getXY().add(delta))
      return
    }

    super.applyTargetGuidePointSnap(target, point, origin, delta, 0)
  }

  // Guard: Fabric fires before:render from both main-canvas renderAll() and
  // offscreen toCanvasElement()/toDataURL() paths. In the latter, contextTop is
  // not involved in the output, and on some code paths (e.g. after dispose)
  // this.canvas.contextTop is undefined. Skip the clear when it is.
  beforeRender(): void {
    if (!this.canvas.contextTop) return
    super.beforeRender()
  }

  afterRender(): void {
    if (!this.canvas.contextTop) return
    super.afterRender()
    if (this.spacingTicks.length === 0) return
    const ctx = this.canvas.getTopContext()
    const vt = this.canvas.viewportTransform
    const zoom = this.canvas.getZoom()
    ctx.save()
    ctx.transform(...vt)
    ctx.lineWidth = this.width / zoom
    ctx.strokeStyle = this.color
    for (const p of this.spacingTicks) this.drawX(p, 0)
    ctx.restore()
  }

  private collectSpacingHints(target: FabricObject): void {
    const siblings = this.getObjectsByTarget(target)
    if (siblings.size === 0) return

    const tr = getObjectAlignmentGeometry(target).boundingRect
    const tLeft = tr.left
    const tRight = tr.left + tr.width
    const tTop = tr.top
    const tBottom = tr.top + tr.height
    const tCenterX = tr.left + tr.width / 2
    const tCenterY = tr.top + tr.height / 2
    const margin = this.margin / this.canvas.getZoom()

    type Info = { left: number; right: number; top: number; bottom: number }
    const infos: Info[] = []
    for (const o of siblings) {
      const r = getObjectAlignmentGeometry(o).boundingRect
      infos.push({
        left: r.left,
        right: r.left + r.width,
        top: r.top,
        bottom: r.top + r.height
      })
    }

    // Horizontal: nearest non-overlapping neighbors to the left and right whose
    // vertical span overlaps the target's.
    const horizCandidates = infos.filter((i) => i.bottom > tTop && i.top < tBottom)
    const leftNeighbors = horizCandidates
      .filter((i) => i.right <= tLeft + margin)
      .sort((a, b) => b.right - a.right)
    const rightNeighbors = horizCandidates
      .filter((i) => i.left >= tRight - margin)
      .sort((a, b) => a.left - b.left)
    const leftN = leftNeighbors[0]
    const rightN = rightNeighbors[0]
    if (leftN && rightN) {
      const gapL = tLeft - leftN.right
      const gapR = rightN.left - tRight
      if (Math.abs(gapL - gapR) < margin && gapL > 0 && gapR > 0) {
        this.spacingTicks.push(
          new Point(leftN.right + gapL / 2, tCenterY),
          new Point(tRight + gapR / 2, tCenterY)
        )
      }
    }

    // Vertical
    const vertCandidates = infos.filter((i) => i.right > tLeft && i.left < tRight)
    const topNeighbors = vertCandidates
      .filter((i) => i.bottom <= tTop + margin)
      .sort((a, b) => b.bottom - a.bottom)
    const botNeighbors = vertCandidates
      .filter((i) => i.top >= tBottom - margin)
      .sort((a, b) => a.top - b.top)
    const topN = topNeighbors[0]
    const botN = botNeighbors[0]
    if (topN && botN) {
      const gapT = tTop - topN.bottom
      const gapB = botN.top - tBottom
      if (Math.abs(gapT - gapB) < margin && gapT > 0 && gapB > 0) {
        this.spacingTicks.push(
          new Point(tCenterX, topN.bottom + gapT / 2),
          new Point(tCenterX, tBottom + gapB / 2)
        )
      }
    }
  }
}

// Rotation snapping is driven by Fabric's per-object snapAngle/snapThreshold,
// not by AligningGuidelines. Mirror the modifier-key / global-toggle bypass for
// rotation by toggling those props on the active target during the gesture.
const SNAP_ANGLE = 15
const SNAP_THRESHOLD = 7

type RotatingEvent = { target?: FabricObject; e?: MaybeNativeEvent }

export function installAlignmentGuides(canvas: Canvas, opts: InstallOptions): { dispose(): void } {
  const instance = new TwigAligningGuidelines(canvas, opts)

  const onRotating = (e: RotatingEvent): void => {
    const target = e.target
    if (!target) return
    const native = e.e
    const bypass = !opts.isEnabled() || !!(native && (native.metaKey || native.ctrlKey))
    target.snapAngle = bypass ? 0 : SNAP_ANGLE
    target.snapThreshold = bypass ? 0 : SNAP_THRESHOLD
  }
  const onMouseUp = (): void => {
    const active = canvas.getActiveObject()
    if (!active) return
    active.snapAngle = SNAP_ANGLE
    active.snapThreshold = SNAP_THRESHOLD
  }
  canvas.on('object:rotating', onRotating)
  canvas.on('mouse:up', onMouseUp)

  return {
    dispose: () => {
      canvas.off('object:rotating', onRotating)
      canvas.off('mouse:up', onMouseUp)
      instance.dispose()
    }
  }
}
