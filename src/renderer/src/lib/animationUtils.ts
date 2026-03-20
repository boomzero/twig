import type { Slide, AnimationStep } from './types'

/**
 * Prunes animationOrder steps whose elementId no longer exists in slide.elements,
 * or whose category is no longer configured on that element.
 * Does NOT auto-append — new steps are added explicitly in handleAnimationChange.
 */
export function normalizeAnimationOrder(slide: Slide): AnimationStep[] {
  const elementMap = new Map(slide.elements.map((e) => [e.id, e]))
  return slide.animationOrder.filter((step) => {
    const el = elementMap.get(step.elementId)
    if (!el?.animations) return false
    if (step.category === 'action') {
      if (!step.actionId) return false
      return !!el.animations.actions?.some((a) => a.id === step.actionId)
    }
    return !!el.animations[step.category]
  })
}
