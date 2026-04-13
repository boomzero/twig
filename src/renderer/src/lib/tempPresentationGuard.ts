export type TempPresentationPromptChoice = 'save' | 'discard' | 'cancel'

export interface TempPresentationDecision {
  proceed: boolean
  abandonedTempPath: string | null
}

interface TempPresentationGuardOptions {
  currentFilePath: string | null
  isTempFile: boolean
  flushPendingSave: () => Promise<void>
  isBootstrapPresentation: (filePath: string) => Promise<boolean>
  promptToAbandonTemp: () => Promise<TempPresentationPromptChoice>
  saveTempPresentation: () => Promise<boolean>
}

interface PresentationSwitchOptions extends TempPresentationGuardOptions {
  replacePresentation: (decision: TempPresentationDecision) => Promise<boolean>
  deleteTempPresentation: (filePath: string) => Promise<void>
  onDeleteTempFailure?: (filePath: string, error: unknown) => void
}

interface ClosePresentationOptions extends TempPresentationGuardOptions {
  cancelPendingPersistence: () => void
  deleteTempPresentation: (filePath: string) => Promise<void>
  promptToForceCloseOnError: (error: unknown) => Promise<boolean>
  onClosePreparationFailure?: (error: unknown) => void
  onDeleteTempFailure?: (filePath: string, error: unknown) => void
}

export async function decideTempPresentationDisposition(
  options: TempPresentationGuardOptions
): Promise<TempPresentationDecision> {
  const {
    currentFilePath,
    isTempFile,
    flushPendingSave,
    isBootstrapPresentation,
    promptToAbandonTemp,
    saveTempPresentation
  } = options

  if (!currentFilePath) {
    return { proceed: true, abandonedTempPath: null }
  }

  await flushPendingSave()

  if (!isTempFile) {
    return { proceed: true, abandonedTempPath: null }
  }

  if (await isBootstrapPresentation(currentFilePath)) {
    return { proceed: true, abandonedTempPath: currentFilePath }
  }

  const choice = await promptToAbandonTemp()
  if (choice === 'cancel') {
    return { proceed: false, abandonedTempPath: null }
  }

  if (choice === 'save') {
    const didSave = await saveTempPresentation()
    return { proceed: didSave, abandonedTempPath: null }
  }

  return { proceed: true, abandonedTempPath: currentFilePath }
}

export async function switchPresentationWithTempGuard(
  options: PresentationSwitchOptions
): Promise<boolean> {
  const decision = await decideTempPresentationDisposition(options)
  if (!decision.proceed) {
    return false
  }

  const didReplace = await options.replacePresentation(decision)
  if (!didReplace) {
    return false
  }

  if (decision.abandonedTempPath) {
    try {
      await options.deleteTempPresentation(decision.abandonedTempPath)
    } catch (error) {
      options.onDeleteTempFailure?.(decision.abandonedTempPath, error)
    }
  }

  return true
}

export async function closePresentationWithTempGuard(
  options: ClosePresentationOptions
): Promise<boolean> {
  let decision: TempPresentationDecision

  try {
    decision = await decideTempPresentationDisposition(options)
  } catch (error) {
    options.onClosePreparationFailure?.(error)
    const shouldForceClose = await options.promptToForceCloseOnError(error)
    if (shouldForceClose) {
      options.cancelPendingPersistence()
    }
    return shouldForceClose
  }

  if (!decision.proceed) {
    return false
  }

  if (!decision.abandonedTempPath) {
    return true
  }

  options.cancelPendingPersistence()

  try {
    await options.deleteTempPresentation(decision.abandonedTempPath)
  } catch (error) {
    options.onDeleteTempFailure?.(decision.abandonedTempPath, error)
  }

  return true
}
