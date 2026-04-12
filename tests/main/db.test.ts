import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addFont,
  applyBackgroundToAllSlides,
  configureDatabaseConnection,
  createSlide,
  deleteSlide,
  getFontData,
  getFonts,
  getSetting,
  getSlide,
  getSlideIds,
  getThumbnails,
  initializeDatabase,
  reorderSlides,
  saveAllSlides,
  saveSlide,
  saveThumbnail,
  setSetting,
  type FontData,
  type Slide
} from '../../src/main/db'

let db: Database.Database

function createDb(): Database.Database {
  const instance = new Database(':memory:')
  configureDatabaseConnection(instance)
  initializeDatabase(instance)
  return instance
}

function makeSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: 'slide-1',
    elements: [
      {
        id: 'el-text',
        type: 'text',
        x: 120,
        y: 80,
        width: 300,
        height: 120,
        angle: 15,
        fill: '#112233',
        text: 'Hello, twig',
        fontSize: 28,
        fontFamily: 'Inter',
        styles: {
          0: {
            0: {
              fill: '#abcdef',
              fontSize: 30
            }
          }
        },
        zIndex: 0,
        animations: {
          buildIn: { type: 'fade-in', duration: 0.6 },
          actions: [{ id: 'action-1', type: 'move', toX: 240, toY: 160, duration: 1.1 }],
          buildOut: { type: 'fade-out', duration: 0.5 }
        }
      },
      {
        id: 'el-image',
        type: 'image',
        x: 400,
        y: 220,
        width: 160,
        height: 90,
        angle: 0,
        src: 'data:image/png;base64,ZmFrZQ==',
        filename: 'demo.png',
        zIndex: 1
      }
    ],
    background: {
      type: 'gradient',
      angle: 45,
      stops: [
        { offset: 0, color: '#000000' },
        { offset: 1, color: '#ffffff' }
      ]
    },
    animationOrder: [
      { elementId: 'el-text', category: 'buildIn' },
      { elementId: 'el-text', category: 'action', actionId: 'action-1' },
      { elementId: 'el-text', category: 'buildOut' }
    ],
    transition: { type: 'dissolve', duration: 0.4 },
    ...overrides
  }
}

function expectStoredSlide(actual: Slide | null, expected: Slide): void {
  expect(actual).not.toBeNull()
  expect(actual).toMatchObject(expected)
  expect(actual?.elements).toHaveLength(expected.elements.length)
}

