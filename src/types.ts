export interface DeckElement {
  id: string
  type: 'rect' | 'text'
  x: number
  y: number
  width: number
  height: number
  angle: number
  fill: string
  text?: string
  fontSize?: number
  fontFamily?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles?: any
}

export interface Slide {
  id: string
  slideNumber: number
  elements: DeckElement[]
}

export interface Presentation {
  slides: Slide[]
}
