/**
 * Safely logs a message, ignoring errors if console is unavailable (e.g., during shutdown).
 * This prevents crashes when logging during application exit.
 */
export function safeLog(message: string, level: 'log' | 'warn' | 'error' = 'log'): void {
  try {
    console[level](message)
  } catch {
    // Ignore logging errors during shutdown - console streams may be closed
  }
}

/** Format unknown thrown values for diagnostic logging. */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message
  }
  return String(error)
}
