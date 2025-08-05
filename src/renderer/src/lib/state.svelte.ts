// Define the structure for an element on a slide
import { StateHistory } from "runed";
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
  styles?: any
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

// Use $state to create a reactive object for our presentation
export let appState = $state({
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
