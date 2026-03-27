import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'
import { setupI18n } from './lib/i18n'

const savedLocale = (await window.api.prefs.get('locale')) as string | null
await setupI18n(savedLocale)

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
