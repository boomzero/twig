import type { Database } from 'better-sqlite3'
import { v4 as uuid_v4 } from 'uuid'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a single element (shape, text, or image) on a slide.
 * Elements can be rectangles, text objects, or images with various styling properties.
 */
export interface DeckElement {
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
 * Represents a single slide containing multiple elements.
 */
export interface Slide {
  /** Unique identifier for this slide */
  id: string

  /** Array of elements (shapes, text) on this slide */
  elements: DeckElement[]
}

/**
 * Represents an embedded font stored in the database.
 * Fonts are stored as binary data (BLOB) to ensure presentation portability.
 */
export interface FontData {
  /** Unique identifier (hash of fontFamily + variant) */
  id: string

  /** Font family name (e.g., "Arial", "Roboto") */
  fontFamily: string

  /** Binary font file data */
  fontData: Buffer

  /** Font file format (ttf, woff, woff2, otf) */
  format: string

  /** Font variant identifier combining weight and style (e.g., "normal-normal", "bold-italic") */
  variant: string
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
 * - fonts table: Stores embedded font files for presentation portability
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
      src TEXT,
      filename TEXT,
      z_index INTEGER DEFAULT 0,
      FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
    )
  `)

  // Create the fonts table to store embedded font files
  // Fonts are stored as binary data to ensure presentations are portable across systems
  db.exec(`
    CREATE TABLE IF NOT EXISTS fonts (
      id TEXT PRIMARY KEY,
      fontFamily TEXT NOT NULL,
      fontData BLOB NOT NULL,
      format TEXT NOT NULL,
      variant TEXT NOT NULL
    )
  `)

  // Migrations: each column addition has its own try/catch so a failure in one
  // does not prevent the others from running on subsequent launches.
  let columnNames: string[] = []
  try {
    const tableInfo = db.prepare('PRAGMA table_info(elements)').all() as { name: string }[]
    columnNames = tableInfo.map((col) => col.name)
    console.log('Database columns:', columnNames.join(', '))
  } catch (error) {
    console.error('Failed to read database schema for migration:', error)
  }

  if (columnNames.length > 0) {
    if (!columnNames.includes('src')) {
      try {
        console.log('Adding src column to elements table')
        db.exec('ALTER TABLE elements ADD COLUMN src TEXT')
      } catch (error) {
        console.error('Migration failed: src column', error)
      }
    }

    if (!columnNames.includes('filename')) {
      try {
        console.log('Adding filename column to elements table')
        db.exec('ALTER TABLE elements ADD COLUMN filename TEXT')
      } catch (error) {
        console.error('Migration failed: filename column', error)
      }
    }

    if (!columnNames.includes('z_index')) {
      try {
        console.log('Adding z_index column to elements table')
        // Wrap DDL + backfill in a single transaction so that if the UPDATE fails
        // the column is rolled back too and the migration re-runs on next launch.
        // SQLite allows ALTER TABLE inside transactions; better-sqlite3 supports it.
        db.transaction(() => {
          db.exec('ALTER TABLE elements ADD COLUMN z_index INTEGER DEFAULT 0')
          // Backfill: assign sequential per-slide z-indexes ordered by rowid (insertion order)
          db.exec(`
            UPDATE elements SET z_index = (
              SELECT COUNT(*) - 1
              FROM elements e2
              WHERE e2.slide_id = elements.slide_id AND e2.rowid <= elements.rowid
            )
          `)
        })()
      } catch (error) {
        console.error('Migration failed: z_index column', error)
      }
    }
  }
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
  src?: string | null // Image data as base64 data URI
  filename?: string | null // Original image filename
  z_index: number
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

  // Load all elements belonging to this slide, ordered by z_index
  const elementStmt = db.prepare(
    'SELECT id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, styles, src, filename, z_index FROM elements WHERE slide_id = ? ORDER BY z_index ASC'
  )
  const elementRows = elementStmt.all(slideId) as ElementRow[]


  const elements: DeckElement[] = elementRows.map((el) => ({
    type: el.type as 'rect' | 'text' | 'image',
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
      : undefined,
    // Image-specific fields
    src: el.src || undefined,
    filename: el.filename || undefined,
    zIndex: el.z_index ?? 0
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
    // Ensure the slide record exists
    const slideInfo = db.prepare('SELECT slide_order FROM slides WHERE id = ?').get(s.id) as
      | { slide_order: number }
      | undefined

    let isNewSlide = false
    if (!slideInfo) {
      isNewSlide = true
      const maxOrder = db.prepare('SELECT MAX(slide_order) as max FROM slides').get() as {
        max: number | null
      }
      const newOrder = maxOrder.max === null ? 0 : maxOrder.max + 1
      db.prepare('INSERT INTO slides (id, slide_order) VALUES (?, ?)').run(s.id, newOrder)
    }

    // UPSERT each element. On conflict (element already exists), update all mutable
    // fields EXCEPT src. Image src is a base64 data URI (potentially megabytes) that
    // never changes after the image is first imported — skipping it on updates avoids
    // re-writing large blobs on every autosave triggered by position/size/layer changes.
    const elementUpsert = db.prepare(`
      INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, styles, src, filename, z_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slide_id = excluded.slide_id,
        type = excluded.type,
        x = excluded.x,
        y = excluded.y,
        width = excluded.width,
        height = excluded.height,
        angle = excluded.angle,
        fill = excluded.fill,
        text = excluded.text,
        fontSize = excluded.fontSize,
        fontFamily = excluded.fontFamily,
        styles = excluded.styles,
        filename = excluded.filename,
        z_index = excluded.z_index
    `)

    s.elements.forEach((el) => {
      let stylesJson: string | null = null
      if (el.styles) {
        try {
          stylesJson = JSON.stringify(el.styles)
        } catch (error) {
          console.error(`Failed to serialize styles for element ${el.id}:`, error)
          stylesJson = null
        }
      }

      elementUpsert.run(
        el.id,
        s.id,
        el.type,
        el.x,
        el.y,
        el.width,
        el.height,
        el.angle,
        el.fill ?? null,
        el.text ?? null,
        el.fontSize ?? null,
        el.fontFamily ?? null,
        stylesJson,
        el.src ?? null, // Only written on initial INSERT; preserved on UPDATE
        el.filename ?? null,
        el.zIndex ?? 0
      )
    })

    // Remove elements that are no longer on this slide
    if (s.elements.length > 0) {
      const placeholders = s.elements.map(() => '?').join(', ')
      db.prepare(
        `DELETE FROM elements WHERE slide_id = ? AND id NOT IN (${placeholders})`
      ).run(s.id, ...s.elements.map((el) => el.id))
    } else {
      db.prepare('DELETE FROM elements WHERE slide_id = ?').run(s.id)
    }

    if (isNewSlide) {
      validateAndRepairSlideOrder(db)
    }
  })

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

    // Prepared once and reused across all slides — same UPSERT pattern as saveSlide:
    // on conflict update all mutable fields except src, so image blobs are never
    // re-written when only position/size/layer changed.
    const elementUpsert = db.prepare(`
      INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, styles, src, filename, z_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slide_id = excluded.slide_id,
        type = excluded.type,
        x = excluded.x,
        y = excluded.y,
        width = excluded.width,
        height = excluded.height,
        angle = excluded.angle,
        fill = excluded.fill,
        text = excluded.text,
        fontSize = excluded.fontSize,
        fontFamily = excluded.fontFamily,
        styles = excluded.styles,
        filename = excluded.filename,
        z_index = excluded.z_index
    `)

    for (let index = 0; index < slidesToSave.length; index++) {
      const slide = slidesToSave[index]
      const slideInfo = db.prepare('SELECT slide_order FROM slides WHERE id = ?').get(slide.id) as
        | { slide_order: number }
        | undefined

      if (slideInfo) {
        db.prepare('UPDATE slides SET slide_order = ? WHERE id = ?').run(index, slide.id)
      } else {
        hasNewSlides = true
        db.prepare('INSERT INTO slides (id, slide_order) VALUES (?, ?)').run(slide.id, index)
      }

      slide.elements.forEach((el) => {
        let stylesJson: string | null = null
        if (el.styles) {
          try {
            stylesJson = JSON.stringify(el.styles)
          } catch (error) {
            console.error(`Failed to serialize styles for element ${el.id}:`, error)
            stylesJson = null
          }
        }

        elementUpsert.run(
          el.id,
          slide.id,
          el.type,
          el.x,
          el.y,
          el.width,
          el.height,
          el.angle,
          el.fill ?? null,
          el.text ?? null,
          el.fontSize ?? null,
          el.fontFamily ?? null,
          stylesJson,
          el.src ?? null,
          el.filename ?? null,
          el.zIndex ?? 0
        )
      })

      // Remove elements no longer on this slide
      if (slide.elements.length > 0) {
        const placeholders = slide.elements.map(() => '?').join(', ')
        db.prepare(
          `DELETE FROM elements WHERE slide_id = ? AND id NOT IN (${placeholders})`
        ).run(slide.id, ...slide.elements.map((el) => el.id))
      } else {
        db.prepare('DELETE FROM elements WHERE slide_id = ?').run(slide.id)
      }
    }

    if (hasNewSlides) {
      validateAndRepairSlideOrder(db)
    }
  })

  // Execute the transaction
  transaction(slides)
}

// ============================================================================
// Font Management Functions
// ============================================================================

/**
 * Retrieves all embedded fonts from the database.
 *
 * @param db - The SQLite database connection
 * @returns Array of all fonts stored in the database
 */
export function getFonts(db: Database): FontData[] {
  const stmt = db.prepare('SELECT * FROM fonts')
  const rows = stmt.all() as Array<{
    id: string
    fontFamily: string
    fontData: Buffer
    format: string
    variant: string
  }>
  return rows
}

/**
 * Retrieves a specific font by family name and variant.
 *
 * @param db - The SQLite database connection
 * @param fontFamily - The font family name to retrieve
 * @param variant - The font variant (e.g., "normal-normal", "bold-italic")
 * @returns The font data or null if not found
 */
export function getFontData(
  db: Database,
  fontFamily: string,
  variant: string = 'normal-normal'
): FontData | null {
  const stmt = db.prepare('SELECT * FROM fonts WHERE fontFamily = ? AND variant = ?')
  const row = stmt.get(fontFamily, variant) as
    | {
        id: string
        fontFamily: string
        fontData: Buffer
        format: string
        variant: string
      }
    | undefined
  return row || null
}

/**
 * Adds or updates a font in the database.
 * If a font with the same family and variant exists, it will be replaced.
 *
 * @param db - The SQLite database connection
 * @param fontData - The font data to add
 */
export function addFont(db: Database, fontData: FontData): void {
  // Check if font already exists
  const existing = getFontData(db, fontData.fontFamily, fontData.variant)

  if (existing) {
    // Update existing font
    const stmt = db.prepare(
      'UPDATE fonts SET fontData = ?, format = ? WHERE fontFamily = ? AND variant = ?'
    )
    stmt.run(fontData.fontData, fontData.format, fontData.fontFamily, fontData.variant)
  } else {
    // Insert new font
    const stmt = db.prepare(
      'INSERT INTO fonts (id, fontFamily, fontData, format, variant) VALUES (?, ?, ?, ?, ?)'
    )
    stmt.run(fontData.id, fontData.fontFamily, fontData.fontData, fontData.format, fontData.variant)
  }
}
