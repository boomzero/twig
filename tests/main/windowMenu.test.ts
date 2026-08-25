import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { createWindowMenu } from '../../src/main/windowMenu'

describe('createWindowMenu', () => {
  it('uses the native window menu role and standard window controls', () => {
    const showEditorWindow = vi.fn()
    const menu = createWindowMenu(showEditorWindow)
    const submenu = menu.submenu as MenuItemConstructorOptions[]

    expect(menu.role).toBe('windowMenu')
    expect(submenu.map((item) => item.role).filter(Boolean)).toEqual([
      'minimize',
      'zoom',
      'togglefullscreen',
      'front'
    ])

    const showEditorItem = submenu.find((item) => item.label === 'Show Editor Window')
    expect(showEditorItem?.click).toBe(showEditorWindow)
  })
})
