import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { canonicalPathIdentity, EditorWindowManager } from '../../src/main/editorWindowManager'

class FakeWindow {
  static nextId = 1
  id = FakeWindow.nextId++
  private readonly managedWebContents = { id: this.id * 10 }
  throwOnWebContentsAccess = false
  destroyed = false
  minimized = false
  restore = vi.fn(() => {
    this.minimized = false
  })
  show = vi.fn()
  focus = vi.fn()

  get webContents(): { id: number } {
    if (this.throwOnWebContentsAccess) throw new Error('Object has been destroyed')
    return this.managedWebContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }
}

describe('EditorWindowManager', () => {
  it('uses the same identity for a file and a symlink alias', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const filePath = join(directory, 'deck.tb')
      const aliasPath = join(directory, 'alias.tb')
      fs.writeFileSync(filePath, '')
      fs.symlinkSync(filePath, aliasPath)
      expect(canonicalPathIdentity(aliasPath)).toBe(canonicalPathIdentity(filePath))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('uses the same identity for hard links to an existing file', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const filePath = join(directory, 'deck.tb')
      const aliasPath = join(directory, 'hard-link.tb')
      fs.writeFileSync(filePath, '')
      fs.linkSync(filePath, aliasPath)

      expect(canonicalPathIdentity(aliasPath)).toBe(canonicalPathIdentity(filePath))

      const manager = new EditorWindowManager<FakeWindow>()
      const first = new FakeWindow()
      const second = new FakeWindow()
      manager.registerEditor(first)
      manager.registerEditor(second)
      expect(manager.reserveDocument(first, filePath)).toBe('reserved')
      manager.commitDocument(first, filePath)
      expect(manager.reserveDocument(second, aliasPath)).toBe('focused-existing')
      expect(first.focus).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('normalizes pending paths on a case-insensitive filesystem', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const upperCasePath = join(directory, 'Deck.tb')
      const lowerCasePath = join(directory, 'deck.tb')
      const identifyPath = (filePath: string): string =>
        canonicalPathIdentity(filePath, () => false)

      expect(identifyPath(upperCasePath)).toBe(identifyPath(lowerCasePath))

      const manager = new EditorWindowManager<FakeWindow>(identifyPath)
      const first = new FakeWindow()
      const second = new FakeWindow()
      manager.registerEditor(first)
      manager.registerEditor(second)

      expect(manager.reserveDocument(first, upperCasePath)).toBe('reserved')
      expect(manager.reserveDocument(second, lowerCasePath)).toBe('focused-existing')
      expect(first.focus).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves distinct pending paths on a case-sensitive filesystem', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const upperCasePath = join(directory, 'Deck.tb')
      const lowerCasePath = join(directory, 'deck.tb')
      expect(canonicalPathIdentity(upperCasePath, () => true)).not.toBe(
        canonicalPathIdentity(lowerCasePath, () => true)
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('detects the case behavior of the destination filesystem', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const probePath = join(directory, 'CaseProbe')
      const alternateProbePath = join(directory, 'caseProbe')
      fs.writeFileSync(probePath, '')
      const probe = fs.lstatSync(probePath)
      let caseInsensitive = false
      try {
        const alternateProbe = fs.lstatSync(alternateProbePath)
        caseInsensitive = probe.dev === alternateProbe.dev && probe.ino === alternateProbe.ino
      } catch {
        // The alternate spelling does not exist on a case-sensitive filesystem.
      }
      fs.unlinkSync(probePath)

      const identitiesMatch =
        canonicalPathIdentity(join(directory, 'Deck.tb')) ===
        canonicalPathIdentity(join(directory, 'deck.tb'))
      expect(identitiesMatch).toBe(caseInsensitive)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('tracks independent documents and focuses an existing duplicate owner', () => {
    const manager = new EditorWindowManager<FakeWindow>((path) => path.toLowerCase())
    const first = new FakeWindow()
    const second = new FakeWindow()
    manager.registerEditor(first)
    manager.registerEditor(second)

    expect(manager.reserveDocument(first, '/Deck.tb')).toBe('reserved')
    manager.commitDocument(first, '/Deck.tb')
    expect(manager.reserveDocument(second, '/deck.tb')).toBe('focused-existing')
    expect(first.focus).toHaveBeenCalledOnce()
  })

  it('keeps current ownership while a replacement is pending and rolls it back', () => {
    const manager = new EditorWindowManager<FakeWindow>((path) => path)
    const window = new FakeWindow()
    manager.registerEditor(window)
    manager.bindCreatedDocument(window, '/temp.tb')

    expect(manager.reserveDocument(window, '/next.tb')).toBe('reserved')
    expect(manager.ownsDocument(window, '/temp.tb')).toBe(true)
    expect(manager.ownsDocument(window, '/next.tb')).toBe(true)
    manager.cancelDocument(window, '/next.tb')
    expect(manager.ownsDocument(window, '/temp.tb')).toBe(true)
    expect(manager.ownsDocument(window, '/next.tb')).toBe(false)
  })

  it('commits a replacement and releases the previous identity', () => {
    const manager = new EditorWindowManager<FakeWindow>((path) => path)
    const window = new FakeWindow()
    manager.registerEditor(window)
    manager.bindCreatedDocument(window, '/before.tb')
    manager.reserveDocument(window, '/after.tb')

    expect(manager.commitDocument(window, '/after.tb')).toBe('/before.tb')
    expect(manager.ownsDocument(window, '/before.tb')).toBe(false)
    expect(manager.ownsDocument(window, '/after.tb')).toBe(true)
  })

  it('commits a pending destination after it gains an inode identity', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const filePath = join(directory, 'saved.tb')
      const manager = new EditorWindowManager<FakeWindow>()
      const window = new FakeWindow()
      manager.registerEditor(window)

      expect(manager.reserveDocument(window, filePath)).toBe('reserved')
      fs.writeFileSync(filePath, '')
      expect(manager.commitDocument(window, filePath)).toBeNull()
      expect(manager.ownsDocument(window, filePath)).toBe(true)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('cancels a pending destination after it gains an inode identity', () => {
    const directory = fs.mkdtempSync(join(os.tmpdir(), 'twig-window-manager-'))
    try {
      const filePath = join(directory, 'failed-save.tb')
      const manager = new EditorWindowManager<FakeWindow>()
      const window = new FakeWindow()
      manager.registerEditor(window)

      expect(manager.reserveDocument(window, filePath)).toBe('reserved')
      fs.writeFileSync(filePath, '')
      manager.cancelDocument(window, filePath)
      expect(manager.ownsDocument(window, filePath)).toBe(false)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('routes auxiliary windows back to their owning editor', () => {
    const manager = new EditorWindowManager<FakeWindow>((path) => path)
    const editor = new FakeWindow()
    const debug = new FakeWindow()
    const presentation = new FakeWindow()
    manager.registerEditor(editor)
    manager.attachAuxiliary(editor, 'debug', debug)
    manager.attachAuxiliary(editor, 'presentation', presentation)

    expect(manager.getOwnerByWebContentsId(debug.webContents.id)?.window).toBe(editor)
    expect(manager.getOwnerByWebContentsId(presentation.webContents.id)?.window).toBe(editor)
    manager.detachAuxiliary(debug)
    expect(manager.getOwnerByWebContentsId(debug.webContents.id)).toBeNull()
  })

  it('unregisters destroyed editor and auxiliary windows without reading webContents', () => {
    const manager = new EditorWindowManager<FakeWindow>((path) => path)
    const editor = new FakeWindow()
    const debug = new FakeWindow()
    const presentation = new FakeWindow()
    const editorWebContentsId = editor.webContents.id
    const debugWebContentsId = debug.webContents.id
    const presentationWebContentsId = presentation.webContents.id
    manager.registerEditor(editor)
    manager.attachAuxiliary(editor, 'debug', debug)
    manager.attachAuxiliary(editor, 'presentation', presentation)

    editor.destroyed = true
    debug.destroyed = true
    presentation.destroyed = true
    editor.throwOnWebContentsAccess = true
    debug.throwOnWebContentsAccess = true
    presentation.throwOnWebContentsAccess = true

    expect(() => manager.detachAuxiliary(debug)).not.toThrow()
    expect(() => manager.unregisterEditor(editor)).not.toThrow()
    expect(manager.getEditorByWebContentsId(editorWebContentsId)).toBeNull()
    expect(manager.getOwnerByWebContentsId(debugWebContentsId)).toBeNull()
    expect(manager.getOwnerByWebContentsId(presentationWebContentsId)).toBeNull()
  })
})
