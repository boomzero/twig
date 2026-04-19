import { Textbox } from 'fabric'

const CJK_GRAPHEME_WRAP_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u

/**
 * Fabric textboxes wrap on whitespace by default. CJK text often has no spaces,
 * so opt those textboxes into grapheme-based wrapping instead.
 */
export function shouldSplitTextboxByGrapheme(text: string | null | undefined): boolean {
  return typeof text === 'string' && CJK_GRAPHEME_WRAP_RE.test(text)
}

export function getTextboxWrappingOptions(
  text: string | null | undefined
): {
  splitByGrapheme: boolean
} {
  return {
    splitByGrapheme: shouldSplitTextboxByGrapheme(text)
  }
}

export function syncTextboxWrapping(textbox: Textbox): boolean {
  const nextSplitByGrapheme = shouldSplitTextboxByGrapheme(textbox.text)
  if (textbox.splitByGrapheme === nextSplitByGrapheme) {
    return false
  }

  textbox.splitByGrapheme = nextSplitByGrapheme
  textbox.dirty = true
  textbox.initDimensions()
  textbox.setCoords()
  return true
}
