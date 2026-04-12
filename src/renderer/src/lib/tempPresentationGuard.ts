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
