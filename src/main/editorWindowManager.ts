import fs from 'fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, normalize, resolve } from 'path'

export interface ManagedWebContents {
  id: number
}

export interface ManagedWindow {
  id: number
  webContents: ManagedWebContents
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export type DocumentReservationResult = 'reserved' | 'already-current' | 'focused-existing'
export type AuxiliaryWindowRole = 'debug' | 'presentation'

export interface EditorWindowRecord<W extends ManagedWindow = ManagedWindow> {
  window: W
  launchFile: string | null
  currentPath: string | null
  currentIdentity: string | null
  pendingPath: string | null
  pendingIdentity: string | null
  debugWindow: W | null
  presentationWindow: W | null
  lastFocusedAt: number
}

const directoryCaseSensitivity = new Map<string, boolean>()

function toggledAsciiCase(value: string): string | null {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character >= 'a' && character <= 'z') {
      return `${value.slice(0, index)}${character.toUpperCase()}${value.slice(index + 1)}`
    }
    if (character >= 'A' && character <= 'Z') {
      return `${value.slice(0, index)}${character.toLowerCase()}${value.slice(index + 1)}`
    }
  }
  return null
}

function existingEntryIsCaseSensitive(directoryPath: string, entryName: string): boolean | null {
  const alternateName = toggledAsciiCase(entryName)
  if (!alternateName) return null

  const entryPath = join(directoryPath, entryName)
  const alternatePath = join(directoryPath, alternateName)
  let entry: fs.Stats
  try {
    entry = fs.lstatSync(entryPath)
  } catch {
    return null
  }

  try {
    const alternate = fs.lstatSync(alternatePath)
    return entry.dev !== alternate.dev || entry.ino !== alternate.ino
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? true : null
  }
}

function detectDirectoryCaseSensitivity(directoryPath: string): boolean {
  const cached = directoryCaseSensitivity.get(directoryPath)
  if (cached !== undefined) return cached

  try {
    const entryNames = fs.readdirSync(directoryPath)
    const entryNameSet = new Set(entryNames)
    for (const entryName of entryNames) {
      const alternateName = toggledAsciiCase(entryName)
      if (alternateName && entryNameSet.has(alternateName)) {
        directoryCaseSensitivity.set(directoryPath, true)
        return true
      }
      const result = existingEntryIsCaseSensitive(directoryPath, entryName)
      if (result !== null) {
        directoryCaseSensitivity.set(directoryPath, result)
        return result
      }
    }
  } catch {
    // A Save As will report inaccessible destinations separately.
  }

  const probeName = `.twig-path-case-${randomUUID()}-Aa`
  const probePath = join(directoryPath, probeName)
  let descriptor: number | null = null
  let probeCreated = false
  try {
    descriptor = fs.openSync(probePath, 'wx', 0o600)
    probeCreated = true
    fs.closeSync(descriptor)
    descriptor = null
    const result = existingEntryIsCaseSensitive(directoryPath, probeName)
    if (result !== null) {
      directoryCaseSensitivity.set(directoryPath, result)
      return result
    }
  } catch {
    // Fall back when the directory cannot be probed, such as a read-only location.
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Continue with probe cleanup.
      }
    }
    if (probeCreated) {
      try {
        fs.unlinkSync(probePath)
      } catch {
        // The zero-byte probe is best-effort cleanup only.
      }
    }
  }

  // macOS and Windows filesystems are case-insensitive by default; other supported
  // Unix filesystems are case-sensitive by default. Writable destinations are
  // detected above, including case-sensitive volumes and directories on either OS.
  const fallback = process.platform !== 'darwin' && process.platform !== 'win32'
  directoryCaseSensitivity.set(directoryPath, fallback)
  return fallback
}

export function canonicalPathIdentity(
  filePath: string,
  isCaseSensitive: (directoryPath: string) => boolean = detectDirectoryCaseSensitivity
): string {
  const absolutePath = normalize(resolve(filePath))
  try {
    const stats = fs.statSync(absolutePath, { bigint: true })
    return `inode:${stats.dev}:${stats.ino}`
  } catch {
    // Not-yet-created Save As destinations use a canonical path reservation.
  }

  let identity: string
  let parentPath: string
  try {
    identity = fs.realpathSync.native(absolutePath)
    parentPath = dirname(identity)
  } catch {
    parentPath = fs.realpathSync.native(dirname(absolutePath))
    identity = join(parentPath, absolutePath.slice(dirname(absolutePath).length + 1))
  }
  return isCaseSensitive(parentPath) ? identity : identity.toLowerCase()
}