describe('src/main/db.ts', () => {
  beforeEach(() => {
    db = createDb()
  })

  afterEach(() => {
    db?.close()
  })

  it('allows configureDatabaseConnection to run more than once', () => {
    expect(() => configureDatabaseConnection(db)).not.toThrow()
  })

  it('allows initializeDatabase to run more than once without dropping data', () => {
    const slide = makeSlide()
    saveSlide(db, slide)

    expect(() => initializeDatabase(db)).not.toThrow()
    expect(getSlideIds(db)).toEqual([slide.id])
    expectStoredSlide(getSlide(db, slide.id), slide)
  })

  it('round-trips persisted slide fields through saveSlide and getSlide', () => {
    const slide = makeSlide()

    saveSlide(db, slide)

    expectStoredSlide(getSlide(db, slide.id), slide)
  })

  it('removes orphaned elements when a slide is updated', () => {
    const slide = makeSlide()
    saveSlide(db, slide)

    const updatedSlide: Slide = {
      ...slide,
      elements: [slide.elements[0]]
    }

    saveSlide(db, updatedSlide)

    expectStoredSlide(getSlide(db, slide.id), updatedSlide)
    const count = db
      .prepare('SELECT COUNT(*) AS total FROM elements WHERE slide_id = ?')
      .get(slide.id) as {
      total: number
    }
    expect(count.total).toBe(1)
  })

  it('saves multiple slides atomically with saveAllSlides', () => {
    const first = makeSlide({ id: 'slide-a' })
    const second = makeSlide({
      id: 'slide-b',
      elements: [
        {
          id: 'el-second',
          type: 'rect',
          x: 50,
          y: 60,
          width: 200,
          height: 100,
          angle: 5,
          fill: '#334455',
          zIndex: 0
        }
      ],
      animationOrder: [],
      background: { type: 'solid', color: '#ffeeaa' },
      transition: { type: 'push', duration: 0.8 }
    })

    saveAllSlides(db, [first, second])

    expect(getSlideIds(db)).toEqual([first.id, second.id])
    expectStoredSlide(getSlide(db, first.id), first)
    expectStoredSlide(getSlide(db, second.id), second)
  })

  it('keeps slide ordering compact across create, delete, reorder, and background updates', () => {
    const first = createSlide(db)
    const second = createSlide(db)
    const third = createSlide(db)

    expect(getSlideIds(db)).toEqual([first.id, second.id, third.id])

    deleteSlide(db, second.id)
    expect(getSlideIds(db)).toEqual([first.id, third.id])

    reorderSlides(db, [third.id, first.id])
    expect(getSlideIds(db)).toEqual([third.id, first.id])

    applyBackgroundToAllSlides(db, { type: 'solid', color: '#123456' })
    expect(getSlide(db, first.id)?.background).toEqual({ type: 'solid', color: '#123456' })
    expect(getSlide(db, third.id)?.background).toEqual({ type: 'solid', color: '#123456' })
  })

  it('rejects duplicate slide IDs in saveAllSlides and leaves the database untouched', () => {
    const duplicateId = 'slide-dup'

    expect(() =>
      saveAllSlides(db, [
        makeSlide({ id: duplicateId }),
        makeSlide({ id: duplicateId, elements: [] })
      ])
    ).toThrowError(
      `Duplicate slide ID detected: ${duplicateId}. Cannot save presentation with duplicate slides.`
    )

    expect(getSlideIds(db)).toEqual([])
  })

  it('returns null for a nonexistent slide ID', () => {
    expect(getSlide(db, 'missing-slide')).toBeNull()
  })

  it('persists thumbnails, settings, and fonts', () => {
    const slide = makeSlide({ id: 'slide-assets' })
    const font: FontData = {
      id: 'font-1',
      fontFamily: 'Demo Sans',
      fontData: Buffer.from([0, 1, 2, 3]),
      format: 'ttf',
      variant: 'bold-italic'
    }

    saveSlide(db, slide)
    saveThumbnail(db, slide.id, 'data:image/jpeg;base64,thumb')
    setSetting(db, 'locale', 'en')
    addFont(db, font)

    expect(getThumbnails(db)).toEqual({ [slide.id]: 'data:image/jpeg;base64,thumb' })
    expect(getSetting(db, 'locale')).toBe('en')
    expect(getFonts(db)).toEqual([font])
    expect(getFontData(db, font.fontFamily, font.variant)).toEqual(font)

    setSetting(db, 'locale', null)
    expect(getSetting(db, 'locale')).toBeNull()
  })

  it('tolerates malformed JSON already persisted in slide records', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      db.prepare(
        'INSERT INTO slides (id, slide_order, background, animation_order, transition) VALUES (?, ?, ?, ?, ?)'
      ).run('slide-bad-json', 0, '{bad', '{still bad', '{also bad')

      db.prepare(
        `INSERT INTO elements (
          id, slide_id, type, x, y, width, height, angle, fill, text, fontSize,
          fontFamily, styles, src, filename, z_index, animations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'el-bad-json',
        'slide-bad-json',
        'text',
        10,
        20,
        30,
        40,
        0,
        '#000000',
        'Broken',
        18,
        'Arial',
        '{bad styles',
        null,
        null,
        0,
        '{bad animations'
      )

      const slide = getSlide(db, 'slide-bad-json')

      expect(slide).toEqual({
        id: 'slide-bad-json',
        elements: [
          {
            id: 'el-bad-json',
            type: 'text',
            x: 10,
            y: 20,
            width: 30,
            height: 40,
            angle: 0,
            fill: '#000000',
            text: 'Broken',
            fontSize: 18,
            fontFamily: 'Arial',
            styles: undefined,
            src: undefined,
            filename: undefined,
            zIndex: 0,
            animations: undefined
          }
        ],
        background: undefined,
        animationOrder: [],
        transition: undefined
      })

      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
