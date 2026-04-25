import type { Database } from 'better-sqlite3'
import { v4 as uuid_v4 } from 'uuid'
export { resolveCompatNotes } from '../shared/compatNotes'

// ============================================================================
// .tb Format Versioning
// ============================================================================

/**
 * SQLite `application_id` stamped on every twig-written `.tb` file.
 *
 * Value is ASCII "twig" (0x74 0x77 0x69 0x67). Lets any SQLite tool identify
 * a twig presentation without opening it. See TWIG_SPEC.md §11.
 */
export const TWIG_APP_ID = 0x74776967

/**
 * `.tb` format revision this build writes. Bumped on schema-visible changes
 * to how slides/elements/animations/etc. are represented. See TWIG_SPEC.md §12
 * for the changelog.
 */
export const CURRENT_FORMAT_VERSION = 1

/**
 * String written to `settings.compat_notes` on every save. Read verbatim by
 * older twig versions when they encounter a file whose `user_version` exceeds
 * their supported format. v1 is the earliest versioned format, so there is
 * nothing an older version needs to be warned about — the string is empty.
 *
 * Writers may store either:
 *   - a plain string (displayed as-is), or
 *   - a JSON object keyed by BCP-47 locale, e.g.
 *     `{"en": "...", "zh": "...", "_default": "..."}`.
 * Readers use `resolveCompatNotes(raw, locale)` to pick the best match with
 * `_default` -> `en` -> any-key fallback.
 */
export const CURRENT_COMPAT_NOTES = ''

/**
 * Settings keys reserved by the format metadata contract. The renderer cannot
 * write these via `setSetting` — only `stampFileMetadata` touches them.
 * `isBootstrapPresentation` ignores these when detecting untouched temp files.
 */
export const RESERVED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'format_version',
  'compat_notes',
  'created_with_app_version',
  'created_at',
  'last_written_with_app_version'
])

/**
 * Result of probing a `.tb` candidate file for its format identity.
 *
 * `fresh` — empty valid SQLite DB (no tables).
 * `legacy` — pre-versioning twig file (`application_id == 0` but schema looks like twig).
 * `current` — twig file at `CURRENT_FORMAT_VERSION`.
 * `older` — twig file at a version below `CURRENT_FORMAT_VERSION` (migratable).
 * `tooNew` — twig file at a version above `CURRENT_FORMAT_VERSION`. Open read-only with warning.
 * `notTwig` — valid SQLite but not a twig file.
 */
export type FormatProbeStatus = 'fresh' | 'legacy' | 'current' | 'older' | 'tooNew' | 'notTwig'

export interface FormatProbeResult {
  status: FormatProbeStatus
  /** Populated for `current`, `older`, `tooNew`, `legacy` (legacy reports 0). */
  fileVersion?: number
  /** Populated for `tooNew`. Empty string is valid. */
  compatNotes?: string
}

function setNumericPragmaIfChanged(
  db: Database,
  key: 'application_id' | 'user_version',
  value: number
): void {
  const current = (db.pragma(key, { simple: true }) as number) ?? 0
  if (current !== value) {
    db.pragma(`${key} = ${value}`)
  }
}

/**
 * Detects the format identity of a SQLite database on an already-open
 * connection. Read-only — never mutates. Used by `probeDatabaseFormat` on a
 * short-lived RO connection, and by `initializeDatabase` to dispatch on open.
 */
export function detectFormat(db: Database): FormatProbeResult {
  const appId = (db.pragma('application_id', { simple: true }) as number) ?? 0

  if (appId === TWIG_APP_ID) {
    const fileVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0
    if (fileVersion > CURRENT_FORMAT_VERSION) {
      let compatNotes = ''
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'compat_notes'").get() as
          | { value: string }
          | undefined
        compatNotes = row?.value ?? ''
      } catch {
        // settings table missing from a too-new file: degrade to empty notes.
      }
      return { status: 'tooNew', fileVersion, compatNotes }
    }
    if (fileVersion === CURRENT_FORMAT_VERSION) {
      return { status: 'current', fileVersion }
    }
    return { status: 'older', fileVersion }
  }

  if (appId !== 0) {
    return { status: 'notTwig' }
  }

  // appId === 0: either a brand-new/empty SQLite file or a legacy twig file
  // (pre-versioning) or some unrelated SQLite file.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string
  }[]
  const tableNames = new Set(tables.map((t) => t.name))

  if (tableNames.size === 0) {
    return { status: 'fresh' }
  }

  const REQUIRED_LEGACY_TABLES = ['slides', 'elements', 'fonts', 'settings']
  if (REQUIRED_LEGACY_TABLES.every((t) => tableNames.has(t))) {
    return { status: 'legacy', fileVersion: 0 }
  }

  return { status: 'notTwig' }
}

