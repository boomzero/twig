/**
 * MathJax (TeX → SVG) wrapper for math elements.
 *
 * Only the editor renderer should import this — the presentation window and
 * file-load paths read the prerendered SVG out of `element.src` and never
 * touch MathJax. The MathJax library itself is loaded via dynamic `import()`
 * on the first call so the editor's initial bundle isn't bloated.
 *
 * Uses the prebuilt browser bundle (`mathjax-full/es5/tex-svg.js`) rather
 * than the modular `js/*` CJS sources — the prebuilt bundle is a self-
 * contained UMD that doesn't try to `require()` at runtime.
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

// 1ex ≈ 0.5 × font-size by CSS default. With MathJax's default 16px base font,
// that's 8px per ex. Scaling this up gives a larger default canvas footprint
// (equations are otherwise quite small at 1ex=8px). 20 keeps small inline
// equations readable at typical slide zoom while still leaving room to resize.
const EX_TO_PX = 20

type MathJaxApi = {
  tex2svg: (input: string, options?: { display?: boolean }) => Element
  startup: { promise: Promise<unknown> }
}

let mathjaxPromise: Promise<MathJaxApi> | null = null

async function getMathJax(): Promise<MathJaxApi> {
  if (!mathjaxPromise) {
    mathjaxPromise = (async () => {
      // Configure BEFORE loading the bundle — MathJax reads window.MathJax
      // during startup and consumes the config object.
      const w = globalThis as unknown as { MathJax?: Record<string, unknown> }
      w.MathJax = {
        tex: { packages: { '[+]': ['ams', 'newcommand', 'configmacros'] } },
        // 'none' inlines every glyph as its own <path>. 'local' / 'global' use
        // <use href="#MJX-..."> references that resolve to defs MathJax assumes
        // are still in the document — once we extract the SVG into a data URL
        // those refs point at nothing, producing solid black rectangles.
        svg: { fontCache: 'none' },
        startup: { typeset: false }
      }
      await import('mathjax-full/es5/tex-svg.js')
      const mj = (globalThis as unknown as { MathJax: MathJaxApi }).MathJax
      await mj.startup.promise
      return mj
    })()
  }
  return mathjaxPromise
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
    const mj = await getMathJax()
    const wrapper = mj.tex2svg(trimmed, { display: true })

    // MathJax flags parse errors with `data-mjx-error` on an inner
    // `<g data-mml-node="merror">` element, and emits a placeholder SVG with a
    // <rect data-background="true"> that renders as a solid black rect once
    // the SVG is extracted into a data URL. Surface the error message as text
    // instead so the user can fix the LaTeX before inserting.
    const errEl = wrapper.querySelector('[data-mjx-error]')
    if (errEl) {
      const message = errEl.getAttribute('data-mjx-error') || 'Invalid LaTeX'
      return rememberRender(trimmed, { ok: false, error: message })
    }

    const svgEl = wrapper.querySelector('svg')
    if (!svgEl) return rememberRender(trimmed, { ok: false, error: 'No SVG produced' })

    // tex2svg sets width/height in `ex` units (e.g. "3.2ex"). Convert to px so
    // downstream code (and normalizeSvgDataUrl) sees real pixel dimensions
    // instead of falling back to the viewBox, which is in MathJax internal
    // units (~1000/em) and would produce a multi-thousand-pixel SVG.
    const exToPx = (value: string | null): number | null => {
      const m = value?.match(/^\s*(-?\d+(?:\.\d+)?)\s*ex\s*$/i)
      if (!m) return null
      return Number(m[1]) * EX_TO_PX
    }
    const widthPx = exToPx(svgEl.getAttribute('width'))
    const heightPx = exToPx(svgEl.getAttribute('height'))
    if (widthPx !== null) svgEl.setAttribute('width', String(widthPx))
    if (heightPx !== null) svgEl.setAttribute('height', String(heightPx))
    svgEl.removeAttribute('style')

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
