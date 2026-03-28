import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

type Locale = 'en' | 'zh'

interface Prefs {
  locale: Locale
  autoUpdate: boolean
}

const PREFS_PATH = join(app.getPath('userData'), 'twig-prefs.json')

// In-memory cache — avoids repeated readFileSync on every getPref call
let cache: Prefs | null = null

function detectLocale(): Locale {
  return app.getLocale().startsWith('zh') ? 'zh' : 'en'
}

function load(): Prefs {
  if (cache) return cache
  try {
    if (existsSync(PREFS_PATH)) {
      const saved = JSON.parse(readFileSync(PREFS_PATH, 'utf-8')) as Partial<Prefs>
      // First boot: locale key absent — detect from system and persist
      if (!saved.locale) {
        saved.locale = detectLocale()
        writeFileSync(PREFS_PATH, JSON.stringify(saved), 'utf-8')
      }
      cache = { autoUpdate: true, ...saved } as Prefs
      return cache
    }
  } catch {
    // Corrupted file — fall through to defaults
  }
  const defaults: Prefs = { locale: detectLocale(), autoUpdate: true }
  writeFileSync(PREFS_PATH, JSON.stringify(defaults), 'utf-8')
  cache = defaults
  return cache
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] {
  return load()[key]
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  cache = { ...load(), [key]: value }
  writeFileSync(PREFS_PATH, JSON.stringify(cache), 'utf-8')
}
