/**
 * Shared renderer-side type definitions for twig.
 *
 * These types are used by both the main editor (App.svelte) and the
 * presentation window (Presentation.svelte). Keeping them in one place
 * prevents the two from drifting apart when new fields are added.
 */

/**
 * Represents a single element (shape, text, or image) on a slide.
 */
export interface TwigElement {
  /** Type of element - rectangle shape, text, or image */
  type: 'rect' | 'text' | 'image'

  /** Unique identifier for this element */
  id: string

  /** X coordinate (center point due to fabric.js origin settings) */
  x: number

  /** Y coordinate (center point due to fabric.js origin settings) */
  y: number

  /** Width of the element in pixels */
  width: number

  /** Height of the element in pixels */
  height: number

  /** Rotation angle in degrees */
  angle: number

  /** Fill color (hex or rgba string) */
  fill?: string

  /** Text content (only for text elements) */
  text?: string

  /** Font size in pixels (only for text elements) */
  fontSize?: number

  /** Font family name (only for text elements) */
  fontFamily?: string

  /** Rich text styles object from fabric.js (only for text elements) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles?: Record<string, any>

  /** Image data as base64 data URI (only for image elements) */
  src?: string

  /** Original image filename (only for image elements) */
  filename?: string

  /** Z-index for layer ordering (higher = in front) */
  zIndex: number
}

/**
 * Describes the background of a slide — solid color, linear gradient, or image.
 */
export type SlideBackground =
  | { type: 'solid'; color: string }
  | {
      type: 'gradient'
      angle: number
      stops: [{ offset: 0; color: string }, { offset: 1; color: string }]
    }
  | { type: 'image'; src: string; filename?: string; fit?: 'stretch' | 'contain' | 'cover' }

/**
 * Represents a single slide containing multiple elements.
 */
export interface Slide {
  /** Unique identifier for this slide */
  id: string

  /** Array of elements (shapes, text, images) on this slide */
  elements: TwigElement[]

  /** Optional background — null/undefined means white */
  background?: SlideBackground
}
