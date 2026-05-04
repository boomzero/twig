import { Control, Point, Polygon, util, type FabricObject } from 'fabric'
import { DEFAULT_ARROW_SHAPE, type ArrowShape, type TwigElement } from './types'

export { DEFAULT_ARROW_SHAPE } from './types'

export const ARROW_HEAD_ACTION = 'arrowHeadAdjust'
export const ARROW_SHAFT_ACTION = 'arrowShaftAdjust'
export const ARROW_HEAD_CONTROL_KEY = 'arrowHead'
export const ARROW_SHAFT_CONTROL_KEY = 'arrowShaft'
export const STAR_CANONICAL_W = 200
export const STAR_CANONICAL_H = 200

export interface ArrowHandleDeps {
  getElement: (id: string) => TwigElement | undefined
  isReadOnly: () => boolean
  pushCheckpoint: () => void
  scheduleSave: () => void
  scheduleThumbnailCapture: () => void
  renderAdjustmentDiamond: (ctx: CanvasRenderingContext2D, left: number, top: number) => void
}

export function setArrowPolygonBox(poly: Polygon, width: number, height: number): void {
  poly.set({ width, height, scaleX: 1, scaleY: 1, dirty: true })
  poly.pathOffset = new Point(width / 2, height / 2)
}

// Arrow: 7-point right-pointing block arrow parameterized by three ratios.
// Point order matches the legacy (pre-parameterization) order (CCW from the
// top-left of the shaft). Indices (used by adjustment-handle positionHandlers):
//   0: left-top of shaft       (0,       shaftTop)
//   1: right-top of shaft      (w-headL, shaftTop)
//   2: head base top           (w-headL, headTop )   junction handle anchor
//   3: tip                     (w,       h/2     )
//   4: head base bottom        (w-headL, headBot )
//   5: right-bottom of shaft   (w-headL, shaftBot)
//   6: left-bottom of shaft    (0,       shaftBot)
export function makeArrowPoints(
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
 */
export function ensureArrowShape(el: TwigElement): void {
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
 * element's nominal bounding box.
 */
export function applyArrowGeometry(obj: Polygon, el: TwigElement): void {
  const shape = el.arrowShape ?? DEFAULT_ARROW_SHAPE
  const w = Math.abs(el.width)
  const h = Math.abs(el.height)
  obj.set({
    points: makeArrowPoints(w, h, shape),
    dirty: true
  })
  setArrowPolygonBox(obj, w, h)
  obj.setCoords()
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function installArrowAdjustmentHandles(
  obj: Polygon,
  el: TwigElement,
  deps: ArrowHandleDeps
): void {
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

  const getElement = (): TwigElement | undefined => {
    return deps.getElement(ownerId)
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
    if (deps.isReadOnly()) return false
    const poly = transform.target as Polygon
    const element = getElement()
    if (!element || element.type !== 'arrow') return false
    const w = element.width
    const h = element.height
    if (w <= 0 || h <= 0) return false
    const lp = localPointerOnPoly(poly, x, y)
    const newHeadLen = clamp(1 - lp.x / w, 0.05, 0.95)
    // Keep this clamp in sync with PropertiesPanel's headWidth input bounds
    // (5%-100%) so an arrow authored through the panel round-trips through
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
    if (deps.isReadOnly()) return false
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
    if (deps.isReadOnly()) return false
    deps.pushCheckpoint()
    return true
  }

  const mouseUpHandler = (): boolean => {
    if (deps.isReadOnly()) return false
    deps.scheduleSave()
    deps.scheduleThumbnailCapture()
    return true
  }

  const diamondRender = (ctx: CanvasRenderingContext2D, left: number, top: number): void => {
    deps.renderAdjustmentDiamond(ctx, left, top)
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
// Raw points are normalized to an exact 200x200 bounding box so that
// STAR_CANONICAL_W/H are always precisely 200.
export function makeStarPoints(): Array<{ x: number; y: number }> {
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
