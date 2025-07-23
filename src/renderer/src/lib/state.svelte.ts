// Define the structure for an element on a slide
export interface DeckElement {
  type: 'rect' | 'text';
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  text?: string;
}

// Define the structure for a single slide
export interface Slide {
  id: string;
  elements: DeckElement[];
}

// Use $state to create a reactive object for our presentation
export const presentation = $state({
  slides: [
    {
      id: 'slide1',
      elements: []
    }
  ] as Slide[]
});
