import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { renderDebugStateWindow } from '../../../src/renderer/src/lib/debugStateWindow'

describe('renderDebugStateWindow', () => {
  it('copies the exact JSON snapshot and reports success', async () => {
    const dom = new JSDOM()
    const copyText = vi.fn(async () => {})
    const json = '{"title":"hello"}'
    renderDebugStateWindow(dom.window as unknown as Window, json, copyText)

    const button = dom.window.document.getElementById('copy-state') as HTMLButtonElement
    button.click()

    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith(json))
    await vi.waitFor(() =>
      expect(dom.window.document.getElementById('copy-status')?.textContent).toBe('Copied!')
    )
    await vi.waitFor(() => expect(button.disabled).toBe(false))
  })

  it('renders presentation content as text instead of executable markup', () => {
    const dom = new JSDOM()
    const json = '{"text":"</pre><script>globalThis.injected = true</script>"}'
    renderDebugStateWindow(
      dom.window as unknown as Window,
      json,
      vi.fn(async () => {})
    )

    expect(dom.window.document.getElementById('state-json')?.textContent).toBe(json)
    expect(dom.window.document.querySelector('script')).toBeNull()
  })
})
