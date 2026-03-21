import type { TwigElement, Slide, AnimationStep } from './types'

/**
 * Returns true if the element has the animation config referenced by the step.
 * Used by both normalizeAnimationOrder (pruning) and executeNextAnimation (skip check).
 */
export function isStepConfiguredForElement(el: TwigElement, step: AnimationStep): boolean {
  if (!el.animations) return false
  if (step.category === 'action') {
    return !!step.actionId && !!el.animations.actions?.some((a) => a.id === step.actionId)
  }
  return !!el.animations[step.category]
}

/**
 * Prunes animationOrder steps whose elementId no longer exists in slide.elements,
 * or whose category is no longer configured on that element.
 * Does NOT auto-append — new steps are added explicitly in handleAnimationChange.
 */
export function normalizeAnimationOrder(slide: Slide): AnimationStep[] {
  const elementMap = new Map(slide.elements.map((e) => [e.id, e]))
  return slide.animationOrder.filter((step) => {
    const el = elementMap.get(step.elementId)
    if (!el) return false
    return isStepConfiguredForElement(el, step)
  })
}

/**
 * Inserts a new step into an ordered animation sequence while preserving the
 * per-element timeline invariant: buildIn → (actions, in any order) → buildOut.
 */
export function insertAnimationStep(order: AnimationStep[], step: AnimationStep): AnimationStep[] {
  // Keep a predictable per-element timeline: buildIn -> actions -> buildOut.
  const sameElementIndexes = order
    .map((existing, index) => ({ existing, index }))
    .filter(({ existing }) => existing.elementId === step.elementId)

  if (sameElementIndexes.length === 0) {
    return [...order, step]
  }

  if (step.category === 'buildIn') {
    const insertAt = sameElementIndexes[0].index
    return [...order.slice(0, insertAt), step, ...order.slice(insertAt)]
  }

  if (step.category === 'action') {
    const firstBuildOut = sameElementIndexes.find(({ existing }) => existing.category === 'buildOut')
    if (firstBuildOut) {
      const insertAt = firstBuildOut.index
      return [...order.slice(0, insertAt), step, ...order.slice(insertAt)]
    }

    const lastCompatible = [...sameElementIndexes]
      .reverse()
      .find(({ existing }) => existing.category === 'buildIn' || existing.category === 'action')
    if (lastCompatible) {
      const insertAt = lastCompatible.index + 1
      return [...order.slice(0, insertAt), step, ...order.slice(insertAt)]
    }
  }

  const insertAt = sameElementIndexes[sameElementIndexes.length - 1].index + 1
  return [...order.slice(0, insertAt), step, ...order.slice(insertAt)]
}

/**
 * Validates that the per-element ordering invariant holds after a drag reorder:
 *   buildIn → (actions, in any order) → buildOut
 *
 * Two-pass approach: the first pass collects which categories each element has
 * (needed because a step's element may appear later in the list), then the
 * second pass enforces the ordering. Returns false on the first violation found.
 */
export function isValidAnimationOrder(steps: AnimationStep[]): boolean {
  // Pass 1: collect which terminal categories each element has configured.
  const elementMeta = new Map<string, { hasBuildIn: boolean; hasBuildOut: boolean }>()
  for (const step of steps) {
    const meta = elementMeta.get(step.elementId) ?? { hasBuildIn: false, hasBuildOut: false }
    if (step.category === 'buildIn') meta.hasBuildIn = true
    if (step.category === 'buildOut') meta.hasBuildOut = true
    elementMeta.set(step.elementId, meta)
  }

  // Pass 2: walk steps in order, tracking what has been seen per element.
  const seenByElement = new Map<string, { buildIn: boolean; buildOut: boolean; action: boolean }>()
  for (const step of steps) {
    const meta = elementMeta.get(step.elementId) ?? { hasBuildIn: false, hasBuildOut: false }
    const seen = seenByElement.get(step.elementId) ?? { buildIn: false, buildOut: false, action: false }

    if (step.category === 'buildIn') {
      if (seen.action || seen.buildOut) return false
      seen.buildIn = true
    } else if (step.category === 'action') {
      if ((meta.hasBuildIn && !seen.buildIn) || seen.buildOut) return false
      seen.action = true
    } else {
      if ((meta.hasBuildIn && !seen.buildIn) || seen.buildOut) return false
      seen.buildOut = true
    }

    seenByElement.set(step.elementId, seen)
  }

  return true
}

/**
 * Stable {#each} key for an animation step. Action steps need actionId included
 * because one element can have multiple moves — elementId::action alone collides.
 */
export function getAnimationStepKey(step: AnimationStep): string {
  return step.category === 'action'
    ? `${step.elementId}::action::${step.actionId ?? 'missing'}`
    : `${step.elementId}::${step.category}`
}
