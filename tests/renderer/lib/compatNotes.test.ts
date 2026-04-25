import { describe, expect, it } from 'vitest'
import { resolveCompatNotes } from '@renderer/lib/compatNotes'

describe('src/renderer/src/lib/compatNotes.ts', () => {
  it('resolves locale-keyed compat notes through the renderer import path', () => {
    const payload = JSON.stringify({ en: 'English', zh: '中文', _default: 'Fallback' })

    expect(resolveCompatNotes(payload, 'zh-CN')).toBe('中文')
    expect(resolveCompatNotes(payload, 'de')).toBe('Fallback')
    expect(resolveCompatNotes('{bad', 'en')).toBe('{bad')
  })
})
