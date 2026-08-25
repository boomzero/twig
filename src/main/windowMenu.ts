import type { MenuItemConstructorOptions } from 'electron'

export function createWindowMenu(onShowEditorWindow: () => void): MenuItemConstructorOptions {
  return {
    label: 'Window',
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      {
        label: 'Show Editor Window',
        click: onShowEditorWindow
      },
      { type: 'separator' },
      { role: 'front' }
    ]
  }
}
