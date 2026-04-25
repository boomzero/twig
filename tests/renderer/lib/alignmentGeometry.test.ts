import { describe, expect, it, vi } from 'vitest'
import { Point, type FabricObject } from 'fabric'

import {
  getObjectAlignmentGeometry,
  resolveTextboxHorizontalBounds
} from '@renderer/lib/alignment-guides/geometry'
import { collectLine } from '@renderer/lib/alignment-guides/vendor/util/collect-line'

describe('src/renderer/src/lib/alignment-guides/geometry.ts', () => {
  describe('resolveTextboxHorizontalBounds', () => {
    it('uses the measured line width for left-aligned text', () => {
      expect(
        resolveTextboxHorizontalBounds({
          width: 300,
          height: 40,
          lineWidths: [90],
          lineOffsets: [0]
        })
      ).toEqual({ left: -150, right: -60, top: -20, bottom: 20 })
    })

    it('uses line offsets for centered text', () => {
      expect(
        resolveTextboxHorizontalBounds({
          width: 300,
          height: 40,
          lineWidths: [90],
          lineOffsets: [105]
        })
      ).toEqual({ left: -45, right: 45, top: -20, bottom: 20 })
    })

    it('uses line offsets for right-aligned text', () => {
      expect(
        resolveTextboxHorizontalBounds({
          width: 300,
          height: 40,
          lineWidths: [90],
          lineOffsets: [210]
        })
      ).toEqual({ left: 60, right: 150, top: -20, bottom: 20 })
    })

    it('handles RTL-style offsets using the right text anchor', () => {
      expect(
        resolveTextboxHorizontalBounds({
          width: 300,
          height: 40,
          lineWidths: [90],
          lineOffsets: [-210],
          direction: 'rtl'
        })
      ).toEqual({ left: -150, right: -60, top: -20, bottom: 20 })
    })

    it('uses the union of wrapped line bounds', () => {
      expect(
        resolveTextboxHorizontalBounds({
          width: 200,
          height: 80,
          lineWidths: [40, 120, 60],
          lineOffsets: [0, 0, 70]
        })
      ).toEqual({ left: -100, right: 30, top: -40, bottom: 40 })
    })

    it('uses measured justified widths without special casing justification', () => {
      expect(
        resolveTextboxHorizontalBounds({
          width: 300,
          height: 60,
          lineWidths: [300, 60],
          lineOffsets: [0, 0]
        })
      ).toEqual({ left: -150, right: 150, top: -30, bottom: 30 })
    })
  })

  it('returns transformed textbox guide corners plus center', () => {
    const textbox = {
      type: 'textbox',
      isType: (type: string) => type === 'textbox',
      width: 100,
      height: 20,
      _textLines: [['Hello']],
      direction: 'ltr',
      getLineWidth: () => 40,
      _getLineLeftOffset: () => 10,
      calcTransformMatrix: () => [0, 1, -1, 0, 100, 50]
    } as unknown as FabricObject

    const { guidePoints, boundingRect } = getObjectAlignmentGeometry(textbox)

    expect(guidePoints.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 110, y: 10 },
      { x: 110, y: 50 },
      { x: 90, y: 50 },
      { x: 90, y: 10 },
      { x: 100, y: 30 }
    ])
    expect(boundingRect).toEqual({ left: 90, top: 10, width: 20, height: 40 })
  })

  it('uses Fabric char bounds when cached line widths are stale after justification', () => {
    const textbox = {
      type: 'textbox',
      isType: (type: string) => type === 'textbox',
      width: 120,
      height: 20,
      _textLines: [['j', 'u', 's', 't', 'i', 'f', 'y']],
      __charBounds: [
        [
          { left: 0, width: 10 },
          { left: 120, width: 0 }
        ]
      ],
      direction: 'ltr',
      getLineWidth: () => 80,
      _getLineLeftOffset: () => 0,
      calcTransformMatrix: () => [1, 0, 0, 1, 0, 0]
    } as unknown as FabricObject

    const { guidePoints } = getObjectAlignmentGeometry(textbox)

    expect(guidePoints.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: -60, y: -10 },
      { x: 60, y: -10 },
      { x: 60, y: 10 },
      { x: -60, y: 10 },
      { x: 0, y: 0 }
    ])
  })

  it('trims Fabric trailing char spacing from char-bound rendered widths', () => {
    const textbox = {
      type: 'textbox',
      isType: (type: string) => type === 'textbox',
      width: 300,
      height: 40,
      _textLines: [['H', 'e', 'l', 'l', 'o']],
      __charBounds: [
        [
          { left: 0, width: 24 },
          { left: 109, width: 0 }
        ]
      ],
      direction: 'ltr',
      getLineWidth: () => 105,
      _getLineLeftOffset: () => 0,
      _getWidthOfCharSpacing: () => 4,
      calcTransformMatrix: () => [1, 0, 0, 1, 0, 0]
    } as unknown as FabricObject

    const { guidePoints } = getObjectAlignmentGeometry(textbox)

    expect(guidePoints.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: -150, y: -20 },
      { x: -45, y: -20 },
      { x: -45, y: 20 },
      { x: -150, y: 20 },
      { x: -97.5, y: 0 }
    ])
  })

  it('preserves Fabric geometry for non-text objects', () => {
    const coords = [new Point(1, 2), new Point(11, 2), new Point(11, 7), new Point(1, 7)]
    const center = new Point(6, 4.5)
    const rect = { left: 1, top: 2, width: 10, height: 5 }
    const object = {
      type: 'rect',
      isType: () => false,
      getCoords: () => [...coords],
      getCenterPoint: () => center,
      getBoundingRect: () => rect
    } as unknown as FabricObject

    const geometry = getObjectAlignmentGeometry(object)

    expect(geometry.guidePoints).toEqual([...coords, center])
    expect(geometry.boundingRect).toBe(rect)
  })

  it('keeps the alignment guide instance bound while applying move snaps', () => {
    const target = {
      setCoords: vi.fn()
    } as unknown as FabricObject
    const applyTargetGuidePointSnap = vi.fn()
    const guidePoint = new Point(10, 20)
    const snapPoint = new Point(12, 20)
    const controller = {
      canvas: { getZoom: () => 1 },
      margin: 6,
      getGuidePoints: () => [guidePoint],
      applyTargetGuidePointSnap
    }

    const result = collectLine.call(controller, target, [snapPoint])

    expect(applyTargetGuidePointSnap).toHaveBeenCalledWith(
      target,
      new Point(12, 20),
      ['left', 'top'],
      new Point(2, 0),
      0
    )
    expect(target.setCoords).toHaveBeenCalled()
    expect(result.vLines).toEqual([{ origin: new Point(12, 20), target: snapPoint }])
  })
})
