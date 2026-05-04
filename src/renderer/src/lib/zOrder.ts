import type { Canvas, FabricObject } from 'fabric'
import type { TwigElement } from './types'

type TwigFabricObject = FabricObject & { id?: string }

function findElement(elements: TwigElement[], id: string): TwigElement | undefined {
  return elements.find((el) => el.id === id)
}

function findAbove(elements: TwigElement[], id: string): TwigElement | undefined {
  const el = findElement(elements, id)
  if (!el) return undefined
  return elements
    .filter((candidate) => candidate.zIndex > el.zIndex)
    .sort((a, b) => a.zIndex - b.zIndex)[0]
}

function findBelow(elements: TwigElement[], id: string): TwigElement | undefined {
  const el = findElement(elements, id)
  if (!el) return undefined
  return elements
    .filter((candidate) => candidate.zIndex < el.zIndex)
    .sort((a, b) => b.zIndex - a.zIndex)[0]
}

export function compactZIndexes(elements: TwigElement[]): void {
  const sorted = [...elements].sort((a, b) => a.zIndex - b.zIndex)
  sorted.forEach((el, i) => {
    el.zIndex = i
  })
}

export function applyZOrderToCanvas(args: {
  elements: TwigElement[]
  fabCanvas: Canvas
  selectedId: string | null
}): void {
  const sorted = [...args.elements].sort((a, b) => a.zIndex - b.zIndex)
  const objs = args.fabCanvas.getObjects() as TwigFabricObject[]
  sorted.forEach((el, targetIndex) => {
    const obj = objs.find((candidate) => candidate.id === el.id)
    if (obj) args.fabCanvas.moveObjectTo(obj, targetIndex)
  })
  if (args.selectedId) {
    const obj = (args.fabCanvas.getObjects() as TwigFabricObject[]).find(
      (candidate) => candidate.id === args.selectedId
    )
    if (obj) args.fabCanvas.setActiveObject(obj)
  }
  args.fabCanvas.requestRenderAll()
}

export function canBringToFront(elements: TwigElement[], id: string): boolean {
  return Boolean(findElement(elements, id))
}

export function canSendToBack(elements: TwigElement[], id: string): boolean {
  return Boolean(findElement(elements, id))
}

export function canMoveUp(elements: TwigElement[], id: string): boolean {
  return Boolean(findAbove(elements, id))
}

export function canMoveDown(elements: TwigElement[], id: string): boolean {
  return Boolean(findBelow(elements, id))
}

export function applyBringToFront(elements: TwigElement[], id: string): void {
  const el = findElement(elements, id)
  if (!el) return
  const max = elements.reduce((m, candidate) => Math.max(m, candidate.zIndex), -Infinity)
  el.zIndex = max + 1
}

export function applySendToBack(elements: TwigElement[], id: string): void {
  const el = findElement(elements, id)
  if (!el) return
  const min = elements.reduce((m, candidate) => Math.min(m, candidate.zIndex), Infinity)
  el.zIndex = min - 1
}

export function applyMoveUp(elements: TwigElement[], id: string): void {
  const el = findElement(elements, id)
  const above = findAbove(elements, id)
  if (!el || !above) return
  ;[el.zIndex, above.zIndex] = [above.zIndex, el.zIndex]
}

export function applyMoveDown(elements: TwigElement[], id: string): void {
  const el = findElement(elements, id)
  const below = findBelow(elements, id)
  if (!el || !below) return
  ;[el.zIndex, below.zIndex] = [below.zIndex, el.zIndex]
}
