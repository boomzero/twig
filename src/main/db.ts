import type { Database } from 'better-sqlite3'
import { v4 as uuid_v4 } from 'uuid'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a single element (shape or text) on a slide.
 * Elements can be rectangles or text objects with various styling properties.
 */
export interface DeckElement {
  /** Type of element - either a rectangle shape or text */
  type: 'rect' | 'text'

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
}

/**
 * Represents a single slide containing multiple elements.
 */
export interface Slide {
  /** Unique identifier for this slide */
  id: string

  /** Array of elements (shapes, text) on this slide */
  elements: DeckElement[]
}

// ============================================================================
// Database Schema Management
// ============================================================================

/**
 * Initializes the database schema by creating required tables if they don't exist.
 *
 * Schema consists of:
 * - slides table: Stores slide metadata and ordering
 * - elements table: Stores all properties of shapes and text on each slide
 *
 * @param db - The SQLite database connection to initialize
 */
export function initializeDatabase(db: Database): void {
  // Create the slides table to store slide metadata and ordering
  db.exec(`
    CREATE TABLE IF NOT EXISTS slides (
      id TEXT PRIMARY KEY,
      slide_order INTEGER
    )
  `)

  // Create the elements table to store all shape and text properties
  // Uses CASCADE deletion to automatically remove elements when a slide is deleted
  db.exec(`
    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      slide_id TEXT,
      type TEXT,
      x REAL,
      y REAL,
      width REAL,
      height REAL,
      angle REAL,
      fill TEXT,
      text TEXT,
      fontSize REAL,
      fontFamily TEXT,
      styles TEXT,
      FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
    )
  `)
}

// ============================================================================
// Data Retrieval Functions
// ============================================================================

/**
 * Retrieves all slide IDs from the database in their display order.
 *
 * @param db - The SQLite database connection
 * @returns Array of slide IDs ordered by slide_order column
 */
export function getSlideIds(db: Database): string[] {
  const stmt = db.prepare('SELECT id FROM slides ORDER BY slide_order')
  const rows = stmt.all() as { id: string }[]
  return rows.map((row) => row.id)
}

/**
 * Represents a database row from the elements table.
 * The styles field is stored as a JSON string in the database.
 */
interface ElementRow {
  id: string
  slide_id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle: number
  fill?: string
  text?: string
  fontSize?: number
  fontFamily?: string
  styles?: string | null // Stored as JSON string in database
}

/**
 * Retrieves a complete slide with all its elements.
 *
 * @param db - The SQLite database connection
 * @param slideId - The unique identifier of the slide to retrieve
 * @returns The slide object with all its elements, or null if not found
 */
export function getSlide(db: Database, slideId: string): Slide | null {
  // First, check if the slide exists
  const slideRow = db.prepare('SELECT * FROM slides WHERE id = ?').get(slideId) as
    | { id: string }
    | undefined
  if (!slideRow) {
    return null
  }

  // Load all elements belonging to this slide
  const elementStmt = db.prepare('SELECT * FROM elements WHERE slide_id = ?')
  const elementRows = elementStmt.all(slideId) as ElementRow[]

  const elements: DeckElement[] = elementRows.map((el) => ({
    type: el.type as 'rect' | 'text',
    id: el.id,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    angle: el.angle,
    fill: el.fill,
    text: el.text,
    fontSize: el.fontSize,
    fontFamily: el.fontFamily,
    // Parse the styles JSON string back into an object with error handling
    styles: el.styles
      ? (() => {
          try {
            return JSON.parse(el.styles)
          } catch (error) {
            console.error(`Failed to parse styles for element ${el.id}:`, error)
            return undefined
          }
        })()
      : undefined
  }))

  return { id: slideRow.id, elements }
}

// ============================================================================
// Data Persistence Functions
// ============================================================================

/**
 * Validates and repairs slide order to ensure sequential ordering starting from 0.
 * This function ensures there are no gaps in slide_order values and that they
 * start from 0 and increment by 1.
 *
 * @param db - The SQLite database connection
 */
function validateAndRepairSlideOrder(db: Database): void {
  // Get all slides ordered by their current slide_order
  const slides = db
    .prepare('SELECT id, slide_order FROM slides ORDER BY slide_order')
    .all() as { id: string; slide_order: number }[]

  // Check if reordering is needed
  let needsRepair = false
  for (let i = 0; i < slides.length; i++) {
    if (slides[i].slide_order !== i) {
      needsRepair = true
      break
    }
  }

  // If ordering is already correct, no action needed
  if (!needsRepair) {
    return
  }

  // Repair: reassign sequential orders starting from 0
  const updateStmt = db.prepare('UPDATE slides SET slide_order = ? WHERE id = ?')
  for (let i = 0; i < slides.length; i++) {
    updateStmt.run(i, slides[i].id)
  }
}

/**
 * Saves a slide and all its elements to the database.
 *
 * This function handles both inserting new slides and updating existing ones:
 * - For existing slides: Deletes all old elements and replaces them with current elements
 * - For new slides: Creates the slide entry and assigns it the next available order
 *
 * All operations are wrapped in a transaction for consistency.
 * After creating new slides, validates and repairs slide order if needed.
 *
 * @param db - The SQLite database connection
 * @param slide - The slide object to save (with all its elements)
 */
