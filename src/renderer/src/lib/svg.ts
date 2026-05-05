const SVG_DATA_URL_PATTERN = /^data:image\/svg\+xml(?:[;,])/i
const SVG_DATA_URL_SPLIT_PATTERN = /^data:image\/svg\+xml(?:;([^,]*))?,([\s\S]*)$/i
const NUMERIC_LENGTH_DIMENSION_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*(px|pt|pc|in|cm|mm|q)?\s*$/i
const BASE64_CHUNK_SIZE = 0x8000 - (0x8000 % 3)
const ABSOLUTE_UNIT_TO_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6
}

type SvgDimensions = {
  width: number
  height: number
}

export function isSvgMime(type: string): boolean {
  return type.trim().toLowerCase().split(';', 1)[0].trim() === 'image/svg+xml'
}

export function isSvgDataUrl(url: string): boolean {
  return SVG_DATA_URL_PATTERN.test(url)
}

export function normalizeSvgDataUrl(
  dataUrl: string
): { src: string; width: number; height: number } | null {
  const match = dataUrl.match(SVG_DATA_URL_SPLIT_PATTERN)
  if (!match) return null

  const modifiers = match[1] ?? ''
  const payload = match[2] ?? ''
  const isBase64 = modifiers
    .split(';')
    .some((modifier) => modifier.trim().toLowerCase() === 'base64')

  let svgText: string
  try {
    svgText = isBase64 ? decodeBase64Utf8(payload) : decodeURIComponent(payload)
  } catch {
    return null
  }

  const parser = new DOMParser()
  const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
  const svgEl = svgDoc.documentElement

  if (!svgEl || svgEl.localName.toLowerCase() !== 'svg' || hasParserErrorElement(svgDoc)) {
    return null
  }

  const dimensions = resolveSvgDimensions(svgEl)
  svgEl.setAttribute('width', String(dimensions.width))
  svgEl.setAttribute('height', String(dimensions.height))

  const serialized = new XMLSerializer().serializeToString(svgEl)
  const src = `data:image/svg+xml;base64,${encodeUtf8Base64(serialized)}`
  return { src, width: dimensions.width, height: dimensions.height }
}

function decodeBase64Utf8(payload: string): string {
  const binary = atob(payload.replace(/\s/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let encoded = ''

  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    encoded += btoa(String.fromCharCode(...chunk))
  }

  return encoded
}

function hasParserErrorElement(doc: Document): boolean {
  return Array.from(doc.getElementsByTagName('*')).some(
    (el) => el.localName.toLowerCase() === 'parsererror'
  )
}

function resolveSvgDimensions(svgEl: Element): SvgDimensions {
  const width = parseNumericLengthDimension(svgEl.getAttribute('width'))
  const height = parseNumericLengthDimension(svgEl.getAttribute('height'))
  const viewBox = parseViewBox(svgEl.getAttribute('viewBox'))

  if (width !== null && height !== null) {
    return { width, height }
  }

  if (width !== null && viewBox) {
    return { width, height: width * (viewBox.height / viewBox.width) }
  }

  if (height !== null && viewBox) {
    return { width: height * (viewBox.width / viewBox.height), height }
  }

  if (viewBox) {
    return { width: viewBox.width, height: viewBox.height }
  }

  return { width: 300, height: 150 }
}

function parseNumericLengthDimension(value: string | null): number | null {
  const match = value?.match(NUMERIC_LENGTH_DIMENSION_PATTERN)
  if (!match) return null

  const number = Number(match[1])
  const unit = (match[2] ?? 'px').toLowerCase()
  const scale = ABSOLUTE_UNIT_TO_PX[unit]
  const pixels = number * scale
  return Number.isFinite(pixels) && pixels > 0 ? pixels : null
}

function parseViewBox(value: string | null): SvgDimensions | null {
  const parts = value?.trim().split(/[\s,]+/) ?? []
  if (parts.length !== 4) return null

  const width = Number(parts[2])
  const height = Number(parts[3])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}
