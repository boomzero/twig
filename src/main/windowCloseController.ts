import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'

export const CLOSE_REQUEST_CHANNEL = 'lifecycle:close-requested'
export const CLOSE_RESPONSE_CHANNEL = 'lifecycle:close-response'
export type CloseDecision = 'proceed' | 'cancel'

interface CloseEventLike {
  preventDefault(): void
}

type WebContentsLike = Pick<WebContents, 'send' | 'once' | 'removeListener'>
type WindowLike = Pick<BrowserWindow, 'destroy' | 'isDestroyed'> & {
  webContents: WebContentsLike
}
type IpcMainLike = Pick<IpcMain, 'on' | 'removeListener'>
type IpcEventLike = Pick<IpcMainEvent, 'sender'>

interface WindowCloseControllerOptions {
  window: WindowLike
  ipcMain: IpcMainLike
  timeoutMs: number
  getIsQuitting: () => boolean
  setIsQuitting: (value: boolean) => void
  quitApp: () => void
  logger?: Pick<Console, 'warn'>
}

export function createWindowCloseController(options: WindowCloseControllerOptions): {
  handleClose: (event: CloseEventLike) => void
} {
  const {
    window,
    ipcMain,
    timeoutMs,
    getIsQuitting,
    setIsQuitting,
    quitApp,
    logger = console
  } = options

  let closePromise: Promise<void> | null = null
  let nextRequestId = 0

  function isDecision(value: unknown): value is CloseDecision {
    return value === 'proceed' || value === 'cancel'
  }

  function requestCloseDecision(): Promise<CloseDecision> {
    return new Promise<CloseDecision>((resolve) => {
      if (window.isDestroyed()) {
        resolve('cancel')
        return
      }

      const requestId = ++nextRequestId
      let timeoutId: NodeJS.Timeout | null = null
      let settled = false
      const { webContents } = window

      const cleanup = (): void => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        ipcMain.removeListener(CLOSE_RESPONSE_CHANNEL, responseHandler)
        webContents.removeListener('render-process-gone', rendererGoneHandler)
        webContents.removeListener('destroyed', destroyedHandler)
      }

      const settle = (decision: CloseDecision): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(decision)
      }

      const responseHandler = (
        event: IpcEventLike,
        responseRequestId: unknown,
        decision: unknown
      ): void => {
        if (
          event.sender !== webContents ||
          responseRequestId !== requestId ||
          !isDecision(decision)
        ) {
          return
        }
        settle(decision)
      }

      const rendererGoneHandler = (): void => {
        logger.warn('Renderer exited during close confirmation; canceling close')
        settle('cancel')
      }

      const destroyedHandler = (): void => {
        settle('cancel')
      }

      timeoutId = setTimeout(() => {
        logger.warn('Close confirmation timed out; canceling close')
        settle('cancel')
      }, timeoutMs)

      ipcMain.on(CLOSE_RESPONSE_CHANNEL, responseHandler)
      webContents.once('render-process-gone', rendererGoneHandler)
      webContents.once('destroyed', destroyedHandler)

      try {
        webContents.send(CLOSE_REQUEST_CHANNEL, requestId)
      } catch (error) {
        logger.warn(`Failed to request close confirmation: ${String(error)}`)
        settle('cancel')
      }
    })
  }

  async function runClose(): Promise<void> {
    const decision = await requestCloseDecision()

    if (decision === 'proceed') {
      if (!window.isDestroyed()) {
        window.destroy()
      }
      if (getIsQuitting()) {
        quitApp()
      }
      return
    }

    setIsQuitting(false)
  }

  function handleClose(event: CloseEventLike): void {
    event.preventDefault()

    if (window.isDestroyed() || closePromise) {
      return
    }

    let shouldKeepPromise = false
    closePromise = runClose()
      .then(() => {
        shouldKeepPromise = window.isDestroyed()
      })
      .finally(() => {
        if (!shouldKeepPromise) {
          closePromise = null
        }
      })
  }

  return {
    handleClose
  }
}
