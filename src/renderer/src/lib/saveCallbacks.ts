/**
 * Typed callback registry for cross-module save coordination.
 *
 * This replaces the `window.__DECKHAND_FLUSH_SAVE__` global with a type-safe
 * module-level callback. App.svelte registers its flushPendingSave function
 * on mount, and state.svelte.ts imports it for use during slide navigation.
 */

let _flushPendingSave: (() => Promise<void>) | null = null

/**
 * Registers the flush save callback. Called by App.svelte on mount.
 */
export function registerFlushSave(fn: () => Promise<void>): void {
  _flushPendingSave = fn
}

/**
 * Unregisters the flush save callback. Called by App.svelte on destroy.
 */
export function unregisterFlushSave(): void {
  _flushPendingSave = null
}

/**
 * Returns the registered flush save callback, or null if not yet registered.
 */
export function getFlushSave(): (() => Promise<void>) | null {
  return _flushPendingSave
}
