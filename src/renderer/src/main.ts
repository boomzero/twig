import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'
import { normalizeLocale, setupI18n } from './lib/i18n'
import twigLogo from '../../../resources/icon.png?asset'

const savedLocale = (await window.api.prefs.get('locale')) as string | null
const bootLocale = normalizeLocale(savedLocale ?? navigator.language)

// SYNC REQUIRED: These strings must match the i18n keys loading.title / loading.booting
// in src/renderer/src/lib/i18n/en.json and zh.json. They are duplicated here because
// i18n is not yet initialized when the boot splash is first displayed.
const bootCopy = {
  en: { title: 'Loading...', detail: 'Preparing the editor' },
  zh: { title: '加载中…', detail: '正在准备编辑器' }
} as const

document.documentElement.lang = bootLocale

const bootLogo = document.getElementById('boot-logo') as HTMLImageElement | null
if (bootLogo) {
  bootLogo.src = twigLogo
  bootLogo.hidden = false
}

const bootTitle = document.getElementById('boot-title')
if (bootTitle) {
  bootTitle.textContent = bootCopy[bootLocale].title
}

const bootDetail = document.getElementById('boot-detail')
if (bootDetail) {
  bootDetail.textContent = bootCopy[bootLocale].detail
}

await setupI18n(bootLocale)

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
