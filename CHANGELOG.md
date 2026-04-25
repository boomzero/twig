# Changelog

## [1.1.0] - 2026-04-25

### Added

- **Versioned `.tb` file format (v1)** with forward-compatibility messaging: every `.tb` now carries `PRAGMA application_id = 0x74776967` and `PRAGMA user_version = 1`, plus reserved `settings` rows for format version, provenance, and a `compat_notes` payload that newer writers use to warn older readers about format changes. A newer-than-supported file opens in a read-only mode that displays the writer's `compat_notes` verbatim. `compat_notes` accepts either a plain string or a locale-keyed JSON object for i18n. See `TWIG_SPEC.md` §11–§12.
- Parameterized block arrow shape with adjustment handles
- Keynote-style alignment guides for object positioning
- Snap-to-guides setting with improved rotation behavior
- Slide duplication from the thumbnail sidebar (#48)
- Vitest v8 coverage reporting

### Fixed

- Stale slide thumbnails after visual edits
- Presentation mode z-ordering
- CJK textbox wrapping
- Base text style persistence and compact controls for tiny selections (#47)
- Alignment guides now use the rendered textbox width (trimming trailing character spacing) instead of the raw bounding box, so guides line up with the visible text on wrapped and CJK content

### Changed

- Scoped reload menu items to development builds
- Updated installation guidance in README
- Expanded `.tb` format documentation for newer shape and slide data
- Legacy 1.0.x `.tb` files are upgraded in place on first open: pragmas are stamped, reserved metadata rows are written, and missing columns (`shape_params`, `fontWeight`, `fontStyle`, `underline`) are added. Upgrade is non-destructive; provenance fields record the upgrading twig version and the upgrade time.

## [1.0.1] - 2026-04-13

### Added

- Temp presentation destruction guard: unsaved presentations now prompt to save before closing, quitting, or opening another file (#44)
- Renderer-driven close handshake replacing the old force-close save flush (#44)
- Close failure modal for graceful error recovery when shutdown save fails (#44)
- Unit tests for window close controller, temp presentation guard, and DB bootstrap detection (#44)

### Fixed

- Rich text style edits (bold, italic, etc.) on animated text not persisting after autosave (#45)
- Active text object content and styles now flushed into slide state before save serialization (#45)

### Changed

- Removed `.vscode` directory from the repository

## [1.0.0] - 2026-04-12

First stable release. Twig is now available on the Mac App Store.

### Added

- Core Vitest test harness
- Mac App Store badge and macOS platform details in README
- Custom AppX logo assets for Windows Store

### Fixed

- Mac App Store sandbox file access handling
- Mac App Review issues for MAS submission
- Stale `createApplicationMenu` call replaced with `setupMacAppMenu`
- Windows release and Store packaging split correctly
- Store package metadata alignment
- MSIX publisher display name sourced from environment variable

## [1.0.0-rc.12] - 2026-04-05

### Added

- Windows Store (MSIX) build support and store distribution improvements
- Startup loading UI

### Fixed

- macOS App Sandbox: WAL journal mode, rename fallback, and security-scoped bookmarks so saved files remain accessible across sessions
- Auto-updater: trust `result.isUpdateAvailable` directly instead of re-deriving availability from version strings
- Auto-updater release channel resolution
- DB hardening (foreign keys, trusted schema, integrity checks on open)

## [1.0.0-rc.11] - 2026-03-28

### Added

- Internationalization (EN/ZH) with language setting in the new Settings page
- Settings page with auto-update toggle
- macOS App Store build support

## [1.0.0-rc.10] - 2026-03-23

### Fixed

- Backspace/Delete in properties panel text fields no longer deletes the selected canvas object

## [1.0.0-rc.9] - 2026-03-22

### Added

- Auto-update: silently checks for updates on startup; shows a banner when a new version is ready to install
- Window title now shows the open filename (e.g. `my-deck — twig`)

## [1.0.0-rc.8] - 2026-03-22

### Fixed

- Remove white background from app icon

## [1.0.0-rc.7] - 2026-03-22

### Fixed

- Publish releases as drafts so all platform artifacts upload before going live

## [1.0.0-rc.6] - 2026-03-22

### Fixed

- Drop snap target (requires Snap Store credentials); ship AppImage and deb only

## [1.0.0-rc.5] - 2026-03-22

### Fixed

- Remove `canvas` optional dependency entirely to prevent CI build failures on macOS and Linux

## [1.0.0-rc.4] - 2026-03-22

### Fixed

- macOS: remove canvas after rebuilding native modules to prevent unsigned dylibs from being bundled

## [1.0.0-rc.3] - 2026-03-22

### Fixed

- Grant `contents: write` permission so CI can create GitHub releases

## [1.0.0-rc.2] - 2026-03-22

### Fixed

- Linux build: correct icon path to `build/icons/png`

## [1.0.0-rc.1] - 2026-03-22

### Added

- **Slide transitions**: Dissolve and push transitions between slides
- **Per-element animations**: Build in/out animations with multiple action types
- **Undo/redo**: In-memory per-slide undo/redo (Cmd+Z / Cmd+Shift+Z)
- **Copy/paste/cut**: Duplicate elements with Cmd+C/V/X and right-click context menu
- **Slide backgrounds**: Solid color, gradient, and image backgrounds
- **Slide reordering and deletion**: Drag to reorder slides in the panel
- **Keynote-style toolbar**: Redesigned toolbar with Phosphor icons
- **Custom fonts**: Font selection in the properties panel
- **Presentation mode**: Full-screen slide presentation with transitions
- **Debug window**: Real-time state inspector (Cmd+Shift+D)
- **Auto-save**: All changes saved automatically with 300ms debounce
- **File format**: Presentations stored as `.tb` SQLite database files