export class EditorWindowManager<W extends ManagedWindow = ManagedWindow> {
  private readonly editors = new Map<number, EditorWindowRecord<W>>()
  private readonly editorByWebContentsId = new Map<number, number>()
  private readonly auxiliaryOwnerByWebContentsId = new Map<
    number,
    { editorId: number; role: AuxiliaryWindowRole }
  >()
  private focusSequence = 0

  constructor(
    private readonly identifyPath: (filePath: string) => string = canonicalPathIdentity
  ) {}

  private claimMatches(
    claimPath: string | null,
    claimIdentity: string | null,
    filePath: string,
    identity: string
  ): boolean {
    if (!claimPath || !claimIdentity) return false
    if (claimPath === filePath || claimIdentity === identity) return true

    // A reserved Save As destination changes from a path identity to an inode
    // identity after the staged file is installed. Re-identifying the claim also
    // keeps ownership conservative if an owned path is replaced externally.
    try {
      return this.identifyPath(claimPath) === identity
    } catch {
      return false
    }
  }

  registerEditor(window: W, launchFile: string | null = null): EditorWindowRecord<W> {
    const record: EditorWindowRecord<W> = {
      window,
      launchFile,
      currentPath: null,
      currentIdentity: null,
      pendingPath: launchFile,
      pendingIdentity: launchFile ? this.identifyPath(launchFile) : null,
      debugWindow: null,
      presentationWindow: null,
      lastFocusedAt: ++this.focusSequence
    }
    this.editors.set(window.id, record)
    this.editorByWebContentsId.set(window.webContents.id, window.id)
    return record
  }

  unregisterEditor(window: W): EditorWindowRecord<W> | null {
    const record = this.editors.get(window.id) ?? null
    if (!record) return null

    this.editors.delete(window.id)
    this.editorByWebContentsId.delete(window.webContents.id)
    for (const auxiliary of [record.debugWindow, record.presentationWindow]) {
      if (auxiliary) this.auxiliaryOwnerByWebContentsId.delete(auxiliary.webContents.id)
    }
    return record
  }

  getEditors(): EditorWindowRecord<W>[] {
    return [...this.editors.values()].filter((record) => !record.window.isDestroyed())
  }

  getEditor(window: W | null): EditorWindowRecord<W> | null {
    return window ? (this.editors.get(window.id) ?? null) : null
  }

  getEditorByWebContentsId(webContentsId: number): EditorWindowRecord<W> | null {
    const editorId = this.editorByWebContentsId.get(webContentsId)
    return editorId === undefined ? null : (this.editors.get(editorId) ?? null)
  }

  getOwnerByWebContentsId(webContentsId: number): EditorWindowRecord<W> | null {
    const editor = this.getEditorByWebContentsId(webContentsId)
    if (editor) return editor
    const owner = this.auxiliaryOwnerByWebContentsId.get(webContentsId)
    return owner ? (this.editors.get(owner.editorId) ?? null) : null
  }

  noteFocused(window: W): void {
    const owner = this.getEditor(window) ?? this.getOwnerByWebContentsId(window.webContents.id)
    if (owner) owner.lastFocusedAt = ++this.focusSequence
  }

  getActiveEditor(focusedWindow: W | null = null): EditorWindowRecord<W> | null {
    const focusedOwner = focusedWindow
      ? (this.getEditor(focusedWindow) ??
        this.getOwnerByWebContentsId(focusedWindow.webContents.id))
      : null
    if (focusedOwner) return focusedOwner

    return (
      this.getEditors().sort((left, right) => right.lastFocusedAt - left.lastFocusedAt)[0] ?? null
    )
  }

  consumeLaunchFile(window: W): string | null {
    const record = this.getEditor(window)
    if (!record) return null
    const launchFile = record.launchFile
    record.launchFile = null
    return launchFile
  }

  findDocumentOwner(filePath: string, excludingWindow?: W): EditorWindowRecord<W> | null {
    const identity = this.identifyPath(filePath)
    return (
      this.getEditors().find(
        (record) =>
          record.window.id !== excludingWindow?.id &&
          (this.claimMatches(record.currentPath, record.currentIdentity, filePath, identity) ||
            this.claimMatches(record.pendingPath, record.pendingIdentity, filePath, identity))
      ) ?? null
    )
  }

