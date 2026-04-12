import { describe, expect, it } from 'vitest'
import {
  fontDataToBase64,
  normalizeFontBytes,
  type FontBytes
} from '../../../src/renderer/src/lib/fontUtils'

describe('src/renderer/src/lib/fontUtils.ts', () => {
  it('normalizes supported font byte shapes into Uint8Array', () => {
    const bytes = Uint8Array.from([0, 1, 2, 255])

    expect(Array.from(normalizeFontBytes(Buffer.from(bytes)) ?? [])).toEqual([0, 1, 2, 255])
    expect(Array.from(normalizeFontBytes(bytes.buffer) ?? [])).toEqual([0, 1, 2, 255])
    expect(Array.from(normalizeFontBytes(bytes) ?? [])).toEqual([0, 1, 2, 255])
    expect(Array.from(normalizeFontBytes({ data: [0, 1, 2, 255] }) ?? [])).toEqual([0, 1, 2, 255])
    expect(Array.from(normalizeFontBytes({ data: bytes }) ?? [])).toEqual([0, 1, 2, 255])
  })

  it('returns null for unsupported byte shapes', () => {
    expect(normalizeFontBytes(42 as unknown as FontBytes)).toBeNull()
  })

  it('converts normalized bytes to base64', () => {
    const expected = Buffer.from([0, 1, 2, 255]).toString('base64')

    expect(fontDataToBase64(Uint8Array.from([0, 1, 2, 255]))).toBe(expected)
    expect(Buffer.from(fontDataToBase64(Buffer.from([0, 1, 2, 255])), 'base64')).toEqual(
      Buffer.from([0, 1, 2, 255])
    )
  })

  it('throws for unsupported byte input', () => {
    expect(() => fontDataToBase64(42 as unknown as FontBytes)).toThrowError(
      'Unsupported font data type'
    )
  })
})
