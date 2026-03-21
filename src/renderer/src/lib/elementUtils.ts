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

/**
 * Computes the final insertion index for a drag-and-drop reorder operation.
 *
 * After removing the dragged item at `fromIndex`, the target index shifts if
 * the dragged item was before the target. `position` then offsets by one more
 * for 'after' drops. Used in StackPanel and AnimationOrderPanel.
 */
export function computeDropInsertIndex(
  fromIndex: number,
  toIndex: number,
  position: 'before' | 'after'
): number {
  const adjusted = fromIndex < toIndex ? toIndex - 1 : toIndex
  return position === 'after' ? adjusted + 1 : adjusted
}
