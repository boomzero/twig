// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { isSvgDataUrl, isSvgMime, normalizeSvgDataUrl } from '@renderer/lib/svg'

function base64SvgDataUrl(svg: string, modifiers = 'base64'): string {
  return `data:image/svg+xml;${modifiers},${Buffer.from(svg, 'utf8').toString('base64')}`
}

function uriSvgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function decodeNormalizedSvg(src: string): string {
  return Buffer.from(src.split(',')[1] ?? '', 'base64').toString('utf8')
}

function parseNormalizedSvg(src: string): Element {
  const doc = new DOMParser().parseFromString(decodeNormalizedSvg(src), 'image/svg+xml')
  return doc.documentElement
}

describe('src/renderer/src/lib/svg.ts', () => {
  it('has the DOM APIs required by the SVG normalizer', () => {
    expect(typeof DOMParser).toBe('function')
    expect(typeof XMLSerializer).toBe('function')
  })

  it('detects SVG MIME types with case and parameter tolerance', () => {
    expect(isSvgMime('image/svg+xml')).toBe(true)
    expect(isSvgMime('IMAGE/SVG+XML')).toBe(true)
    expect(isSvgMime('image/svg+xml; charset=utf-8')).toBe(true)
    expect(isSvgMime(' image/svg+xml ; charset=utf-8')).toBe(true)
    expect(isSvgMime('image/png')).toBe(false)
    expect(isSvgMime('image/svg')).toBe(false)
  })

  it('detects SVG data URL prefixes with case tolerance', () => {
    expect(isSvgDataUrl('data:image/svg+xml,<svg/>')).toBe(true)
    expect(isSvgDataUrl('DATA:IMAGE/SVG+XML;BASE64,PHN2Zy8+')).toBe(true)
    expect(isSvgDataUrl('data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+')).toBe(true)
    expect(isSvgDataUrl('data:image/png;base64,abc')).toBe(false)
    expect(isSvgDataUrl('data:image/svg+xmlfoo;base64,abc')).toBe(false)
  })

  it('normalizes an SVG that already has numeric dimensions', () => {
    const result = normalizeSvgDataUrl(
      base64SvgDataUrl('<svg width="100" height="50"><rect width="100" height="50"/></svg>')
    )

    expect(result).toMatchObject({ width: 100, height: 50 })
    expect(result?.src.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('injects viewBox-only dimensions into the root svg', () => {
    const result = normalizeSvgDataUrl(base64SvgDataUrl('<svg viewBox="0 0 24 24"><path/></svg>'))

    expect(result).toMatchObject({ width: 24, height: 24 })
    const svgEl = parseNormalizedSvg(result!.src)
    expect(svgEl.getAttribute('width')).toBe('24')
    expect(svgEl.getAttribute('height')).toBe('24')
    expect(svgEl.getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('rejects percentage dimensions and falls back to the viewBox', () => {
    const result = normalizeSvgDataUrl(
      base64SvgDataUrl('<svg width="100%" height="100%" viewBox="0 0 24 24"><path/></svg>')
    )

    expect(result).toMatchObject({ width: 24, height: 24 })
  })

  it('converts absolute SVG length units to CSS pixels', () => {
    const result = normalizeSvgDataUrl(
      base64SvgDataUrl('<svg width="72pt" height="2.54cm"><path/></svg>')
    )

    expect(result?.width).toBeCloseTo(96)
    expect(result?.height).toBeCloseTo(96)
  })

  it('derives a missing dimension from the viewBox aspect ratio', () => {
    const result = normalizeSvgDataUrl(
      base64SvgDataUrl('<svg width="100" viewBox="0 0 50 25"><path/></svg>')
    )

    expect(result).toMatchObject({ width: 100, height: 50 })
  })

  it('preserves one explicit dimension without a viewBox', () => {
    expect(normalizeSvgDataUrl(base64SvgDataUrl('<svg width="100"><path/></svg>'))).toMatchObject({
      width: 100,
      height: 150
    })
    expect(normalizeSvgDataUrl(base64SvgDataUrl('<svg height="80"><path/></svg>'))).toMatchObject({
      width: 300,
      height: 80
    })
  })

  it('falls back to replaced-element dimensions when no dimensions are present', () => {
    const result = normalizeSvgDataUrl(
      base64SvgDataUrl('<svg><rect width="10" height="10"/></svg>')
    )

    expect(result).toMatchObject({ width: 300, height: 150 })
    const svgEl = parseNormalizedSvg(result!.src)
    expect(svgEl.getAttribute('width')).toBe('300')
    expect(svgEl.getAttribute('height')).toBe('150')
  })

  it('preserves non-ASCII SVG content through the base64 round trip', () => {
    const svg = '<svg width="100" height="50"><text>中文 — emoji 😀</text></svg>'
    const result = normalizeSvgDataUrl(base64SvgDataUrl(svg))

    expect(decodeNormalizedSvg(result!.src)).toContain('中文 — emoji 😀')
  })

  it('decodes non-base64 SVG data URLs', () => {
    const result = normalizeSvgDataUrl(uriSvgDataUrl('<svg viewBox="0 0 32 16"><path/></svg>'))

    expect(result).toMatchObject({ width: 32, height: 16 })
  })

  it('parses MIME parameters before base64 payloads', () => {
    const result = normalizeSvgDataUrl(
      base64SvgDataUrl('<svg viewBox="0 0 64 32"><path/></svg>', 'charset=utf-8;base64')
    )

    expect(result).toMatchObject({ width: 64, height: 32 })
  })

  it('returns null for malformed XML parser errors', () => {
    expect(normalizeSvgDataUrl(base64SvgDataUrl('<svg><rect></svg>'))).toBeNull()
  })

  it('returns null for non-SVG roots', () => {
    expect(normalizeSvgDataUrl(base64SvgDataUrl('<html></html>'))).toBeNull()
  })
})
