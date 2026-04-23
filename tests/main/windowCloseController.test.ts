import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSE_READY_CHANNEL,
  CLOSE_REQUEST_CHANNEL,
  CLOSE_RESPONSE_CHANNEL,
  createWindowCloseController
} from '../../src/main/windowCloseController'

class FakeWebContents extends EventEmitter {
  sentMessages: Array<{ channel: string; args: unknown[] }> = []

  send(channel: string, ...args: unknown[]): void {
    this.sentMessages.push({ channel, args })
  }
}

class FakeWindow {
  destroyed = false
  destroy = vi.fn(() => {
    this.destroyed = true
  })
  webContents = new FakeWebContents()

  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeIpcMain extends EventEmitter {}

type WindowCloseHarness = {
  window: FakeWindow
  ipcMain: FakeIpcMain
  logger: { warn: ReturnType<typeof vi.fn> }
  setIsQuitting: ReturnType<typeof vi.fn>
  quitApp: ReturnType<typeof vi.fn>
  controller: ReturnType<typeof createWindowCloseController>
  event: { preventDefault: ReturnType<typeof vi.fn> }
  signalRendererReady: () => void
  getIsQuitting: () => boolean
}

function createHarness(initiallyQuitting = false): WindowCloseHarness {
  const window = new FakeWindow()
  const ipcMain = new FakeIpcMain()
  const logger = { warn: vi.fn() }
  let isQuitting = initiallyQuitting
  const setIsQuitting = vi.fn((value: boolean) => {
    isQuitting = value
  })
  const quitApp = vi.fn()
  const controller = createWindowCloseController({
    window: window as never,
    ipcMain: ipcMain as never,
    timeoutMs: 1_000,
    getIsQuitting: () => isQuitting,
    setIsQuitting,
    quitApp,
    logger
  })
  const event = { preventDefault: vi.fn() }

  return {
    window,
    ipcMain,
    logger,
    setIsQuitting,
    quitApp,
    controller,
    event,
    signalRendererReady: () => {
      ipcMain.emit(CLOSE_READY_CHANNEL, { sender: window.webContents })
    },
    getIsQuitting: () => isQuitting
  }
}

describe('windowCloseController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('destroys the window and re-triggers quit when the renderer approves close', async () => {
    const { controller, event, window, ipcMain, quitApp, signalRendererReady } = createHarness(true)

    signalRendererReady()
    controller.handleClose(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.webContents.sentMessages).toEqual([{ channel: CLOSE_REQUEST_CHANNEL, args: [1] }])

    ipcMain.emit(CLOSE_RESPONSE_CHANNEL, { sender: window.webContents }, 1, 'proceed')
    await Promise.resolve()

    expect(window.destroy).toHaveBeenCalledOnce()
    expect(quitApp).toHaveBeenCalledOnce()
  })

  it('keeps the window open and resets quit intent when the renderer cancels', async () => {
    const {
      controller,
      event,
      window,
      ipcMain,
      setIsQuitting,
      getIsQuitting,
      signalRendererReady
    } = createHarness(true)

    signalRendererReady()
    controller.handleClose(event)
    ipcMain.emit(CLOSE_RESPONSE_CHANNEL, { sender: window.webContents }, 1, 'cancel')
    await Promise.resolve()

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
    expect(getIsQuitting()).toBe(false)
  })

  it('falls back to a local close when the renderer never becomes close-ready', async () => {
    vi.useFakeTimers()
    const { controller, event, window, quitApp } = createHarness(true)

    controller.handleClose(event)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(window.destroy).toHaveBeenCalledOnce()
    expect(quitApp).toHaveBeenCalledOnce()
  })

  it('cancels close on timeout after the renderer becomes close-ready', async () => {
    vi.useFakeTimers()
    const { controller, event, window, setIsQuitting, signalRendererReady } = createHarness(true)

    signalRendererReady()
    controller.handleClose(event)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
  })

  it('falls back to a local close when the renderer crashes before it becomes close-ready', async () => {
    const { controller, event, window, quitApp } = createHarness(true)

    controller.handleClose(event)
    window.webContents.emit('render-process-gone')
    await Promise.resolve()

    expect(window.destroy).toHaveBeenCalledOnce()
    expect(quitApp).toHaveBeenCalledOnce()
  })

  it('cancels close when the renderer process disappears mid-handshake after it is close-ready', async () => {
    const { controller, event, window, setIsQuitting, signalRendererReady } = createHarness(true)

    signalRendererReady()
    controller.handleClose(event)
    window.webContents.emit('render-process-gone')
    await Promise.resolve()

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
  })

  it('cancels close when the webContents is destroyed mid-handshake after it is close-ready', async () => {
    const { controller, event, window, setIsQuitting, signalRendererReady } = createHarness(true)

    signalRendererReady()
    controller.handleClose(event)
    window.webContents.emit('destroyed')
    await Promise.resolve()

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
  })

  it('ignores stale responses from an earlier timed-out close request', async () => {
    vi.useFakeTimers()
    const { controller, event, window, ipcMain, signalRendererReady } = createHarness(true)

    signalRendererReady()
    controller.handleClose(event)
    expect(window.webContents.sentMessages).toEqual([{ channel: CLOSE_REQUEST_CHANNEL, args: [1] }])

    await vi.advanceTimersByTimeAsync(1_000)

    controller.handleClose(event)
    expect(window.webContents.sentMessages).toEqual([
      { channel: CLOSE_REQUEST_CHANNEL, args: [1] },
      { channel: CLOSE_REQUEST_CHANNEL, args: [2] }
    ])

    ipcMain.emit(CLOSE_RESPONSE_CHANNEL, { sender: window.webContents }, 1, 'proceed')
    await Promise.resolve()
    expect(window.destroy).not.toHaveBeenCalled()

    ipcMain.emit(CLOSE_RESPONSE_CHANNEL, { sender: window.webContents }, 2, 'cancel')
    await Promise.resolve()
    expect(window.destroy).not.toHaveBeenCalled()
  })
})
