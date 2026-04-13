import { describe, expect, it, vi } from 'vitest'
import {
  closePresentationWithTempGuard,
  decideTempPresentationDisposition,
  switchPresentationWithTempGuard,
  type TempPresentationPromptChoice
} from '../../../src/renderer/src/lib/tempPresentationGuard'

function createGuardOptions(
  overrides: {
    currentFilePath?: string | null
    isTempFile?: boolean
    promptChoice?: TempPresentationPromptChoice
    didSave?: boolean
  } = {}
) {
  const flushPendingSave = vi.fn().mockResolvedValue(undefined)
  const isBootstrapPresentation = vi.fn().mockResolvedValue(false)
  const promptToAbandonTemp = vi
    .fn<() => Promise<TempPresentationPromptChoice>>()
    .mockResolvedValue(overrides.promptChoice ?? 'cancel')
  const saveTempPresentation = vi.fn().mockResolvedValue(overrides.didSave ?? true)

  return {
    currentFilePath: overrides.currentFilePath ?? '/tmp/current.tb',
    isTempFile: overrides.isTempFile ?? true,
    flushPendingSave,
    isBootstrapPresentation,
    promptToAbandonTemp,
    saveTempPresentation
  }
}

describe('tempPresentationGuard', () => {
  it('allows switching away from non-temp presentations after flushing', async () => {
    const options = createGuardOptions({ isTempFile: false })

    const result = await decideTempPresentationDisposition(options)

    expect(result).toEqual({ proceed: true, abandonedTempPath: null })
    expect(options.flushPendingSave).toHaveBeenCalledOnce()
    expect(options.isBootstrapPresentation).not.toHaveBeenCalled()
    expect(options.promptToAbandonTemp).not.toHaveBeenCalled()
  })

  it('silently abandons untouched bootstrap temp presentations', async () => {
    const options = createGuardOptions()
    options.isBootstrapPresentation.mockResolvedValue(true)

    const result = await decideTempPresentationDisposition(options)

    expect(result).toEqual({ proceed: true, abandonedTempPath: '/tmp/current.tb' })
    expect(options.promptToAbandonTemp).not.toHaveBeenCalled()
    expect(options.saveTempPresentation).not.toHaveBeenCalled()
  })

  it('cancels when the user cancels the temp presentation prompt', async () => {
    const options = createGuardOptions({ promptChoice: 'cancel' })

    const result = await decideTempPresentationDisposition(options)

    expect(result).toEqual({ proceed: false, abandonedTempPath: null })
    expect(options.promptToAbandonTemp).toHaveBeenCalledOnce()
  })

  it('continues without deleting when the user saves the temp presentation', async () => {
    const options = createGuardOptions({ promptChoice: 'save', didSave: true })

    const result = await decideTempPresentationDisposition(options)

    expect(result).toEqual({ proceed: true, abandonedTempPath: null })
    expect(options.saveTempPresentation).toHaveBeenCalledOnce()
  })

  it('cancels when Save As is canceled from the temp presentation prompt', async () => {
    const options = createGuardOptions({ promptChoice: 'save', didSave: false })

    const result = await decideTempPresentationDisposition(options)

    expect(result).toEqual({ proceed: false, abandonedTempPath: null })
  })

  it('deletes abandoned temp files only after the replacement presentation succeeds', async () => {
    const events: string[] = []
    const options = createGuardOptions({ promptChoice: 'discard' })
    const replacePresentation = vi.fn(async () => {
      events.push('replace')
      return true
    })
    const deleteTempPresentation = vi.fn(async () => {
      events.push('delete')
    })

    const result = await switchPresentationWithTempGuard({
      ...options,
      replacePresentation,
      deleteTempPresentation
    })

    expect(result).toBe(true)
    expect(events).toEqual(['replace', 'delete'])
    expect(deleteTempPresentation).toHaveBeenCalledWith('/tmp/current.tb')
  })

  it('does not delete the abandoned temp file when the replacement presentation fails', async () => {
    const options = createGuardOptions({ promptChoice: 'discard' })
    const replacePresentation = vi.fn().mockResolvedValue(false)
    const deleteTempPresentation = vi.fn()

    const result = await switchPresentationWithTempGuard({
      ...options,
      replacePresentation,
      deleteTempPresentation
    })

    expect(result).toBe(false)
    expect(deleteTempPresentation).not.toHaveBeenCalled()
  })

  it('allows closing anyway when close preparation fails and the user confirms', async () => {
    const options = createGuardOptions({ isTempFile: false })
    const error = new Error('disk full')
    options.flushPendingSave.mockRejectedValue(error)
    const cancelPendingPersistence = vi.fn()
    const promptToForceCloseOnError = vi.fn().mockResolvedValue(true)

    const result = await closePresentationWithTempGuard({
      ...options,
      cancelPendingPersistence,
      deleteTempPresentation: vi.fn(),
      promptToForceCloseOnError
    })

    expect(result).toBe(true)
    expect(promptToForceCloseOnError).toHaveBeenCalledWith(error)
    expect(cancelPendingPersistence).toHaveBeenCalledOnce()
  })

  it('keeps the window open when close preparation fails and the user cancels', async () => {
    const options = createGuardOptions({ isTempFile: false })
    const error = new Error('permission denied')
    options.flushPendingSave.mockRejectedValue(error)
    const cancelPendingPersistence = vi.fn()
    const promptToForceCloseOnError = vi.fn().mockResolvedValue(false)
    const onClosePreparationFailure = vi.fn()

    const result = await closePresentationWithTempGuard({
      ...options,
      cancelPendingPersistence,
      deleteTempPresentation: vi.fn(),
      promptToForceCloseOnError,
      onClosePreparationFailure
    })

    expect(result).toBe(false)
    expect(onClosePreparationFailure).toHaveBeenCalledWith(error)
    expect(cancelPendingPersistence).not.toHaveBeenCalled()
  })

  it('does not block close when deleting an abandoned temp file fails', async () => {
    const options = createGuardOptions({ promptChoice: 'discard' })
    const deleteError = new Error('unlink failed')
    const cancelPendingPersistence = vi.fn()
    const deleteTempPresentation = vi.fn().mockRejectedValue(deleteError)
    const onDeleteTempFailure = vi.fn()

    const result = await closePresentationWithTempGuard({
      ...options,
      cancelPendingPersistence,
      deleteTempPresentation,
      promptToForceCloseOnError: vi.fn(),
      onDeleteTempFailure
    })

    expect(result).toBe(true)
    expect(cancelPendingPersistence).toHaveBeenCalledOnce()
    expect(onDeleteTempFailure).toHaveBeenCalledWith('/tmp/current.tb', deleteError)
  })
})
