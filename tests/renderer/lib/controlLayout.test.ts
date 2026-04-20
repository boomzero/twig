import { describe, expect, it } from 'vitest'
import {
  COMPACT_CONTROL_PADDING,
  COMPACT_CONTROL_THRESHOLD_PX,
  COMPACT_CORNER_SIZE,
  DEFAULT_CONTROL_PADDING,
  DEFAULT_CORNER_SIZE,
  DEFAULT_TOUCH_CORNER_SIZE,
  resolveControlLayout
} from '@renderer/lib/controlLayout'

describe('src/renderer/src/lib/controlLayout.ts', () => {
  it('uses compact controls below the threshold for non-arrow objects', () => {
    expect(resolveControlLayout({ widthPx: 47, heightPx: 120, isArrow: false })).toEqual({
      compact: true,
      cornerSize: COMPACT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: COMPACT_CONTROL_PADDING,
      visibility: {
        tl: true,
        tr: true,
        bl: true,
        br: true,
        mtr: true,
        ml: false,
        mr: false,
        mt: false,
        mb: false
      }
    })
  })

  it('keeps default controls at and above the threshold', () => {
    expect(
      resolveControlLayout({
        widthPx: COMPACT_CONTROL_THRESHOLD_PX,
        heightPx: 80,
        isArrow: false
      })
    ).toEqual({
      compact: false,
      cornerSize: DEFAULT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: DEFAULT_CONTROL_PADDING,
      visibility: {
        tl: true,
        tr: true,
        bl: true,
        br: true,
        mtr: true,
        ml: true,
        mr: true,
        mt: true,
        mb: true
      }
    })
  })

  it('can decide compact mode from width alone when height is effectively unconstrained', () => {
    expect(resolveControlLayout({ widthPx: 47, heightPx: Infinity, isArrow: false })).toEqual({
      compact: true,
      cornerSize: COMPACT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: COMPACT_CONTROL_PADDING,
      visibility: {
        tl: true,
        tr: true,
        bl: true,
        br: true,
        mtr: true,
        ml: false,
        mr: false,
        mt: false,
        mb: false
      }
    })
  })

  it('hides arrow adjustment controls in compact mode', () => {
    expect(resolveControlLayout({ widthPx: 24, heightPx: 30, isArrow: true })).toEqual({
      compact: true,
      cornerSize: COMPACT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: COMPACT_CONTROL_PADDING,
      visibility: {
        tl: true,
        tr: true,
        bl: true,
        br: true,
        mtr: true,
        ml: false,
        mr: false,
        mt: false,
        mb: false,
        arrowHead: false,
        arrowShaft: false
      }
    })
  })

  it('restores arrow adjustment controls in default mode', () => {
    expect(resolveControlLayout({ widthPx: 100, heightPx: 60, isArrow: true })).toEqual({
      compact: false,
      cornerSize: DEFAULT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: DEFAULT_CONTROL_PADDING,
      visibility: {
        tl: true,
        tr: true,
        bl: true,
        br: true,
        mtr: true,
        ml: true,
        mr: true,
        mt: true,
        mb: true,
        arrowHead: true,
        arrowShaft: true
      }
    })
  })

  it('keeps width-resize handles visible for lockScalingY objects even when height is compact', () => {
    // Single-line textbox at a small font — height drops below the compact
    // threshold but width is normal. ml/mr must stay visible or the user has
    // no way to resize width on canvas.
    expect(
      resolveControlLayout({ widthPx: 400, heightPx: 30, isArrow: false, lockScalingY: true })
    ).toEqual({
      compact: true,
      cornerSize: COMPACT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: COMPACT_CONTROL_PADDING,
      visibility: {
        tl: false,
        tr: false,
        bl: false,
        br: false,
        mtr: true,
        ml: true,
        mr: true,
        mt: false,
        mb: false
      }
    })
  })

  it('hides corner and mt/mb handles for lockScalingY objects in default mode too', () => {
    expect(
      resolveControlLayout({ widthPx: 600, heightPx: 120, isArrow: false, lockScalingY: true })
    ).toEqual({
      compact: false,
      cornerSize: DEFAULT_CORNER_SIZE,
      touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
      padding: DEFAULT_CONTROL_PADDING,
      visibility: {
        tl: false,
        tr: false,
        bl: false,
        br: false,
        mtr: true,
        ml: true,
        mr: true,
        mt: false,
        mb: false
      }
    })
  })
})
