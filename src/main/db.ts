import Database from 'better-sqlite3'
import type { Presentation, Slide, DeckElement } from '../types'

// Opens a database connection and sets up PRAGMAs for security and performance
export function openDb(filePath: string): Database.Database {
  const db = new Database(filePath)

  // Performance and concurrency
  db.pragma('journal_mode = WAL')

  // Security settings
  db.pragma('secure_delete = ON')
  db.pragma('foreign_keys = ON')
  db.pragma('cell_size_check = ON')
  db.pragma('trusted_schema = OFF')

  return db
}

// Initializes the database with the required schema
export function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS slides (
      id TEXT PRIMARY KEY,
      slide_number INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      slide_id TEXT NOT NULL,
      type TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      angle REAL NOT NULL,
      fill TEXT NOT NULL,
      text TEXT,
      font_size REAL,
      font_family TEXT,
      styles TEXT,
      FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
    );
  `)
}

// The new set of granular DB functions

export function getSlides(db: Database.Database): Pick<Slide, 'id' | 'slideNumber'>[] {
  return db.prepare('SELECT id, slide_number FROM slides ORDER BY slide_number ASC').all() as Pick<
    Slide,
    'id' | 'slideNumber'
  >[]
}

export function getElementsForSlide(db: Database.Database, slideId: string): DeckElement[] {
  const rows = db.prepare('SELECT * FROM elements WHERE slide_id = ?').all(slideId) as any[]
  return rows.map((row) => ({
    ...row,
    fontSize: row.font_size,
    fontFamily: row.font_family,
    styles: row.styles ? JSON.parse(row.styles) : undefined
  }))
}

export function createSlide(db: Database.Database, id: string, slideNumber: number): void {
  db.prepare('INSERT INTO slides (id, slide_number) VALUES (?, ?)').run(id, slideNumber)
}

export function createElement(db: Database.Database, slideId: string, element: DeckElement): void {
  db.prepare(
    `
    INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, font_size, font_family, styles)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    element.id,
    slideId,
    element.type,
    element.x,
    element.y,
    element.width,
    element.height,
    element.angle,
    element.fill,
    element.text || null,
    element.fontSize || null,
    element.fontFamily || null,
    element.styles ? JSON.stringify(element.styles) : null
  )
}

export function updateElement(
  db: Database.Database,
  elementId: string,
  updates: Partial<DeckElement>
): void {
  const setClauses: string[] = []
  const params: (string | number | null)[] = []

  // Map from JS property names to DB column names
  const columnMap = {
    fontSize: 'font_size',
    fontFamily: 'font_family'
    // Add other mappings here if they differ
  }

  for (const key in updates) {
    if (Object.prototype.hasOwnProperty.call(updates, key) && key !== 'id') {
      const dbKey = columnMap[key] || key
      setClauses.push(`${dbKey} = ?`)
      let value = updates[key]
      // Stringify JSON fields
      if (key === 'styles') {
        value = JSON.stringify(value)
      }
      params.push(value as string | number)
    }
  }

  if (setClauses.length === 0) {
    return // No updates to perform
  }

  params.push(elementId)
  const sql = `UPDATE elements SET ${setClauses.join(', ')} WHERE id = ?`
  db.prepare(sql).run(...params)
}

export function deleteElements(db: Database.Database, elementIds: string[]): void {
  if (elementIds.length === 0) return
  const placeholders = elementIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM elements WHERE id IN (${placeholders})`).run(...elementIds)
}

export function deleteSlide(db: Database.Database, slideId: string): void {
  db.prepare('DELETE FROM slides WHERE id = ?').run(slideId)
}

// Saves a new presentation to a fresh database file.
export function saveNewPresentation(
  db: Database.Database,
  presentation: Presentation
): void {
  const transaction = db.transaction(() => {
    db.exec('DELETE FROM elements;')
    db.exec('DELETE FROM slides;')

    const insertSlide = db.prepare('INSERT INTO slides (id, slide_number) VALUES (?, ?)')
    const insertElement = db.prepare(`
      INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, font_size, font_family, styles)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    presentation.slides.forEach((slide) => {
      insertSlide.run(slide.id, slide.slideNumber)
      slide.elements.forEach((element) => {
        insertElement.run(
          element.id,
          slide.id,
          element.type,
          element.x,
          element.y,
          element.width,
          element.height,
          element.angle,
          element.fill,
          element.text || null,
          element.fontSize || null,
          element.fontFamily || null,
          element.styles ? JSON.stringify(element.styles) : null
        )
      })
    })
  })

  transaction()
}
