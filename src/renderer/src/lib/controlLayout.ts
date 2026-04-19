export type ControlLayoutInput = {
  widthPx: number
  heightPx: number
  isArrow: boolean
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
  isArrow
}: ControlLayoutInput): ControlLayout {
  const minDimension = Math.min(normalizeDimension(widthPx), normalizeDimension(heightPx))
  const compact = minDimension < COMPACT_CONTROL_THRESHOLD_PX

  const visibility: Record<string, boolean> = {
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
