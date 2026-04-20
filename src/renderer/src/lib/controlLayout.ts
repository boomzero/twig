export type ControlLayoutInput = {
  widthPx: number
  heightPx: number
  isArrow: boolean
  /**
   * True when the object's Y scaling is locked (e.g. Fabric Textbox). Such
   * objects only expose width-resize + rotate handles — corners and mt/mb are
   * either inoperable or redundant and are hidden in every mode.
   */
  lockScalingY?: boolean
}

export type ControlLayout = {
  compact: boolean
  cornerSize: number
  touchCornerSize: number
  padding: number
  visibility: Record<string, boolean>
}

export const COMPACT_CONTROL_THRESHOLD_PX = 48
export const DEFAULT_CORNER_SIZE = 13
export const COMPACT_CORNER_SIZE = 9
export const DEFAULT_TOUCH_CORNER_SIZE = 24
export const DEFAULT_CONTROL_PADDING = 0
export const COMPACT_CONTROL_PADDING = 4

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.abs(value) : Infinity
}

export function resolveControlLayout({
  widthPx,
  heightPx,
  isArrow,
  lockScalingY = false
}: ControlLayoutInput): ControlLayout {
  const minDimension = Math.min(normalizeDimension(widthPx), normalizeDimension(heightPx))
  const compact = minDimension < COMPACT_CONTROL_THRESHOLD_PX

  const visibility: Record<string, boolean> = lockScalingY
    ? {
        // Height is locked, so only width-resize and rotate handles are
        // meaningful. Hide mt/mb (inoperable) and corners (redundant with
        // ml/mr, and misleading because they cannot scale height).
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
    : {
        tl: true,
        tr: true,
        bl: true,
        br: true,
        mtr: true,
        ml: !compact,
        mr: !compact,
        mt: !compact,
        mb: !compact
      }

  if (isArrow) {
    visibility.arrowHead = !compact
    visibility.arrowShaft = !compact
  }

  return {
    compact,
    cornerSize: compact ? COMPACT_CORNER_SIZE : DEFAULT_CORNER_SIZE,
    touchCornerSize: DEFAULT_TOUCH_CORNER_SIZE,
    padding: compact ? COMPACT_CONTROL_PADDING : DEFAULT_CONTROL_PADDING,
    visibility
  }
}
