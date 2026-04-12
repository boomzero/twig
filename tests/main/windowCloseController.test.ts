import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSE_REQUEST_CHANNEL,
  CLOSE_RESPONSE_CHANNEL,
  createWindowCloseController
} from '../../src/main/windowCloseController'

class FakeWebContents extends EventEmitter {
  sentChannels: string[] = []

  send(channel: string): void {
    this.sentChannels.push(channel)
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

function createHarness(initiallyQuitting = false) {
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
    getIsQuitting: () => isQuitting
  }
}

describe('windowCloseController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('destroys the window and re-triggers quit when the renderer approves close', async () => {
    const { controller, event, window, ipcMain, quitApp } = createHarness(true)

    controller.handleClose(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(window.webContents.sentChannels).toEqual([CLOSE_REQUEST_CHANNEL])

    ipcMain.emit(CLOSE_RESPONSE_CHANNEL, { sender: window.webContents }, 'proceed')
    await Promise.resolve()

    expect(window.destroy).toHaveBeenCalledOnce()
    expect(quitApp).toHaveBeenCalledOnce()
  })

  it('keeps the window open and resets quit intent when the renderer cancels', async () => {
    const { controller, event, window, ipcMain, setIsQuitting, getIsQuitting } = createHarness(true)

    controller.handleClose(event)
    ipcMain.emit(CLOSE_RESPONSE_CHANNEL, { sender: window.webContents }, 'cancel')
    await Promise.resolve()

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
    expect(getIsQuitting()).toBe(false)
  })

  it('cancels close on timeout instead of force-closing the window', async () => {
    vi.useFakeTimers()
    const { controller, event, window, setIsQuitting } = createHarness(true)

    controller.handleClose(event)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
  })

  it('cancels close when the renderer process disappears mid-handshake', async () => {
    const { controller, event, window, setIsQuitting } = createHarness(true)

    controller.handleClose(event)
    window.webContents.emit('render-process-gone')
    await Promise.resolve()

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
  })

  it('cancels close when the webContents is destroyed mid-handshake', async () => {
    const { controller, event, window, setIsQuitting } = createHarness(true)

    controller.handleClose(event)
    window.webContents.emit('destroyed')
    await Promise.resolve()

    expect(window.destroy).not.toHaveBeenCalled()
    expect(setIsQuitting).toHaveBeenCalledWith(false)
  })
})
