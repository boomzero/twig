import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'

export const CLOSE_REQUEST_CHANNEL = 'lifecycle:close-requested'
export const CLOSE_RESPONSE_CHANNEL = 'lifecycle:close-response'
export const CLOSE_READY_CHANNEL = 'lifecycle:close-ready'
export type CloseDecision = 'proceed' | 'cancel'

export async function closeWindowsSequentially(
  controllers: Array<{ requestClose: () => Promise<CloseDecision> }>
): Promise<boolean> {
  for (const controller of controllers) {
    if ((await controller.requestClose()) === 'cancel') return false
  }
  return true
}

interface CloseEventLike {
  preventDefault(): void
}

type WebContentsLike = Pick<WebContents, 'send' | 'on' | 'once' | 'removeListener'>
type WindowLike = Pick<
  BrowserWindow,
  'destroy' | 'focus' | 'isDestroyed' | 'isMinimized' | 'restore' | 'show'
> & {
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
  requestClose: () => Promise<CloseDecision>
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

  let closePromise: Promise<CloseDecision> | null = null
  let nextRequestId = 0
  let isRendererReadyForCloseRequests = false

  const rendererReadyHandler = (event: IpcEventLike): void => {
    if (event.sender === window.webContents) {
      isRendererReadyForCloseRequests = true
    }
  }

  ipcMain.on(CLOSE_READY_CHANNEL, rendererReadyHandler)
  window.webContents.on('did-start-loading', () => {
    isRendererReadyForCloseRequests = false
  })
  window.webContents.once('destroyed', () => {
    isRendererReadyForCloseRequests = false
    ipcMain.removeListener(CLOSE_READY_CHANNEL, rendererReadyHandler)
  })

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
      const rendererWasReadyForClose = isRendererReadyForCloseRequests
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
        logger.warn(
          rendererWasReadyForClose
            ? 'Renderer exited during close confirmation; canceling close'
            : 'Renderer exited before close confirmation was available; closing window locally'
        )
        settle(rendererWasReadyForClose ? 'cancel' : 'proceed')
      }

      const destroyedHandler = (): void => {
        settle(rendererWasReadyForClose ? 'cancel' : 'proceed')
      }

      timeoutId = setTimeout(() => {
        logger.warn(
          rendererWasReadyForClose
            ? 'Close confirmation timed out; canceling close'
            : 'Close confirmation never became available; closing window locally'
        )
        settle(rendererWasReadyForClose ? 'cancel' : 'proceed')
      }, timeoutMs)

      ipcMain.on(CLOSE_RESPONSE_CHANNEL, responseHandler)
      webContents.once('render-process-gone', rendererGoneHandler)
      webContents.once('destroyed', destroyedHandler)

      try {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
        webContents.send(CLOSE_REQUEST_CHANNEL, requestId)
      } catch (error) {
        logger.warn(`Failed to request close confirmation: ${String(error)}`)
        settle(rendererWasReadyForClose ? 'cancel' : 'proceed')
      }
    })
  }

  async function runClose(): Promise<CloseDecision> {
    const decision = await requestCloseDecision()

    if (decision === 'proceed') {
      if (!window.isDestroyed()) {
        window.destroy()
      }
      if (getIsQuitting()) {
        quitApp()
      }
      return decision
    }

    setIsQuitting(false)
    return decision
  }

  function requestClose(): Promise<CloseDecision> {
    if (window.isDestroyed()) return Promise.resolve('proceed')
    if (closePromise) return closePromise

    let shouldKeepPromise = false
    closePromise = runClose()
      .then((decision) => {
        shouldKeepPromise = window.isDestroyed()
        return decision
      })
      .finally(() => {
        if (!shouldKeepPromise) closePromise = null
      })
    return closePromise
  }

  function handleClose(event: CloseEventLike): void {
    event.preventDefault()

    void requestClose()
  }

  return {
    handleClose,
    requestClose
  }
}
