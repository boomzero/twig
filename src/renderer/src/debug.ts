/**
 * Debug Window Entry Point
 *
 * This window displays the application state in real-time.
 * It receives state updates from the main window via IPC.
 */

import './assets/main.css'
import { mount } from 'svelte'
import Debug from './Debug.svelte'
import { normalizeLocale, setupI18n } from './lib/i18n'
import { locale } from 'svelte-i18n'

const savedLocale = await window.api.debug.getLocale()
await setupI18n(savedLocale)

// Keep in sync when the user changes language in the main window
window.api.debug.onLocaleChanged((newLocale) => {
  locale.set(normalizeLocale(newLocale))
})

const app = mount(Debug, {
  target: document.getElementById('app')!
})

export default app
