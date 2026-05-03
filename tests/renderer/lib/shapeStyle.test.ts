import { describe, expect, it } from 'vitest'
import { shapeStyle } from '@renderer/lib/shapeStyle'
import type { TwigElement } from '@renderer/lib/types'

function makeShape(overrides: Partial<TwigElement> = {}): TwigElement {
  return {
    id: 'rect-1',
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    zIndex: 0,
    ...overrides
  }
}

describe('src/renderer/src/lib/shapeStyle.ts', () => {
  it('uses default fill and no visible stroke for legacy shapes', () => {
    expect(shapeStyle(makeShape())).toEqual({
      fill: '#FF6F61',
      stroke: null,
      strokeWidth: 0,
      strokeUniform: true,
      paintFirst: 'stroke',
      objectCaching: false,
      perPixelTargetFind: false
    })
  })

  it('maps transparent stroke to no visible stroke', () => {
    expect(shapeStyle(makeShape({ stroke: 'transparent', strokeWidth: 8 }))).toMatchObject({
      stroke: null,
      strokeWidth: 0
    })
  })

  it('preserves transparent fill and real stroke styling', () => {
    expect(
      shapeStyle(
        makeShape({
          fill: 'transparent',
          stroke: '#111827',
          strokeWidth: 4
        })
      )
    ).toEqual({
      fill: 'transparent',
      stroke: '#111827',
      strokeWidth: 4,
      strokeUniform: true,
      paintFirst: 'stroke',
      objectCaching: false,
      perPixelTargetFind: false
    })
  })

  it('defaults real stroke width to 0 when unset', () => {
    expect(shapeStyle(makeShape({ stroke: '#111827' }))).toMatchObject({
      stroke: '#111827',
      strokeWidth: 0
    })
  })
})
