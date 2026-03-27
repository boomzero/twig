import { addMessages, init, locale } from 'svelte-i18n'
import en from './en.json'
import zh from './zh.json'

export type SupportedLocale = 'en' | 'zh'

export function setupI18n(savedLocale?: string | null): Promise<void> {
  addMessages('en', en)
  addMessages('zh', zh)
  const resolved: SupportedLocale =
    savedLocale === 'zh' ? 'zh' : savedLocale === 'en' ? 'en' : 'en'
  return init({ fallbackLocale: 'en', initialLocale: resolved })
}

export async function changeLocale(l: SupportedLocale): Promise<void> {
  locale.set(l)
  await window.api.prefs.set('locale', l)
}
