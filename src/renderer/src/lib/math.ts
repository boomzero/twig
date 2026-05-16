/**
 * MathJax (TeX → SVG) wrapper for math elements.
 *
 * Only the editor renderer should import this — the presentation window and
 * file-load paths read the prerendered SVG out of `element.src` and never
 * touch MathJax. The MathJax library itself is loaded via dynamic `import()`
 * on the first call so the editor's initial bundle isn't bloated.
 */

import { normalizeSvgDataUrl } from './svg'

export type RenderedMath = {
  /** SVG image data URI (base64-encoded). */
  src: string
  /** Natural width in pixels of the rendered equation. */
  width: number
  /** Natural height in pixels of the rendered equation. */
  height: number
}

export type RenderResult = { ok: true; rendered: RenderedMath } | { ok: false; error: string }

// MathJax's exposed types are awkward to import precisely — typing the
// document as `unknown` and casting at use site keeps this file framework-free.
type MathDocumentLike = {
  convert: (latex: string, options?: { display?: boolean }) => unknown
  adaptor: { firstChild: (node: unknown) => Element | null }
}

let mathDocPromise: Promise<MathDocumentLike> | null = null

async function getMathDoc(): Promise<MathDocumentLike> {
  if (!mathDocPromise) {
    mathDocPromise = (async () => {
      const [
        { mathjax },
        { TeX },
        { AllPackages },
        { SVG },
        { browserAdaptor },
        { RegisterHTMLHandler }
      ] = await Promise.all([
        import('mathjax-full/js/mathjax.js'),
        import('mathjax-full/js/input/tex.js'),
        import('mathjax-full/js/input/tex/AllPackages.js'),
        import('mathjax-full/js/output/svg.js'),
        import('mathjax-full/js/adaptors/browserAdaptor.js'),
        import('mathjax-full/js/handlers/html.js')
      ])
      const adaptor = browserAdaptor()
      RegisterHTMLHandler(adaptor)
      const doc = mathjax.document('', {
        InputJax: new TeX({ packages: AllPackages }),
        OutputJax: new SVG({ fontCache: 'local' })
      })
      return doc as unknown as MathDocumentLike
    })()
  }
  return mathDocPromise
}

// Tiny LRU keyed by latex source. Repeated previews (e.g. as the user types
// `x`, `x^`, `x^2`) shouldn't re-pay the conversion cost on every keystroke.
const CACHE_LIMIT = 50
const renderCache = new Map<string, RenderResult>()

function rememberRender(key: string, value: RenderResult): RenderResult {
  if (renderCache.has(key)) renderCache.delete(key)
  renderCache.set(key, value)
  if (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
  return value
}

/**
 * Render a LaTeX string to an SVG data URI with intrinsic pixel dimensions.
 *
 * Returns `{ ok: false }` (with the MathJax error message) for invalid input —
 * the modal renders this inline instead of throwing.
 */
export async function renderLatexToSvgDataUrl(latex: string): Promise<RenderResult> {
  const trimmed = latex.trim()
  if (!trimmed) return { ok: false, error: 'Empty equation' }

  const cached = renderCache.get(trimmed)
  if (cached) return cached

  try {
    const doc = await getMathDoc()
    const node = doc.convert(trimmed, { display: true })
    const svgEl = doc.adaptor.firstChild(node)
    if (!svgEl) return rememberRender(trimmed, { ok: false, error: 'No SVG produced' })

    const serialized = new XMLSerializer().serializeToString(svgEl)
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(serialized)}`
    const normalized = normalizeSvgDataUrl(dataUrl)
    if (!normalized) {
      return rememberRender(trimmed, { ok: false, error: 'Failed to parse rendered SVG' })
    }
    return rememberRender(trimmed, { ok: true, rendered: normalized })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return rememberRender(trimmed, { ok: false, error: message })
  }
}
