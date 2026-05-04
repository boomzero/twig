import type { TwigElement } from './types'

const SHAPE_TYPES = new Set<TwigElement['type']>(['rect', 'ellipse', 'triangle', 'star', 'arrow'])

export function isShapeElement(el: TwigElement): boolean {
  return SHAPE_TYPES.has(el.type)
}

export interface ShapeStyle {
  fill: string
  stroke: string | null
  strokeWidth: number
  strokeUniform: true
  paintFirst: 'stroke'
  objectCaching: false
  perPixelTargetFind: false
}

export function shapeStyle(el: TwigElement): ShapeStyle {
  const stroke = el.stroke && el.stroke !== 'transparent' ? el.stroke : undefined
  const strokeWidth = stroke ? (el.strokeWidth ?? 0) : 0

  return {
    fill: el.fill ?? '#FF6F61',
    stroke: stroke ?? null,
    strokeWidth,
    strokeUniform: true,
    paintFirst: 'stroke',
    objectCaching: false,
    perPixelTargetFind: false
  }
}