export function saveSlide(db: Database, slide: Slide): void {
  const transaction = db.transaction((s: Slide) => {
    // Check if this slide already exists in the database
    const slideInfo = db.prepare('SELECT slide_order FROM slides WHERE id = ?').get(s.id) as
      | { slide_order: number }
      | undefined

    let isNewSlide = false
    if (slideInfo) {
      // Slide exists - delete all its old elements (we'll re-insert them below)
      db.prepare('DELETE FROM elements WHERE slide_id = ?').run(s.id)
    } else {
      // New slide - create the slide entry with the next available order
      isNewSlide = true
      const maxOrder = db.prepare('SELECT MAX(slide_order) as max FROM slides').get() as {
        max: number | null
      }
      const newOrder = maxOrder.max === null ? 0 : maxOrder.max + 1
      db.prepare('INSERT INTO slides (id, slide_order) VALUES (?, ?)').run(s.id, newOrder)
    }

    // Prepare the element insert statement (reused for all elements for efficiency)
    const elementInsert = db.prepare(
      'INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, styles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )

    // Insert all elements for this slide
    s.elements.forEach((el) => {
      // Serialize styles with error handling
      let stylesJson: string | null = null
      if (el.styles) {
        try {
          stylesJson = JSON.stringify(el.styles)
        } catch (error) {
          console.error(`Failed to serialize styles for element ${el.id}:`, error)
          // Continue without styles rather than failing the entire save
          stylesJson = null
        }
      }

      elementInsert.run(
        el.id,
        s.id,
        el.type,
        el.x,
        el.y,
        el.width,
        el.height,
        el.angle,
        el.fill,
        el.text,
        el.fontSize,
        el.fontFamily,
        stylesJson
      )
    })

    // If this was a new slide, validate and repair slide order to ensure no gaps
    if (isNewSlide) {
      validateAndRepairSlideOrder(db)
    }
  })

  // Execute the transaction
  transaction(slide)
}

/**
 * Creates a new blank slide and saves it to the database.
 *
 * The slide is assigned a unique ID and initialized with no elements.
 * It is immediately persisted to the database.
 *
 * @param db - The SQLite database connection
 * @returns The newly created slide object
 */
export function createSlide(db: Database): Slide {
  const newSlide: Slide = {
    id: uuid_v4(),
    elements: []
  }

  saveSlide(db, newSlide)
  return newSlide
}

/**
 * Saves multiple slides to the database in a single transaction.
 *
 * This ensures atomicity - either all slides are saved or none are.
 * This is critical for Save As operations to prevent partial writes.
 * After creating new slides, validates and repairs slide order if needed.
 *
 * @param db - The SQLite database connection
 * @param slides - Array of slides to save
 * @throws Error if duplicate slide IDs are detected
 */
export function saveAllSlides(db: Database, slides: Slide[]): void {
  // Validate that all slide IDs are unique before proceeding
  const slideIds = new Set<string>()
  for (const slide of slides) {
    if (slideIds.has(slide.id)) {
      throw new Error(
        `Duplicate slide ID detected: ${slide.id}. Cannot save presentation with duplicate slides.`
      )
    }
    slideIds.add(slide.id)
  }

  const transaction = db.transaction((slidesToSave: Slide[]) => {
    let hasNewSlides = false
    for (let index = 0; index < slidesToSave.length; index++) {
      const slide = slidesToSave[index]
      // Check if this slide already exists in the database
      const slideInfo = db.prepare('SELECT slide_order FROM slides WHERE id = ?').get(slide.id) as
        | { slide_order: number }
        | undefined

      if (slideInfo) {
        // Slide exists - update its order and delete all its old elements
        db.prepare('UPDATE slides SET slide_order = ? WHERE id = ?').run(index, slide.id)
        db.prepare('DELETE FROM elements WHERE slide_id = ?').run(slide.id)
      } else {
        // New slide - create the slide entry with the correct order
        hasNewSlides = true
        db.prepare('INSERT INTO slides (id, slide_order) VALUES (?, ?)').run(slide.id, index)
      }

      // Prepare the element insert statement (reused for all elements for efficiency)
      const elementInsert = db.prepare(
        'INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, styles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )

      // Insert all elements for this slide
      slide.elements.forEach((el) => {
        // Serialize styles with error handling
        let stylesJson: string | null = null
        if (el.styles) {
          try {
            stylesJson = JSON.stringify(el.styles)
          } catch (error) {
            console.error(`Failed to serialize styles for element ${el.id}:`, error)
            // Continue without styles rather than failing the entire save
            stylesJson = null
          }
        }

        elementInsert.run(
          el.id,
          slide.id,
          el.type,
          el.x,
          el.y,
          el.width,
          el.height,
          el.angle,
          el.fill,
          el.text,
          el.fontSize,
          el.fontFamily,
          stylesJson
        )
      })
    }

    // If any new slides were created, validate and repair slide order to ensure no gaps
    if (hasNewSlides) {
      validateAndRepairSlideOrder(db)
    }
  })

  // Execute the transaction
  transaction(slides)
}
