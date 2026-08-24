import crypto from 'crypto'
import fs from 'fs'
import { basename, dirname, join, normalize } from 'path'

/**
 * Returns a unique staging path beside the destination. Keeping the staging
 * file on the same volume lets POSIX rename replace the destination atomically.
 */
export function createSiblingStagingPath(destinationPath: string): string {
  return join(
    dirname(destinationPath),
    `.${basename(destinationPath, '.tb')}.twig-${crypto.randomUUID()}.tb`
  )
}

/** Detect aliases (symlinks/hard links) as well as identical path strings. */
export function pathsReferToSameFile(firstPath: string, secondPath: string): boolean {
  if (normalize(firstPath) === normalize(secondPath)) return true
  if (!fs.existsSync(firstPath) || !fs.existsSync(secondPath)) return false

  try {
    if (fs.realpathSync(firstPath) === fs.realpathSync(secondPath)) return true
    const firstStat = fs.statSync(firstPath)
    const secondStat = fs.statSync(secondPath)
    return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino
  } catch {
    return false
  }
}

/**
 * Installs a completed staging file without deleting the old destination first.
 * POSIX rename is an atomic replacement. Windows rename cannot replace an
 * existing file, so retain a sibling backup until the new file is installed.
 */
export function replaceFilePreservingDestination(
  stagingPath: string,
  destinationPath: string
): void {
  if (!fs.existsSync(destinationPath) || process.platform !== 'win32') {
    fs.renameSync(stagingPath, destinationPath)
    return
  }

  const backupPath = `${createSiblingStagingPath(destinationPath)}.backup`
  fs.renameSync(destinationPath, backupPath)
  try {
    fs.renameSync(stagingPath, destinationPath)
  } catch (error) {
    try {
      fs.renameSync(backupPath, destinationPath)
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Failed to install ${destinationPath} and restore its backup at ${backupPath}`
      )
    }
    throw error
  }

  try {
    fs.unlinkSync(backupPath)
  } catch {
    // The new destination is installed successfully. Leaving the old sibling
    // backup is recoverable and must not turn a successful save into failure.
  }
}

export function removeDatabaseCompanions(databasePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const companionPath = `${databasePath}${suffix}`
    if (fs.existsSync(companionPath)) fs.unlinkSync(companionPath)
  }
}
