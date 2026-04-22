import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addFont,
  applyBackgroundToAllSlides,
  configureDatabaseConnection,
  createSlide,
  deleteSlide,
  duplicateSlide,
  getFontData,
  getFonts,
  getSetting,
  getSlide,
  getSlideIds,
  getThumbnails,
  isBootstrapPresentation,
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
        fontWeight: 'bold',
        fontStyle: 'italic',
        underline: true,
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

  it('duplicates a slide immediately after the source with remapped element IDs', () => {
    const before = createSlide(db)
    const source = makeSlide({
      id: 'slide-source',
      elements: [
        makeSlide().elements[0],
        {
          id: 'el-arrow',
          type: 'arrow',
          x: 240,
          y: 180,
          width: 220,
          height: 80,
          angle: 12,
          fill: '#778899',
          zIndex: 1,
          arrowShape: {
            headWidthRatio: 0.9,
            headLengthRatio: 0.35,
            shaftThicknessRatio: 0.45
          },
          animations: {
            buildIn: { type: 'appear', duration: 0.2 }
          }
        },
        { ...makeSlide().elements[1], zIndex: 2 }
      ],
      animationOrder: [
        { elementId: 'el-text', category: 'buildIn' },
        { elementId: 'el-text', category: 'action', actionId: 'action-1' },
        { elementId: 'el-arrow', category: 'buildIn' },
        { elementId: 'el-text', category: 'buildOut' }
      ]
    })
    saveSlide(db, source)
    const after = createSlide(db)
    saveThumbnail(db, source.id, 'data:image/jpeg;base64,dup-thumb')
    const sourceBeforeDuplicate = getSlide(db, source.id)
    expect(sourceBeforeDuplicate).not.toBeNull()

    const duplicated = duplicateSlide(db, source.id)
    const persisted = getSlide(db, duplicated.id)

    expect(getSlideIds(db)).toEqual([before.id, source.id, duplicated.id, after.id])
    expect(getThumbnails(db)).toEqual({
      [source.id]: 'data:image/jpeg;base64,dup-thumb',
      [duplicated.id]: 'data:image/jpeg;base64,dup-thumb'
    })
    expect(duplicated.id).not.toBe(source.id)
    expect(duplicated.background).toEqual(source.background)
    expect(duplicated.transition).toEqual(source.transition)
    expect(duplicated.elements).toHaveLength(source.elements.length)
    expect(new Set(duplicated.elements.map((el) => el.id)).size).toBe(source.elements.length)

    source.elements.forEach((sourceElement, index) => {
      const duplicatedElement = duplicated.elements[index]
      expect(duplicatedElement.id).not.toBe(sourceElement.id)
      expect(duplicatedElement).toMatchObject({ ...sourceElement, id: duplicatedElement.id })
    })

    const [duplicatedText, duplicatedArrow, duplicatedImage] = duplicated.elements
    expect(duplicated.animationOrder).toEqual([
      { elementId: duplicatedText.id, category: 'buildIn' },
      { elementId: duplicatedText.id, category: 'action', actionId: 'action-1' },
      { elementId: duplicatedArrow.id, category: 'buildIn' },
      { elementId: duplicatedText.id, category: 'buildOut' }
    ])
    expect(duplicatedImage.src).toBe(source.elements[2].src)
    expect(getSlide(db, source.id)).toEqual(sourceBeforeDuplicate)
    expectStoredSlide(persisted, duplicated)
  })

  it('throws before writing when duplicating a missing slide', () => {
    const slide = makeSlide({ id: 'slide-existing' })
    saveSlide(db, slide)
    saveThumbnail(db, slide.id, 'data:image/jpeg;base64,thumb')

    expect(() => duplicateSlide(db, 'missing-slide')).toThrowError('Slide not found: missing-slide')
    expect(getSlideIds(db)).toEqual([slide.id])
    expect(getThumbnails(db)).toEqual({ [slide.id]: 'data:image/jpeg;base64,thumb' })
    expectStoredSlide(getSlide(db, slide.id), slide)
  })

  it('rolls back slide order and inserted rows when duplication fails mid-transaction', () => {
    const before = createSlide(db)
    const source = makeSlide({ id: 'slide-rollback-source' })
    saveSlide(db, source)
    const after = createSlide(db)
    saveThumbnail(db, source.id, 'data:image/jpeg;base64,rollback-thumb')
    const previousSlideIds = getSlideIds(db)
    const previousThumbnails = getThumbnails(db)
    const sourceBeforeDuplicate = getSlide(db, source.id)

    db.exec(`
      CREATE TRIGGER fail_duplicate_element_insert
      BEFORE INSERT ON elements
      WHEN NEW.slide_id != '${source.id}'
      BEGIN
        SELECT RAISE(ABORT, 'duplicate element insert failed');
      END
    `)

    expect(() => duplicateSlide(db, source.id)).toThrowError('duplicate element insert failed')
    expect(getSlideIds(db)).toEqual([before.id, source.id, after.id])
    expect(getSlideIds(db)).toEqual(previousSlideIds)
    expect(getThumbnails(db)).toEqual(previousThumbnails)
    expect(getSlide(db, source.id)).toEqual(sourceBeforeDuplicate)
  })

  it('recognizes the untouched bootstrap presentation and ignores thumbnails', () => {
    const slide = createSlide(db)

    expect(isBootstrapPresentation(db)).toBe(true)

    saveThumbnail(db, slide.id, 'data:image/jpeg;base64,thumb')
    expect(isBootstrapPresentation(db)).toBe(true)
  })

  it('returns false once the presentation has more than one slide', () => {
    createSlide(db)
    createSlide(db)

    expect(isBootstrapPresentation(db)).toBe(false)
  })

  it('returns false when the bootstrap slide has elements', () => {
    saveSlide(
      db,
      makeSlide({
        id: 'slide-bootstrap-modified',
        background: undefined,
        animationOrder: [],
        transition: undefined
      })
    )

    expect(isBootstrapPresentation(db)).toBe(false)
  })

  it('returns false when the bootstrap slide has a background or transition', () => {
    const slide = createSlide(db)
    saveSlide(
      db,
      makeSlide({
        id: slide.id,
        elements: [],
        background: { type: 'solid', color: '#101010' },
        animationOrder: [],
        transition: { type: 'push', duration: 0.6 }
      })
    )

    expect(isBootstrapPresentation(db)).toBe(false)
  })

  it('returns false when the bootstrap slide has animation steps', () => {
    const slide = createSlide(db)
    saveSlide(
      db,
      makeSlide({
        id: slide.id,
        elements: [],
        background: undefined,
        transition: undefined,
        animationOrder: [{ elementId: 'ghost', category: 'buildIn' }]
      })
    )

    expect(isBootstrapPresentation(db)).toBe(false)
  })

  it('returns false when fonts or settings exist in the presentation', () => {
    createSlide(db)
    addFont(db, {
      id: 'font-bootstrap',
      fontFamily: 'Demo Sans',
      fontData: Buffer.from([1, 2, 3]),
      format: 'ttf',
      variant: 'normal-normal'
    })

    expect(isBootstrapPresentation(db)).toBe(false)

    db.close()
    db = createDb()
    createSlide(db)
    setSetting(db, 'default_background', '{"type":"solid","color":"#ffffff"}')

    expect(isBootstrapPresentation(db)).toBe(false)
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
          fontFamily, fontWeight, fontStyle, underline, styles, src, filename, z_index, animations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        null,
        null,
        null,
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
            fontWeight: 'normal',
            fontStyle: 'normal',
            underline: false,
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
