import { describe, expect, it, vi } from 'vitest'
import { selectWindowRoleApi } from '../../src/preload/roleApi'

function createApi(): Parameters<typeof selectWindowRoleApi>[0] {
  return {
    db: { getSlide: vi.fn() },
    fonts: { getEmbeddedFonts: vi.fn() },
    presentation: {
      navigate: vi.fn(),
      exit: vi.fn(),
      onStateChanged: vi.fn(),
      signalReady: vi.fn()
    },
    debug: {
      onStateUpdate: vi.fn(),
      requestState: vi.fn(),
      copyText: vi.fn(),
      getLocale: vi.fn(),
      onLocaleChanged: vi.fn()
    }
  }
}

describe('selectWindowRoleApi', () => {
  it('gives the debug renderer its state and locale APIs only', () => {
    const exposed = selectWindowRoleApi(createApi(), 'debug')

    expect(exposed).toEqual({
      debug: {
        onStateUpdate: expect.any(Function),
        requestState: expect.any(Function),
        copyText: expect.any(Function),
        getLocale: expect.any(Function),
        onLocaleChanged: expect.any(Function)
      }
    })
    expect(exposed).not.toHaveProperty('prefs')
    expect(exposed).not.toHaveProperty('app')
    expect(exposed).not.toHaveProperty('db')
  })

  it('does not expose APIs to an unknown renderer role', () => {
    expect(selectWindowRoleApi(createApi(), 'unknown')).toEqual({})
  })
})
