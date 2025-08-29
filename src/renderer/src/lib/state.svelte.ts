// Define the structure for an element on a slide
export interface DeckElement {
  type: 'rect' | 'text'
  id: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  fill?: string
  text?: string
  fontSize?: number
  fontFamily?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles?: Record<string, any>
}

// Define the structure for a single slide
export interface Slide {
  id: string
  elements: DeckElement[]
}

// Define the overall structure of your presentation
export interface Presentation {
  slides: Slide[]
}

export interface SelectionState {
  selectedObjectIds: string[]
  selectionStart?: number
  selectionEnd?: number
}

import { StateHistory } from 'runed'

// Use $state to create a reactive object for our presentation
export const appState = $state({
  presentation: {
    slides: [
      {
        id: 'slide1',
        elements: []
      }
    ]
  } as Presentation,
  currentFilePath: null as string | null,
  selectedObjectId: null as string | null
})

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

export const history = new StateHistory(
  () => deepClone(appState.presentation),
  (p) => {
    appState.presentation = p
  }
)
