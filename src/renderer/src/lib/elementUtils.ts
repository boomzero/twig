import type { TwigElement } from './state.svelte'

/** Returns a human-readable label for an element, used in layer and animation panels. */
export function getElementLabel(el: TwigElement): string {
  if (el.type === 'text') {
    const preview = el.text?.slice(0, 20) ?? ''
    return `Text: ${preview}${(el.text?.length ?? 0) > 20 ? '…' : ''}`
  }
  if (el.type === 'image') return `Image: ${el.filename ?? 'image'}`
  return 'Shape'
}
