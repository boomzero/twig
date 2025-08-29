import { render, screen, cleanup } from '@testing-library/svelte'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import PropertiesPanel from './PropertiesPanel.svelte'
import type { DeckElement, Presentation } from '../lib/state.svelte'

const { mockAppState } = vi.hoisted(() => {
  return {
    mockAppState: {
      presentation: {
        slides: [
          {
            id: 'slide1',
            elements: [] as DeckElement[]
          }
        ]
      } as Presentation,
      selectedObjectId: null as string | null
    }
  }
})

vi.mock('../lib/state.svelte', () => {
  return {
    appState: mockAppState
  }
})

describe('PropertiesPanel.svelte', () => {
  beforeEach(() => {
    mockAppState.selectedObjectId = null
    mockAppState.presentation.slides[0].elements = []
    cleanup()
  })

  it('renders "No object selected." when no object is selected', () => {
    render(PropertiesPanel)
    expect(screen.getByText('No object selected.')).toBeInTheDocument()
  })

  it('renders properties when an object is selected', () => {
    const rectElement: DeckElement = {
      type: 'rect',
      id: 'rect1',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      angle: 0,
      fill: '#ff0000'
    }
    mockAppState.presentation.slides[0].elements.push(rectElement)
    mockAppState.selectedObjectId = 'rect1'

    render(PropertiesPanel)

    expect(screen.getByLabelText('X Position')).toHaveValue(10)
    expect(screen.getByLabelText('Y Position')).toHaveValue(20)
    expect(screen.getByLabelText('Width')).toHaveValue(100)
    expect(screen.getByLabelText('Height')).toHaveValue(50)
    expect(screen.getByLabelText('Angle')).toHaveValue(0)
    expect(screen.getByLabelText('Fill Color')).toHaveValue('#ff0000')
  })
})
