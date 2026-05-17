import type { TwigElement } from './types'

export interface TwigClipboardPayload {
  __twig_clipboard__: true
  copyId: string
  elements: TwigElement[]
}

type TwigElementType = TwigElement['type']

const TWIG_ELEMENT_TYPES: ReadonlySet<TwigElementType> = new Set([
  'rect',
  'ellipse',
  'triangle',
  'star',
  'arrow',
  'text',
  'image',
  'math'
])

function isTwigElement(value: unknown): value is TwigElement {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  const type = e.type
  if (typeof e.id !== 'string') return false
  if (typeof type !== 'string' || !TWIG_ELEMENT_TYPES.has(type as TwigElementType)) return false
  if (typeof e.x !== 'number' || typeof e.y !== 'number') return false
  if (typeof e.width !== 'number' || typeof e.height !== 'number') return false
  if (typeof e.angle !== 'number' || typeof e.zIndex !== 'number') return false
  if (e.stroke !== undefined && typeof e.stroke !== 'string') return false
  if (e.strokeWidth !== undefined && typeof e.strokeWidth !== 'number') return false
  if (type === 'image' && typeof e.src !== 'string') return false
  if (type === 'math') {
    // `latex` is the source of truth; `src` is optional on the clipboard
    // (external producers may omit it — paste re-renders via MathJax).
    if (typeof e.latex !== 'string') return false
    if (e.src !== undefined && typeof e.src !== 'string') return false
  }
  return true
}

export function serializeElementsForClipboard(args: {
  elements: TwigElement[]
  imageSrcOf: (id: string) => string | undefined
  idFactory: () => string
}): string {
  const elements = args.elements.map((el) => ({
    ...el,
    src:
      el.type === 'image' || el.type === 'math'
        ? (args.imageSrcOf(el.id) ?? el.src)
        : undefined
  }))
  const payload: TwigClipboardPayload = {
    __twig_clipboard__: true,
    copyId: args.idFactory(),
    elements
  }
  return JSON.stringify(payload)
}

export function parseClipboardPayload(raw: string): TwigElement[] | null {
  let parsed: { __twig_clipboard__?: boolean; elements?: unknown[] } = {}
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed.__twig_clipboard__ || !Array.isArray(parsed.elements)) {
    return null
  }
  return parsed.elements.filter(isTwigElement)
}

export function cloneElementsForPaste(args: {
  elements: TwigElement[]
  baseZ: number
  offset: number
  canvasW: number
  canvasH: number
  idFactory: () => string
  registerImageSrc: (newId: string, src: string) => void
  ensureArrowShape: (el: TwigElement) => void
}): TwigElement[] {
  const sortedElements = [...args.elements].sort((a, b) => a.zIndex - b.zIndex)
  return sortedElements.map((el, i) => {
    const prefix = el.id.split('_')[0] ?? el.type
    const newId = `${prefix}_${args.idFactory()}`
    if ((el.type === 'image' || el.type === 'math') && el.src) {
      args.registerImageSrc(newId, el.src)
    }
    // Clamp so repeated pastes don't walk elements off canvas.
    const x = Math.min(el.x + args.offset, args.canvasW - 1)
    const y = Math.min(el.y + args.offset, args.canvasH - 1)
    const cloned: TwigElement = {
      ...el,
      id: newId,
      x,
      y,
      zIndex: args.baseZ + i,
      animations: undefined
    }
    args.ensureArrowShape(cloned)
    return cloned
  })
}
