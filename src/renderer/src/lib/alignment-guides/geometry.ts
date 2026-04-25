import { Point, type FabricObject } from 'fabric'

export type AlignmentRect = {
  left: number
  top: number
  width: number
  height: number
}

export type LocalAlignmentBounds = {
  left: number
  right: number
  top: number
  bottom: number
}

export type TextboxHorizontalBoundsInput = {
  width: number
  height: number
  lineWidths: number[]
  lineOffsets: number[]
  direction?: string
}

export type ObjectAlignmentGeometry = {
  guidePoints: Point[]
  boundingRect: AlignmentRect
}

type TextboxAlignmentSource = FabricObject & {
  _textLines?: unknown[]
  __textLines?: unknown[]
  __charBounds?: Array<Array<{ left?: number; width?: number }>>
  direction?: string
  getLineWidth?: (lineIndex: number) => number
  _getLineLeftOffset?: (lineIndex: number) => number
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nonNegativeFiniteNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value))
}

export function resolveTextboxHorizontalBounds(
  input: TextboxHorizontalBoundsInput
): LocalAlignmentBounds {
  const width = finiteNumber(input.width)
  const height = finiteNumber(input.height)
  const anchorX = input.direction === 'rtl' ? width / 2 : -width / 2
  const lineCount = Math.max(input.lineWidths.length, input.lineOffsets.length)
  const top = -height / 2
  const bottom = height / 2

  if (lineCount === 0) {
    return { left: 0, right: 0, top, bottom }
  }

  let left = Infinity
  let right = -Infinity

  for (let i = 0; i < lineCount; i += 1) {
    const lineWidth = nonNegativeFiniteNumber(input.lineWidths[i])
    const lineOffset = finiteNumber(input.lineOffsets[i])
    const lineLeft =
      input.direction === 'rtl' ? anchorX + lineOffset - lineWidth : anchorX + lineOffset
    const lineRight = input.direction === 'rtl' ? anchorX + lineOffset : lineLeft + lineWidth

    left = Math.min(left, lineLeft, lineRight)
    right = Math.max(right, lineLeft, lineRight)
  }

  return { left, right, top, bottom }
}

export function isTextboxObject(object: FabricObject): boolean {
  if (typeof object.isType === 'function') return object.isType('textbox')
  return object.type === 'textbox'
}

export function getDefaultObjectGuidePoints(object: FabricObject): Point[] {
  const value = object.getCoords()
  value.push(object.getCenterPoint())
  return value
}

export function getAxisAlignedRectFromPoints(points: Point[]): AlignmentRect {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  }
}

function getTextboxLineMetrics(
  target: TextboxAlignmentSource
): TextboxHorizontalBoundsInput | null {
  const textLines = Array.isArray(target._textLines) ? target._textLines : target.__textLines
  if (
    !Array.isArray(textLines) ||
    typeof target.getLineWidth !== 'function' ||
    typeof target._getLineLeftOffset !== 'function'
  ) {
    return null
  }

  const lineWidths: number[] = []
  const lineOffsets: number[] = []

  try {
    for (let i = 0; i < textLines.length; i += 1) {
      lineWidths.push(getRenderedLineWidth(target, i))
      lineOffsets.push(target._getLineLeftOffset(i))
    }
  } catch {
    return null
  }

  return {
    width: finiteNumber(target.width),
    height: finiteNumber(target.height),
    lineWidths,
    lineOffsets,
    direction: target.direction
  }
}

function getRenderedLineWidth(target: TextboxAlignmentSource, lineIndex: number): number {
  const charBounds = target.__charBounds?.[lineIndex]
  const advance = charBounds?.[charBounds.length - 1]?.left
  if (typeof advance === 'number' && Number.isFinite(advance)) return Math.max(0, advance)
  return target.getLineWidth?.(lineIndex) ?? 0
}

function getTextboxAlignmentGeometry(object: FabricObject): ObjectAlignmentGeometry | null {
  if (!isTextboxObject(object)) return null

  const metrics = getTextboxLineMetrics(object as TextboxAlignmentSource)
  if (!metrics) return null

  const bounds = resolveTextboxHorizontalBounds(metrics)
  const matrix = object.calcTransformMatrix()
  const localCenterX = (bounds.left + bounds.right) / 2
  const localCenterY = (bounds.top + bounds.bottom) / 2
  const guidePoints = [
    new Point(bounds.left, bounds.top).transform(matrix),
    new Point(bounds.right, bounds.top).transform(matrix),
    new Point(bounds.right, bounds.bottom).transform(matrix),
    new Point(bounds.left, bounds.bottom).transform(matrix),
    new Point(localCenterX, localCenterY).transform(matrix)
  ]

  return {
    guidePoints,
    boundingRect: getAxisAlignedRectFromPoints(guidePoints.slice(0, 4))
  }
}

export function getObjectAlignmentGeometry(object: FabricObject): ObjectAlignmentGeometry {
  const textboxGeometry = getTextboxAlignmentGeometry(object)
  if (textboxGeometry) return textboxGeometry

  return {
    guidePoints: getDefaultObjectGuidePoints(object),
    boundingRect: object.getBoundingRect()
  }
}