/**
 * Writes format-identity pragmas and metadata settings rows to an already-open
 * read-write connection. Idempotent: same-value stamps are skipped where
 * possible so frequent saves do not churn header pages or reserved settings
 * rows unnecessarily. Runs in a single transaction so pragmas and settings
 * cannot get partially updated if the surrounding write path fails.
 *
 * MUST be called AFTER `runMigrations`/table creation — relies on the
 * `settings` table existing.
 *
 * `created_with_app_version` and `created_at` are written only on first stamp
 * (via INSERT OR IGNORE). `last_written_with_app_version`, `format_version`,
 * and `compat_notes` are refreshed on every call.
 */
export function stampFileMetadata(db: Database, appVersion: string): void {
  const nowIso = new Date().toISOString()

  const tx = db.transaction(() => {
    setNumericPragmaIfChanged(db, 'application_id', TWIG_APP_ID)
    setNumericPragmaIfChanged(db, 'user_version', CURRENT_FORMAT_VERSION)

    const upsert = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE settings.value IS NOT excluded.value
    `)
    upsert.run('format_version', String(CURRENT_FORMAT_VERSION))
    upsert.run('compat_notes', CURRENT_COMPAT_NOTES)
    upsert.run('last_written_with_app_version', appVersion)

    const firstWriteOnly = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    firstWriteOnly.run('created_with_app_version', appVersion)
    firstWriteOnly.run('created_at', nowIso)
  })

  tx()
}

/**
 * Applies schema drift-fixes and per-version migrations. Currently handles the
 * legacy→v1 drift (columns added post-launch). Called by `initializeDatabase`
 * after tables are created.
 *
 * `fromVersion == 0` covers both legacy files (pre-versioning) and brand-new
 * files (no tables existed before initializeDatabase created them). Both paths
 * benefit from the idempotent `ALTER TABLE` guards.
 */
export function runMigrations(db: Database, fromVersion: number, toVersion: number): void {
  if (fromVersion >= toVersion) {
    return
  }

  // legacy/fresh → v1: ensure all columns present on `elements`.
  // SQLite lacks `ADD COLUMN IF NOT EXISTS`, so gate each ALTER on
  // PRAGMA table_info. Safe to run on fresh DBs (CREATE TABLE already has
  // the columns) and on legacy DBs missing any subset of them.
  const elementCols = db.prepare('PRAGMA table_info(elements)').all() as Array<{
    name: string
  }>
  const existing = new Set(elementCols.map((c) => c.name))
  if (!existing.has('shape_params')) {
    db.exec('ALTER TABLE elements ADD COLUMN shape_params TEXT')
  }
  if (!existing.has('fontWeight')) {
    db.exec('ALTER TABLE elements ADD COLUMN fontWeight TEXT')
  }
  if (!existing.has('fontStyle')) {
    db.exec('ALTER TABLE elements ADD COLUMN fontStyle TEXT')
  }
  if (!existing.has('underline')) {
    db.exec('ALTER TABLE elements ADD COLUMN underline INTEGER')
  }
}

import type {
  SlideBackground,
  AnimationStep,
  ElementAnimations,
  SlideTransition,
  ArrowShape
} from '../renderer/src/lib/types'
import { DEFAULT_ARROW_SHAPE } from '../renderer/src/lib/types'

export type { SlideBackground }

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a single element (shape, text, or image) on a slide.
 * Elements can be rectangles, text objects, or images with various styling properties.
 */
export interface TwigElement {
  /** Type of element - rectangle shape, text, or image */
  type: 'rect' | 'ellipse' | 'triangle' | 'star' | 'arrow' | 'text' | 'image'

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

  /** Base font weight (only for text elements) */
  fontWeight?: string | number

  /** Base font style (only for text elements) */
  fontStyle?: string

  /** Base underline flag (only for text elements) */
  underline?: boolean

  /** Rich text styles object from fabric.js (only for text elements) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  styles?: Record<string, any>

  /** Image data as base64 data URI (only for image elements) */
  src?: string

  /** Original image filename (only for image elements) */
  filename?: string

  /** Z-index for layer ordering (higher = in front) */
  zIndex: number

  /** Per-element animation configuration */
  animations?: ElementAnimations

  /** Arrow-specific geometry ratios in [0, 1]. Ignored when type !== 'arrow'. */
  arrowShape?: ArrowShape
}

/**
 * Represents a single slide containing multiple elements.
 */
export interface Slide {
  /** Unique identifier for this slide */
  id: string

  /** Array of elements (shapes, text) on this slide */
  elements: TwigElement[]

  /** Optional background — null/undefined means white */
  background?: SlideBackground

  /** Ordered animation steps for this slide */
  animationOrder: AnimationStep[]

  /** Optional slide transition configuration */
  transition?: SlideTransition
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
// Helpers
// ============================================================================

/** Serialize an optional value to a JSON string, or null if undefined. */
function serializeJson<T>(value: T | undefined): string | null {
  return value !== undefined ? JSON.stringify(value) : null
}

/**
 * Applies per-connection SQLite hardening before any application queries run.
 *
 * better-sqlite3 already enables SQLITE_DBCONFIG_DEFENSIVE internally, so this
 * layers on the remaining protections that are relevant when `.tb` files may
 * come from untrusted sources.
 */
export function configureDatabaseConnection(db: Database): void {
  db.pragma('foreign_keys = ON')
  db.pragma('trusted_schema = OFF')
  db.pragma('cell_size_check = ON')
  db.pragma('mmap_size = 0')

  if (!db.readonly) {
    db.pragma('secure_delete = ON')
  }
}

// ============================================================================
// Database Schema Management
// ============================================================================

/**
 * Thrown when `initializeDatabase` is asked to open a `.tb` whose format
 * version exceeds `CURRENT_FORMAT_VERSION`. Callers should have probed with
 * `probeDatabaseFormat` first and gone down the read-only-with-warning path.
 */
export class FileTooNewError extends Error {
  constructor(
    public readonly fileVersion: number,
    public readonly compatNotes: string
  ) {
    super(
      `.tb file format version ${fileVersion} is newer than supported (${CURRENT_FORMAT_VERSION})`
    )
    this.name = 'FileTooNewError'
  }
}

/**
 * Thrown when `initializeDatabase` sees a SQLite file that isn't a twig
 * presentation (non-twig `application_id`, or unknown schema with default
 * `application_id`).
 */
export class NotATwigFileError extends Error {
  constructor() {
    super('file is a valid SQLite database but is not a twig presentation')
    this.name = 'NotATwigFileError'
  }
}

/**
 * Initializes a read-write database connection for twig.
 *
 * Creates required tables if they don't exist, applies migrations to upgrade
 * legacy files in place, and stamps format-identity metadata (pragmas +
 * settings rows). Stamping happens AFTER schema creation so the `settings`
 * table is guaranteed to exist when we insert metadata rows.
 *
 * Refuses to open files that are newer than this build understands (throws
 * `FileTooNewError`) or that aren't twig files (throws `NotATwigFileError`).
 *
 * @param db - The SQLite database connection to initialize
 * @param appVersion - The twig app version, used for provenance metadata
 */
export function initializeDatabase(db: Database, appVersion: string): void {
  // Use WAL journal mode for normal runtime operation.
  db.pragma('journal_mode = WAL')
  // NORMAL is the recommended synchronous setting for WAL mode.
  db.pragma('synchronous = NORMAL')

  // Detect format identity BEFORE creating tables so `fresh` (empty DB) can be
  // distinguished from `legacy` (existing twig tables without stamps).
  const initial = detectFormat(db)

  if (initial.status === 'notTwig') {
    throw new NotATwigFileError()
  }
  if (initial.status === 'tooNew') {
    throw new FileTooNewError(initial.fileVersion ?? 0, initial.compatNotes ?? '')
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS slides (
      id TEXT PRIMARY KEY,
      slide_order INTEGER,
      thumbnail TEXT,
      background TEXT,
      animation_order TEXT,
      transition TEXT
    )
  `)

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
      fontWeight TEXT,
      fontStyle TEXT,
      underline INTEGER,
      styles TEXT,
      src TEXT,
      filename TEXT,
      z_index INTEGER DEFAULT 0,
      animations TEXT,
      shape_params TEXT,
      FOREIGN KEY (slide_id) REFERENCES slides(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS fonts (
      id TEXT PRIMARY KEY,
      fontFamily TEXT NOT NULL,
      fontData BLOB NOT NULL,
      format TEXT NOT NULL,
      variant TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `)

  // Legacy twig files (pre-versioning) report fileVersion 0; treat identically
  // to fresh for migration purposes.
  const fromVersion =
    initial.status === 'current' || initial.status === 'older' ? (initial.fileVersion ?? 0) : 0
  runMigrations(db, fromVersion, CURRENT_FORMAT_VERSION)

  // Stamp AFTER tables exist and migrations are complete. Transactional, so
  // pragma and settings rows are all-or-nothing.
  stampFileMetadata(db, appVersion)
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
  fontWeight?: string | number
  fontStyle?: string
  underline?: number | null
  styles?: string | null // Stored as JSON string in database
  src?: string | null // Image data as base64 data URI
  filename?: string | null // Original image filename
  z_index: number
  animations?: string | null // Stored as JSON string in database
  shape_params?: string | null // Shape-specific geometry ratios (JSON); currently only used by 'arrow'
}

/**
 * Retrieves a complete slide with all its elements.
 *
 * @param db - The SQLite database connection
 * @param slideId - The unique identifier of the slide to retrieve
 * @returns The slide object with all its elements, or null if not found
 */
export function getSlide(db: Database, slideId: string): Slide | null {
  const slideRow = db
    .prepare('SELECT id, background, animation_order, transition FROM slides WHERE id = ?')
    .get(slideId) as
    | {
        id: string
        background: string | null
        animation_order: string | null
        transition: string | null
      }
    | undefined
  if (!slideRow) return null

  const elementRows = db
    .prepare(
      'SELECT id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, fontWeight, fontStyle, underline, styles, src, filename, z_index, animations, shape_params FROM elements WHERE slide_id = ? ORDER BY z_index ASC'
    )
    .all(slideId) as ElementRow[]

  const elements: TwigElement[] = elementRows.map((el) => {
    let parsedAnimations: ElementAnimations | undefined
    try {
      parsedAnimations = el.animations ? JSON.parse(el.animations) : undefined
    } catch {
      parsedAnimations = undefined
    }

    // Parse shape_params and seed defaults for arrows so the renderer and
    // properties panel never see `undefined` on legacy rows.
    let arrowShape: ArrowShape | undefined
    if (el.type === 'arrow') {
      if (el.shape_params) {
        try {
          const parsed = JSON.parse(el.shape_params) as Partial<ArrowShape>
          arrowShape = {
            headWidthRatio: parsed.headWidthRatio ?? DEFAULT_ARROW_SHAPE.headWidthRatio,
            headLengthRatio: parsed.headLengthRatio ?? DEFAULT_ARROW_SHAPE.headLengthRatio,
            shaftThicknessRatio:
              parsed.shaftThicknessRatio ?? DEFAULT_ARROW_SHAPE.shaftThicknessRatio
          }
        } catch {
          arrowShape = { ...DEFAULT_ARROW_SHAPE }
        }
      } else {
        arrowShape = { ...DEFAULT_ARROW_SHAPE }
      }
    }

    // Pre-fix saves may have persisted negative width/height for arrows after
    // a mirrored drag. Fabric's polygon geometry assumes non-negative intrinsic
    // dimensions, so sanitize on read for arrows.
    const normalizedWidth = el.type === 'arrow' ? Math.abs(el.width) : el.width
    const normalizedHeight = el.type === 'arrow' ? Math.abs(el.height) : el.height

    // Text rows saved before these columns existed have NULL here; Fabric's
    // Textbox will call .toLowerCase() on fontWeight/fontStyle and throw if
    // the value is undefined/null, so seed the standard defaults for text.
    const isText = el.type === 'text'
    const textFontWeight = isText ? (el.fontWeight ?? 'normal') : undefined
    const textFontStyle = isText ? (el.fontStyle ?? 'normal') : undefined
    const textUnderline = isText
      ? el.underline === null || el.underline === undefined
        ? false
        : Boolean(el.underline)
      : undefined

    return {
      type: el.type as 'rect' | 'text' | 'image',
      id: el.id,
      x: el.x,
      y: el.y,
      width: normalizedWidth,
      height: normalizedHeight,
      angle: el.angle,
      fill: el.fill,
      text: el.text,
      fontSize: el.fontSize,
      fontFamily: el.fontFamily,
      fontWeight: textFontWeight,
      fontStyle: textFontStyle,
      underline: textUnderline,
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
      zIndex: el.z_index ?? 0,
      animations: parsedAnimations,
      arrowShape
    }
  })

  let background: SlideBackground | undefined
  if (slideRow.background) {
    try {
      background = JSON.parse(slideRow.background)
    } catch {
      /* ignore malformed JSON */
    }
  }

  let animationOrder: AnimationStep[]
  try {
    animationOrder = slideRow.animation_order ? JSON.parse(slideRow.animation_order) : []
  } catch {
    animationOrder = []
  }

  let transition: SlideTransition | undefined
  try {
    transition = slideRow.transition ? JSON.parse(slideRow.transition) : undefined
  } catch {
    transition = undefined
  }

  return { id: slideRow.id, elements, background, animationOrder, transition }
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
  const slides = db.prepare('SELECT id, slide_order FROM slides ORDER BY slide_order').all() as {
    id: string
    slide_order: number
  }[]

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
 * Deletes elements for a slide that are no longer in the provided keepIds set.
 *
 * Uses SELECT + JS filter + chunked DELETE BY id rather than
 * `DELETE ... NOT IN (?, ?, ...)` to avoid hitting SQLite's
 * SQLITE_LIMIT_VARIABLE_NUMBER (default 999).
 */
function deleteOrphanElements(db: Database, slideId: string, keepIds: Set<string>): void {
  const existing = db.prepare('SELECT id FROM elements WHERE slide_id = ?').all(slideId) as {
    id: string
  }[]
  const stale = existing.filter((r) => !keepIds.has(r.id)).map((r) => r.id)
  if (stale.length === 0) return
  // Delete in chunks of 500 to stay within SQLITE_LIMIT_VARIABLE_NUMBER
  const CHUNK = 500
  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    db.prepare(`DELETE FROM elements WHERE id IN (${placeholders})`).run(...chunk)
  }
}

/**
 * Prepares the element UPSERT statement shared by saveSlide and saveAllSlides.
 *
 * On conflict all mutable fields are updated EXCEPT src. Image src is a base64
 * data URI (potentially megabytes) that never changes after first import —
 * skipping it on updates avoids re-writing large blobs on every autosave.
 */
function prepareElementUpsert(db: Database): (...args: unknown[]) => void {
  const stmt = db.prepare(`
    INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, fontWeight, fontStyle, underline, styles, src, filename, z_index, animations, shape_params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      fontWeight = excluded.fontWeight,
      fontStyle = excluded.fontStyle,
      underline = excluded.underline,
      styles = excluded.styles,
      filename = excluded.filename,
      z_index = excluded.z_index,
      animations = excluded.animations,
      shape_params = excluded.shape_params
  `)
  return (...args) => stmt.run(...args)
}

/** Serialize an element's shape-specific params to a JSON string, or null. */
function serializeShapeParams(el: TwigElement): string | null {
  if (el.type === 'arrow' && el.arrowShape) {
    try {
      return JSON.stringify(el.arrowShape)
    } catch {
      return null
    }
  }
  return null
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
function prepareSlideOps(db: Database): {
  insertSlide: (
    id: string,
    order: number,
    background: string | null,
    animationOrder: string,
    transition: string | null
  ) => void
  updateSlide: (
    background: string | null,
    animationOrder: string,
    transition: string | null,
    id: string
  ) => void
  updateSlideWithOrder: (
    order: number,
    background: string | null,
    animationOrder: string,
    transition: string | null,
    id: string
  ) => void
} {
  const ins = db.prepare(
    'INSERT INTO slides (id, slide_order, background, animation_order, transition) VALUES (?, ?, ?, ?, ?)'
  )
  const upd = db.prepare(
    'UPDATE slides SET background = ?, animation_order = ?, transition = ? WHERE id = ?'
  )
  const updOrd = db.prepare(
    'UPDATE slides SET slide_order = ?, background = ?, animation_order = ?, transition = ? WHERE id = ?'
  )
  return {
    insertSlide: (id, order, background, animationOrder, transition) =>
      ins.run(id, order, background, animationOrder, transition),
    updateSlide: (background, animationOrder, transition, id) =>
      upd.run(background, animationOrder, transition, id),
    updateSlideWithOrder: (order, background, animationOrder, transition, id) =>
      updOrd.run(order, background, animationOrder, transition, id)
  }
}

export function saveSlide(db: Database, slide: Slide): void {
  // Prepare outside the transaction so better-sqlite3 doesn't re-parse the SQL
  // on every autosave invocation (saveAllSlides already does this correctly).
  const elementUpsert = prepareElementUpsert(db)
  const slideOps = prepareSlideOps(db)

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
      slideOps.insertSlide(
        s.id,
        newOrder,
        serializeJson(s.background),
        JSON.stringify(s.animationOrder ?? []),
        serializeJson(s.transition)
      )
    }

    // Always sync background, animation_order, and transition (handles both new and existing slides)
    if (slideInfo) {
      slideOps.updateSlide(
        serializeJson(s.background),
        JSON.stringify(s.animationOrder ?? []),
        serializeJson(s.transition),
        s.id
      )
    }

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

      let animationsJson: string | null = null
      if (el.animations) {
        try {
          animationsJson = JSON.stringify(el.animations)
        } catch {
          animationsJson = null
        }
      }

      elementUpsert(
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
        el.fontWeight ?? null,
        el.fontStyle ?? null,
        el.underline === undefined ? null : Number(el.underline),
        stylesJson,
        el.src ?? null, // Only written on initial INSERT; preserved on UPDATE
        el.filename ?? null,
        el.zIndex,
        animationsJson,
        serializeShapeParams(el)
      )
    })

    // Remove elements that are no longer on this slide
    deleteOrphanElements(db, s.id, new Set(s.elements.map((el) => el.id)))

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
    elements: [],
    animationOrder: []
  }

  saveSlide(db, newSlide)
  return newSlide
}

/**
 * Duplicates a slide, inserting the copy immediately after the source slide.
 * The duplicate receives a new slide ID and fresh element IDs.
 *
 * @param db - The SQLite database connection
 * @param sourceSlideId - The ID of the slide to duplicate
 * @returns The duplicated slide with remapped IDs
 * @throws Error if the source slide does not exist
 */
export function duplicateSlide(db: Database, sourceSlideId: string): Slide {
  const sourceMetaStmt = db.prepare('SELECT slide_order, thumbnail FROM slides WHERE id = ?')
  const shiftSlidesStmt = db.prepare(
    'UPDATE slides SET slide_order = slide_order + 1 WHERE slide_order > ?'
  )
  const insertSlideStmt = db.prepare(
    'INSERT INTO slides (id, slide_order, thumbnail, background, animation_order, transition) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const elementUpsert = prepareElementUpsert(db)

  const transaction = db.transaction((slideId: string): Slide => {
    const sourceMeta = sourceMetaStmt.get(slideId) as
      | { slide_order: number; thumbnail: string | null }
      | undefined
    if (!sourceMeta) {
      throw new Error(`Slide not found: ${slideId}`)
    }

    const sourceSlide = getSlide(db, slideId)!

    const duplicatedSlideId = uuid_v4()
    const elementIdMap = new Map<string, string>()
    const duplicatedElements = sourceSlide.elements.map((element) => {
      const duplicatedElement = JSON.parse(JSON.stringify(element)) as TwigElement
      const prefix = element.id.split('_')[0] || element.type
      const duplicatedElementId = `${prefix}_${uuid_v4()}`
      duplicatedElement.id = duplicatedElementId
      elementIdMap.set(element.id, duplicatedElementId)
      return duplicatedElement
    })

    const duplicatedSlide: Slide = {
      id: duplicatedSlideId,
      elements: duplicatedElements,
      background: sourceSlide.background
        ? (JSON.parse(JSON.stringify(sourceSlide.background)) as SlideBackground)
        : undefined,
      animationOrder: sourceSlide.animationOrder.map((step) => ({
        ...step,
        elementId: elementIdMap.get(step.elementId) ?? step.elementId
      })),
      transition: sourceSlide.transition
        ? (JSON.parse(JSON.stringify(sourceSlide.transition)) as SlideTransition)
        : undefined
    }

    shiftSlidesStmt.run(sourceMeta.slide_order)
    insertSlideStmt.run(
      duplicatedSlide.id,
      sourceMeta.slide_order + 1,
      sourceMeta.thumbnail,
      serializeJson(duplicatedSlide.background),
      JSON.stringify(duplicatedSlide.animationOrder ?? []),
      serializeJson(duplicatedSlide.transition)
    )

    duplicatedSlide.elements.forEach((el) => {
      let stylesJson: string | null = null
      if (el.styles) {
        try {
          stylesJson = JSON.stringify(el.styles)
        } catch (error) {
          console.error(`Failed to serialize styles for element ${el.id}:`, error)
          stylesJson = null
        }
      }

      let animationsJson: string | null = null
      if (el.animations) {
        try {
          animationsJson = JSON.stringify(el.animations)
        } catch {
          animationsJson = null
        }
      }

      elementUpsert(
        el.id,
        duplicatedSlide.id,
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
        el.fontWeight ?? null,
        el.fontStyle ?? null,
        el.underline === undefined ? null : Number(el.underline),
        stylesJson,
        el.src ?? null,
        el.filename ?? null,
        el.zIndex,
        animationsJson,
        serializeShapeParams(el)
      )
    })

    validateAndRepairSlideOrder(db)
    return duplicatedSlide
  })

  return transaction(sourceSlideId)
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

  const elementUpsert = prepareElementUpsert(db)
  const slideOps = prepareSlideOps(db)

  const transaction = db.transaction((slidesToSave: Slide[]) => {
    let hasNewSlides = false

    for (let index = 0; index < slidesToSave.length; index++) {
      const slide = slidesToSave[index]
      const slideInfo = db.prepare('SELECT slide_order FROM slides WHERE id = ?').get(slide.id) as
        | { slide_order: number }
        | undefined

      if (slideInfo) {
        slideOps.updateSlideWithOrder(
          index,
          serializeJson(slide.background),
          JSON.stringify(slide.animationOrder ?? []),
          serializeJson(slide.transition),
          slide.id
        )
      } else {
        hasNewSlides = true
        slideOps.insertSlide(
          slide.id,
          index,
          serializeJson(slide.background),
          JSON.stringify(slide.animationOrder ?? []),
          serializeJson(slide.transition)
        )
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

        let animationsJson: string | null = null
        if (el.animations) {
          try {
            animationsJson = JSON.stringify(el.animations)
          } catch {
            animationsJson = null
          }
        }

        elementUpsert(
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
          el.fontWeight ?? null,
          el.fontStyle ?? null,
          el.underline === undefined ? null : Number(el.underline),
          stylesJson,
          el.src ?? null,
          el.filename ?? null,
          el.zIndex,
          animationsJson,
          serializeShapeParams(el)
        )
      })

      // Remove elements no longer on this slide
      deleteOrphanElements(db, slide.id, new Set(slide.elements.map((el) => el.id)))
    }

    if (hasNewSlides) {
      validateAndRepairSlideOrder(db)
    }
  })

  // Execute the transaction
  transaction(slides)
}

/**
 * Deletes a slide and all its elements from the database.
 * Elements are removed via ON DELETE CASCADE on the foreign key.
 * Slide order is compacted after deletion.
 *
 * @param db - The SQLite database connection
 * @param slideId - The ID of the slide to delete
 */
export function deleteSlide(db: Database, slideId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM slides WHERE id = ?').run(slideId)
    validateAndRepairSlideOrder(db)
  })()
}

/**
 * Updates slide ordering to match the provided ID sequence.
 *
 * @param db - The SQLite database connection
 * @param orderedIds - Slide IDs in the desired display order
 */
export function reorderSlides(db: Database, orderedIds: string[]): void {
  const stmt = db.prepare('UPDATE slides SET slide_order = ? WHERE id = ?')
  db.transaction(() => {
    orderedIds.forEach((id, index) => stmt.run(index, id))
    validateAndRepairSlideOrder(db)
  })()
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

// ============================================================================
// Thumbnail Functions
// ============================================================================

/**
 * Saves a thumbnail for a slide.
 *
 * @param db - The SQLite database connection
 * @param slideId - The slide ID to update
 * @param thumbnail - The thumbnail as a JPEG data URI
 */
export function saveThumbnail(db: Database, slideId: string, thumbnail: string): void {
  db.prepare('UPDATE slides SET thumbnail = ? WHERE id = ?').run(thumbnail, slideId)
}

/**
 * Retrieves all stored thumbnails for a presentation.
 *
 * @param db - The SQLite database connection
 * @returns Map of slideId → thumbnail data URI
 */
export function getThumbnails(db: Database): Record<string, string> {
  const rows = db.prepare('SELECT id, thumbnail FROM slides').all() as {
    id: string
    thumbnail: string | null
  }[]
  const result: Record<string, string> = {}
  for (const row of rows) {
    if (row.thumbnail) result[row.id] = row.thumbnail
  }
  return result
}

/**
 * Returns whether the database is still the untouched bootstrap presentation:
 * exactly one blank slide, no extra assets/settings, and no user-authored metadata.
 *
 * Thumbnails are intentionally ignored because they are generated automatically.
 */
export function isBootstrapPresentation(db: Database): boolean {
  const slideCount = (db.prepare('SELECT COUNT(*) AS total FROM slides').get() as { total: number })
    .total
  if (slideCount !== 1) {
    return false
  }

  const slideRow = db
    .prepare('SELECT id, background, animation_order, transition FROM slides LIMIT 1')
    .get() as
    | {
        id: string
        background: string | null
        animation_order: string | null
        transition: string | null
      }
    | undefined
  if (!slideRow) {
    return false
  }

  if (slideRow.background !== null || slideRow.transition !== null) {
    return false
  }

  if (slideRow.animation_order !== null) {
    try {
      const animationOrder = JSON.parse(slideRow.animation_order)
      if (!Array.isArray(animationOrder) || animationOrder.length > 0) {
        return false
      }
    } catch {
      return false
    }
  }

  const elementCount = (
    db.prepare('SELECT COUNT(*) AS total FROM elements WHERE slide_id = ?').get(slideRow.id) as {
      total: number
    }
  ).total
  if (elementCount !== 0) {
    return false
  }

  const fontCount = (db.prepare('SELECT COUNT(*) AS total FROM fonts').get() as { total: number })
    .total
  if (fontCount !== 0) {
    return false
  }

  // Ignore reserved format-metadata keys — they are stamped by
  // `stampFileMetadata` on every fresh DB, so an untouched temp file always
  // has those rows. Only non-reserved settings count as user-authored state.
  const reservedKeys = Array.from(RESERVED_SETTINGS_KEYS)
  const placeholders = reservedKeys.map(() => '?').join(',')
  const userSettingsCount = (
    db
      .prepare(`SELECT COUNT(*) AS total FROM settings WHERE key NOT IN (${placeholders})`)
      .get(...reservedKeys) as { total: number }
  ).total
  return userSettingsCount === 0
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

// ============================================================================
// Settings Functions
// ============================================================================

/**
 * Retrieves a setting value by key.
 */
export function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/**
 * Saves a setting value. Passing null removes the key.
 *
 * Refuses reserved format-metadata keys (see `RESERVED_SETTINGS_KEYS`). Those
 * are owned by `stampFileMetadata` and must not be writable from the
 * renderer.
 */
export function setSetting(db: Database, key: string, value: string | null): void {
  if (RESERVED_SETTINGS_KEYS.has(key)) {
    throw new Error(`"${key}" is a reserved format-metadata key and cannot be set by the renderer`)
  }
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
  }
}

/**
 * Sets the same background on every slide in the presentation.
 */
export function applyBackgroundToAllSlides(db: Database, background: SlideBackground | null): void {
  const value = background ? JSON.stringify(background) : null
  db.prepare('UPDATE slides SET background = ?').run(value)
}
