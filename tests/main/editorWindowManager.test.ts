import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { canonicalPathIdentity, EditorWindowManager } from '../../src/main/editorWindowManager'

class FakeWindow {
  static nextId = 1
  id = FakeWindow.nextId++
  webContents = { id: this.id * 10 }
  destroyed = false
  minimized = false
  restore = vi.fn(() => {
    this.minimized = false
  })
  show = vi.fn()
  focus = vi.fn()

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
})