  reserveDocument(window: W, filePath: string): DocumentReservationResult {
    const record = this.getEditor(window)
    if (!record) throw new Error('Document reservations require an editor window')

    const identity = this.identifyPath(filePath)
    if (this.claimMatches(record.currentPath, record.currentIdentity, filePath, identity)) {
      return 'already-current'
    }
    if (this.claimMatches(record.pendingPath, record.pendingIdentity, filePath, identity)) {
      return 'reserved'
    }

    const existingOwner = this.findDocumentOwner(filePath, window)
    if (existingOwner) {
      this.focus(existingOwner.window)
      return 'focused-existing'
    }

    record.pendingPath = filePath
    record.pendingIdentity = identity
    return 'reserved'
  }

  commitDocument(window: W, filePath: string): string | null {
    const record = this.getEditor(window)
    if (!record) throw new Error('Document commits require an editor window')

    const identity = this.identifyPath(filePath)
    if (
      !this.claimMatches(record.pendingPath, record.pendingIdentity, filePath, identity) &&
      !this.claimMatches(record.currentPath, record.currentIdentity, filePath, identity)
    ) {
      throw new Error('Cannot commit an unreserved document')
    }

    const previousPath = record.currentPath
    record.currentPath = filePath
    record.currentIdentity = identity
    record.pendingPath = null
    record.pendingIdentity = null
    return previousPath
  }

  cancelDocument(window: W, filePath: string): void {
    const record = this.getEditor(window)
    if (!record) return
    const identity = this.identifyPath(filePath)
    if (this.claimMatches(record.pendingPath, record.pendingIdentity, filePath, identity)) {
      record.pendingPath = null
      record.pendingIdentity = null
    }
  }

  bindCreatedDocument(window: W, filePath: string): void {
    const result = this.reserveDocument(window, filePath)
    if (result !== 'reserved' && result !== 'already-current') {
      throw new Error('Created document path is already owned by another window')
    }
    this.commitDocument(window, filePath)
  }

  releaseDocument(window: W, filePath: string): void {
    const record = this.getEditor(window)
    if (!record) return
    const identity = this.identifyPath(filePath)
    if (this.claimMatches(record.currentPath, record.currentIdentity, filePath, identity)) {
      record.currentPath = null
      record.currentIdentity = null
    }
    if (this.claimMatches(record.pendingPath, record.pendingIdentity, filePath, identity)) {
      record.pendingPath = null
      record.pendingIdentity = null
    }
  }

  ownsDocument(window: W, filePath: string, includePending = true): boolean {
    const record = this.getEditor(window)
    if (!record) return false
    const identity = this.identifyPath(filePath)
    return (
      this.claimMatches(record.currentPath, record.currentIdentity, filePath, identity) ||
      (includePending &&
        this.claimMatches(record.pendingPath, record.pendingIdentity, filePath, identity))
    )
  }

  attachAuxiliary(owner: W, role: AuxiliaryWindowRole, auxiliary: W): void {
    const record = this.getEditor(owner)
    if (!record) throw new Error('Auxiliary windows require an editor owner')
    if (role === 'debug') record.debugWindow = auxiliary
    else record.presentationWindow = auxiliary
    this.auxiliaryOwnerByWebContentsId.set(auxiliary.webContents.id, {
      editorId: owner.id,
      role
    })
  }

  detachAuxiliary(auxiliary: W): void {
    const owner = this.auxiliaryOwnerByWebContentsId.get(auxiliary.webContents.id)
    if (!owner) return
    const record = this.editors.get(owner.editorId)
    if (record) {
      if (owner.role === 'debug' && record.debugWindow === auxiliary) record.debugWindow = null
      if (owner.role === 'presentation' && record.presentationWindow === auxiliary) {
        record.presentationWindow = null
      }
    }
    this.auxiliaryOwnerByWebContentsId.delete(auxiliary.webContents.id)
  }

  getAuxiliary(owner: W, role: AuxiliaryWindowRole): W | null {
    const record = this.getEditor(owner)
    return role === 'debug' ? (record?.debugWindow ?? null) : (record?.presentationWindow ?? null)
  }

  focus(window: W): void {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    this.noteFocused(window)
  }
}
