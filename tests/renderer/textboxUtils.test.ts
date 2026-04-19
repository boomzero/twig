import { describe, expect, it } from 'vitest'

import { shouldSplitTextboxByGrapheme } from '../../src/renderer/src/lib/textboxUtils'

describe('src/renderer/src/lib/textboxUtils.ts', () => {
  it('keeps whitespace-based wrapping for Latin text', () => {
    expect(shouldSplitTextboxByGrapheme('Hello world from twig')).toBe(false)
  })

  it('enables grapheme wrapping for Chinese text', () => {
    expect(shouldSplitTextboxByGrapheme('你好世界，这是一个换行测试')).toBe(true)
  })

  it('enables grapheme wrapping for mixed CJK and Latin text', () => {
    expect(shouldSplitTextboxByGrapheme('你好 twig')).toBe(true)
  })

  it('treats empty input as non-CJK text', () => {
    expect(shouldSplitTextboxByGrapheme('')).toBe(false)
    expect(shouldSplitTextboxByGrapheme(null)).toBe(false)
    expect(shouldSplitTextboxByGrapheme(undefined)).toBe(false)
  })
})
