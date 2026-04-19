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
})
