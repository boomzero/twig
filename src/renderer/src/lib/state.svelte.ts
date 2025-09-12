import type { Slide } from '../../../types'

export interface SelectionState {
  selectedObjectIds: string[]
  selectionStart?: number
  selectionEnd?: number
}

// Use $state to create a reactive object for our application state
export const appState = $state({
  currentFilePath: null as string | null,
  slides: [] as Pick<Slide, 'id' | 'slideNumber'>[],
  activeSlide: null as Slide | null,
  selectedObjectId: null as string | null
})
