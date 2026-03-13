/**
 * Shared font utility functions for twig renderer.
 *
 * These pure conversion helpers are used by both the main editor (App.svelte)
 * and the presentation window (Presentation.svelte) so the binary-to-base64
 * logic is not duplicated.
 */

/**
 * The various forms in which font binary data can arrive after crossing
 * the IPC boundary (Buffer in Node, ArrayBuffer/Uint8Array in browser,
 * or the serialised { data: number[] } shape that IPC sometimes produces).
 */
export type FontBytes =
  | Buffer
  | ArrayBuffer
  | Uint8Array
  | { data: number[] }
  | { data: Uint8Array }

/**
 * Normalises any of the FontBytes variants into a plain Uint8Array,
 * returning null when the input is an unrecognised shape.
 */
export function normalizeFontBytes(fontData: FontBytes): Uint8Array | null {
  if (fontData instanceof Uint8Array) {
    return fontData
  }

  if (fontData instanceof ArrayBuffer) {
    return new Uint8Array(fontData)
  }

  if (typeof Buffer !== 'undefined' && fontData instanceof Buffer) {
    return new Uint8Array(fontData)
  }

  if (fontData && typeof fontData === 'object' && 'data' in fontData) {
    const data = fontData.data
    if (data instanceof Uint8Array) {
      return data
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data)
    }
  }

  return null
}

/**
 * Converts font binary data to a base64 string suitable for use in a
 * CSS data URI.
 */
export function fontDataToBase64(fontData: FontBytes): string {
  const bytes = normalizeFontBytes(fontData)
  if (!bytes) {
    throw new Error('Unsupported font data type')
  }

  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64')
    }
  } catch {
    // Fall back to manual base64 conversion.
  }

  const chunkSize = 0x8000
  let binary = ''

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }

  return btoa(binary)
}
