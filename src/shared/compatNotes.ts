/**
 * Resolves a `compat_notes` raw value against a runtime locale.
 *
 * Writers may store the notes as either a plain string or a JSON object keyed
 * by BCP-47 locale. Readers pick the best match in this order:
 *   the exact locale -> language prefix (`zh-CN` -> `zh`) -> `_default` ->
 *   `en` -> any remaining string value.
 *
 * Never throws: malformed JSON degrades to the raw string.
 */
export function resolveCompatNotes(raw: string, locale: string): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
  const map = parsed as Record<string, unknown>
  const candidates = [locale, locale.split('-')[0], '_default', 'en']
  for (const key of candidates) {
    const val = map[key]
    if (typeof val === 'string' && val.length > 0) return val
  }

  // Object insertion order is intentionally only a last-ditch fallback; writers
  // should provide `_default` or `en` when the text needs to be deterministic.
  for (const val of Object.values(map)) {
    if (typeof val === 'string' && val.length > 0) return val
  }
  return ''
}
