/**
 * Debug Window Entry Point
 *
 * This window displays the application state in real-time.
 * It receives state updates from the main window via IPC.
 */

import './assets/main.css'
import { mount } from 'svelte'
import Debug from './Debug.svelte'
import { setupI18n } from './lib/i18n'

const savedLocale = (await window.api.prefs.get('locale')) as string | null
await setupI18n(savedLocale)

const app = mount(Debug, {
  target: document.getElementById('app')!
})

export default app
