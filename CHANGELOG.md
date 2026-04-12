# Changelog

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
