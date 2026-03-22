# Changelog

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
