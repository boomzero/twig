import { describe, expect, it } from 'vitest'
import {
  getAnimationStepKey,
  insertAnimationStep,
  isValidAnimationOrder,
  normalizeAnimationOrder
} from '@renderer/lib/animationUtils'
import type { Slide, TwigElement } from '@renderer/lib/types'

function makeElement(id: string, animations?: TwigElement['animations']): TwigElement {
  return {
    id,
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    text: id,
    zIndex: 0,
    animations
  }
}

describe('src/renderer/src/lib/animationUtils.ts', () => {
  it('prunes animation steps for missing elements or missing animation config', () => {
    const slide: Slide = {
      id: 'slide-1',
      elements: [
        makeElement('a', {
          buildIn: { type: 'appear', duration: 0.2 },
          actions: [{ id: 'move-1', type: 'move', toX: 10, toY: 20, duration: 0.5 }]
        })
      ],
      animationOrder: [
        { elementId: 'a', category: 'buildIn' },
        { elementId: 'a', category: 'action', actionId: 'move-1' },
        { elementId: 'a', category: 'buildOut' },
        { elementId: 'missing', category: 'buildIn' }
      ]
    }

    expect(normalizeAnimationOrder(slide)).toEqual([
      { elementId: 'a', category: 'buildIn' },
      { elementId: 'a', category: 'action', actionId: 'move-1' }
    ])
  })

  it('inserts animation steps while preserving buildIn, action, buildOut order', () => {
    const buildOutOrder = insertAnimationStep([{ elementId: 'a', category: 'buildOut' }], {
      elementId: 'a',
      category: 'buildIn'
    })
    expect(buildOutOrder).toEqual([
      { elementId: 'a', category: 'buildIn' },
      { elementId: 'a', category: 'buildOut' }
    ])

    const actionOrder = insertAnimationStep(buildOutOrder, {
      elementId: 'a',
      category: 'action',
      actionId: 'move-1'
    })
    expect(actionOrder).toEqual([
      { elementId: 'a', category: 'buildIn' },
      { elementId: 'a', category: 'action', actionId: 'move-1' },
      { elementId: 'a', category: 'buildOut' }
    ])
  })

  it('validates legal and illegal animation orderings', () => {
    expect(
      isValidAnimationOrder([
        { elementId: 'a', category: 'buildIn' },
        { elementId: 'a', category: 'action', actionId: 'move-1' },
        { elementId: 'a', category: 'buildOut' },
        { elementId: 'b', category: 'buildOut' }
      ])
    ).toBe(true)

    expect(
      isValidAnimationOrder([
        { elementId: 'a', category: 'action', actionId: 'move-1' },
        { elementId: 'a', category: 'buildIn' }
      ])
    ).toBe(false)

    expect(
      isValidAnimationOrder([
        { elementId: 'a', category: 'buildIn' },
        { elementId: 'a', category: 'buildOut' },
        { elementId: 'a', category: 'action', actionId: 'move-1' }
      ])
    ).toBe(false)
  })

  it('creates stable keys for action and non-action steps', () => {
    expect(getAnimationStepKey({ elementId: 'a', category: 'buildIn' })).toBe('a::buildIn')
    expect(getAnimationStepKey({ elementId: 'a', category: 'action', actionId: 'move-1' })).toBe(
      'a::action::move-1'
    )
    expect(getAnimationStepKey({ elementId: 'a', category: 'action' })).toBe('a::action::missing')
  })
})
