# .tb File Format

> This document describes the `.tb` format as implemented in **twig 1.1.0** (format version **v1**).

A `.tb` file is a standard SQLite database that stores a twig presentation. You can create, read, or modify one with any SQLite tooling — no proprietary library required.

Since twig 1.1.0, every `.tb` file carries a **machine-readable format identity** (`PRAGMA application_id`, `PRAGMA user_version`) and **human-readable provenance metadata** (rows in the `settings` table). Readers use these to distinguish twig files from other SQLite files and to warn users when a file is newer than the reader supports. See [§11](#11-format-version-provenance-and-forward-compatibility).

---

## Table of contents

1. [Database schema](#1-database-schema)
2. [Canvas coordinate system](#2-canvas-coordinate-system)
3. [Element types and their fields](#3-element-types-and-their-fields)
4. [JSON column reference](#4-json-column-reference)
   - 4.1 [SlideBackground](#41-slidebackground)
   - 4.2 [SlideTransition](#42-slidetransition)
   - 4.3 [AnimationStep\[\] (animation_order)](#43-animationstep-animation_order)
   - 4.4 [ElementAnimations (animations)](#44-elementanimations-animations)
   - 4.5 [Fabric.js rich-text styles](#45-fabricjs-rich-text-styles)
   - 4.6 [Arrow shape (shape_params)](#46-arrow-shape-shape_params)
5. [Clipboard interop format](#5-clipboard-interop-format)
6. [Element ID naming convention](#6-element-id-naming-convention)
7. [Z-index rules](#7-z-index-rules)
8. [Fonts table](#8-fonts-table)
9. [Complete worked example (Python)](#9-complete-worked-example-python)
10. [Checklist for AI-generated files](#10-checklist-for-ai-generated-files)
11. [Format version, provenance, and forward compatibility](#11-format-version-provenance-and-forward-compatibility)
12. [Format changelog](#12-format-changelog)

---

## 1. Database schema

```sql
PRAGMA foreign_keys = ON;

-- One row per slide. slide_order determines left-to-right panel order.
CREATE TABLE slides (
  id             TEXT PRIMARY KEY,   -- UUID v4
  slide_order    INTEGER NOT NULL,   -- 0-based, sequential, no gaps
  thumbnail      TEXT,               -- JPEG data URI for panel preview (optional)
  background     TEXT,               -- JSON SlideBackground; NULL = white
  animation_order TEXT NOT NULL      -- JSON AnimationStep[]; use '[]' when empty
                  DEFAULT '[]',
  transition     TEXT                -- JSON SlideTransition; NULL = no transition
);

-- One row per element on a slide.
CREATE TABLE elements (
  id          TEXT PRIMARY KEY,      -- "<type>_<uuid>", e.g. "rect_3f2a..."
  slide_id    TEXT NOT NULL
                REFERENCES slides(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,         -- see §3
  x           REAL NOT NULL,         -- center X in canvas pixels
  y           REAL NOT NULL,         -- center Y in canvas pixels
  width       REAL NOT NULL,
  height      REAL NOT NULL,
  angle       REAL NOT NULL,         -- rotation in degrees, 0 = upright
  fill        TEXT,                  -- hex '#rrggbb' or 'rgba(r,g,b,a)'
  text        TEXT,                  -- content (text elements only)
  fontSize    REAL,                  -- px (text elements only)
  fontFamily  TEXT,                  -- family name (text elements only)
  fontWeight  TEXT,                  -- 'normal' | 'bold' | numeric weight (text elements only)
  fontStyle   TEXT,                  -- 'normal' | 'italic' | 'oblique' (text elements only)
  underline   INTEGER,               -- 0 | 1, base underline flag (text elements only)
  styles      TEXT,                  -- JSON rich-text styles (text elements only)
  src         TEXT,                  -- base64 data URI (image elements only)
  filename    TEXT,                  -- original filename hint (image elements only)
  z_index     INTEGER NOT NULL       -- render order; higher = in front
                DEFAULT 0,
  animations  TEXT,                  -- JSON ElementAnimations (optional)
  shape_params TEXT                  -- JSON shape-specific params (arrow only; see §4.6)
);

-- Embedded font files — store these so presentations are self-contained.
CREATE TABLE fonts (
  id         TEXT PRIMARY KEY,       -- any stable unique key (hash or UUID)
  fontFamily TEXT NOT NULL,          -- must match fontFamily used in elements
  fontData   BLOB NOT NULL,          -- raw font file bytes
  format     TEXT NOT NULL,          -- 'ttf' | 'ttc' | 'woff' | 'woff2' | 'otf'
  variant    TEXT NOT NULL           -- '<weight>-<style>' e.g. 'normal-normal'
);

-- Key/value store for per-presentation settings AND format-identity metadata.
-- Five keys are RESERVED by the format (see §11) — writers must not store
-- user content under these keys, and readers must ignore them when detecting
-- "is this an untouched blank presentation?":
--   format_version
--   compat_notes
--   created_with_app_version
--   created_at
--   last_written_with_app_version
-- All other keys are available for app-level settings (e.g. default_background).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

---

## 2. Canvas coordinate system

The slide canvas is fixed at **960 × 540 pixels** (16:9 aspect ratio).

Element coordinates use the **center point** as origin — this is the fabric.js default (`originX = 'center'`, `originY = 'center'`). A 200×100 rectangle centered on the slide therefore has `x = 480`, `y = 270`.

```
(0,0) ──────────────────────────────── (960,0)
  │                                       │
  │              (480,270)                │
  │           ← center point →            │
  │                                       │
(0,540) ─────────────────────────── (960,540)
```

Key landmark positions:

| Position              | x   | y   |
| --------------------- | --- | --- |
| Canvas center         | 480 | 270 |
| Top-left quadrant     | 240 | 135 |
| Top-right quadrant    | 720 | 135 |
| Bottom-left quadrant  | 240 | 405 |
| Bottom-right quadrant | 720 | 405 |

When pasting, twig clamps element centers to `[0, 959]` × `[0, 539]` to keep them on-canvas.

---

## 3. Element types and their fields

All element types share the **common fields**: `id`, `slide_id`, `type`, `x`, `y`, `width`, `height`, `angle`, `z_index`.

| `type`     | Required additional fields       | Optional fields                                                                     |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `rect`     | —                                | `fill`, `animations`                                                                |
| `ellipse`  | —                                | `fill`, `animations`                                                                |
| `triangle` | —                                | `fill`, `animations`                                                                |
| `star`     | —                                | `fill`, `animations`                                                                |
| `arrow`    | —                                | `fill`, `animations`, `shape_params` (see §4.6)                                     |
| `text`     | `text`, `fontSize`, `fontFamily` | `fill` (text color), `fontWeight`, `fontStyle`, `underline`, `styles`, `animations` |
| `image`    | `src`                            | `filename`, `animations`                                                            |

**Default values used by the editor when adding elements:**

| Type       | Default `width` | Default `height` | Default `fill` | Default `fontSize` |
| ---------- | --------------- | ---------------- | -------------- | ------------------ |
| `rect`     | 150             | 100              | `#FF6F61`      | —                  |
| `ellipse`  | 150             | 150              | `#FF6F61`      | —                  |
| `triangle` | 150             | 130              | `#FF6F61`      | —                  |
| `star`     | 150             | 150              | `#FF6F61`      | —                  |
| `arrow`    | 200             | 100              | `#FF6F61`      | —                  |
| `text`     | 200             | 50               | `#333333`      | 40                 |

Text elements use `Arial` as the default `fontFamily`.

---

## 4. JSON column reference

### 4.1 SlideBackground

Stored in `slides.background`. `NULL` means a plain white background.

#### Solid color

```json
{ "type": "solid", "color": "#1a1a2e" }
```

`color` is any CSS color string (hex, rgb, rgba, named colors).

#### Linear gradient

```json
{
  "type": "gradient",
  "angle": 135,
  "stops": [
    { "offset": 0, "color": "#1a1a2e" },
    { "offset": 1, "color": "#16213e" }
  ]
}
```

- `angle`: degrees, 0 = top-to-bottom, 90 = left-to-right, 135 = diagonal
- `stops`: exactly two stops; `offset` must be `0` and `1`

#### Image background

```json
{
  "type": "image",
  "src": "data:image/jpeg;base64,/9j/4AAQ...",
  "filename": "background.jpg",
  "fit": "cover"
}
```

- `src`: base64 data URI (PNG, JPEG, or WebP)
- `filename`: optional human-readable hint, not used for loading
- `fit`: `"stretch"` | `"contain"` | `"cover"` (default: `"cover"`)

---

### 4.2 SlideTransition

Stored in `slides.transition`. `NULL` means no transition animation between slides.

```json
{ "type": "dissolve", "duration": 0.4 }
```

| `type`       | Description                   |
| ------------ | ----------------------------- |
| `"none"`     | Instant cut (same as NULL)    |
| `"dissolve"` | Cross-fade between slides     |
| `"push"`     | New slide pushes old one left |

`duration` is in seconds (e.g. `0.4`).

---

### 4.3 AnimationStep[] (animation_order)

Stored in `slides.animation_order`. Always present — use `'[]'` when there are no animations.

Each step in the array represents one user-triggered animation event (one press of the spacebar / advance key during presentation):

```json
[
  { "elementId": "text_3f2a...", "category": "buildIn" },
  { "elementId": "rect_9c1b...", "category": "action", "actionId": "move-action-uuid" },
  { "elementId": "text_3f2a...", "category": "buildOut" }
]
```

| Field       | Type   | Description                                                                             |
| ----------- | ------ | --------------------------------------------------------------------------------------- |
| `elementId` | string | ID of the element this step controls                                                    |
| `category`  | string | `"buildIn"` \| `"action"` \| `"buildOut"`                                               |
| `actionId`  | string | Required when `category` is `"action"` — matches an `id` in `ElementAnimations.actions` |

The order in this array is the order animations fire during presentation. Elements not listed here appear immediately when the slide loads.

---

### 4.4 ElementAnimations (animations)

Stored in `elements.animations`. `NULL` means the element appears instantly with no animation.

```json
{
  "buildIn": {
    "type": "fade-in",
    "duration": 0.5
  },
  "buildOut": {
    "type": "fade-out",
    "duration": 0.3
  },
  "actions": [
    {
      "id": "move-action-uuid",
      "type": "move",
      "toX": 700,
      "toY": 400,
      "duration": 0.6
    }
  ]
}
```

All three sub-objects are optional. You may have only a `buildIn`, only `actions`, etc.

**buildIn types:**

| `type`      | Effect                           |
| ----------- | -------------------------------- |
| `"appear"`  | Instantly visible (snaps in)     |
| `"fade-in"` | Fades from transparent to opaque |

**buildOut types:**

| `type`        | Effect                           |
| ------------- | -------------------------------- |
| `"disappear"` | Instantly hidden (snaps out)     |
| `"fade-out"`  | Fades from opaque to transparent |

**action types:**

| `type`   | Additional fields        | Description                              |
| -------- | ------------------------ | ---------------------------------------- |
| `"move"` | `toX`, `toY`, `duration` | Animates element center to (`toX`,`toY`) |

Each action needs a stable `id` (UUID) because `animation_order` references it by `actionId`.

---

### 4.5 Fabric.js rich-text styles

Stored in `elements.styles`. `NULL` means all text uses the element-level `fontSize`, `fontFamily`, `fontWeight`, `fontStyle`, `underline`, and `fill`.

Use this column only when individual characters need different formatting — per-character entries here override the element-level fields for those characters. The structure is a nested object:

```
{
  "<line-index>": {
    "<char-index>": { <style overrides> }
  }
}
```

Example — bold first word, red second word:

```json
{
  "0": {
    "0": { "fontWeight": "bold" },
    "1": { "fontWeight": "bold" },
    "2": { "fontWeight": "bold" },
    "3": { "fontWeight": "bold" },
    "4": { "fontWeight": "bold" },
    "5": { "fill": "#ff0000" },
    "6": { "fill": "#ff0000" },
    "7": { "fill": "#ff0000" }
  }
}
```

Supported per-character style properties (fabric.js IText):

| Property      | Example value           | Description         |
| ------------- | ----------------------- | ------------------- |
| `fill`        | `"#ff0000"`             | Text color override |
| `fontSize`    | `24`                    | Size in px          |
| `fontWeight`  | `"bold"` / `"normal"`   | Weight override     |
| `fontStyle`   | `"italic"` / `"normal"` | Style override      |
| `underline`   | `true`                  | Underline           |
| `linethrough` | `true`                  | Strikethrough       |

For plain uniform text, leave `styles` as `NULL` — it is more efficient and easier to generate.

### 4.6 Arrow shape (shape_params)

Stored in `elements.shape_params`. `NULL` is equivalent to the default ratios below and is preferred for rows that have never been customized. Only meaningful when `elements.type = 'arrow'`; ignored for all other types.

```json
{
  "headWidthRatio": 1.0,
  "headLengthRatio": 0.4,
  "shaftThicknessRatio": 0.4
}
```

The arrow is rendered as a 7-point block polygon recomputed from the element's `width` (`w`), `height` (`h`), and these three ratios:

```
headW   = h * headWidthRatio            // head base span (vertical)
headL   = w * headLengthRatio           // head horizontal extent
shaftT  = headW * shaftThicknessRatio   // shaft thickness
```

| Field                 | Range         | Default | Meaning                                                        |
| --------------------- | ------------- | ------- | -------------------------------------------------------------- |
| `headWidthRatio`      | `0.1`–`1.0`   | `1.0`   | Head base span as a fraction of `height`                       |
| `headLengthRatio`     | `0.05`–`0.95` | `0.4`   | Head extent as a fraction of `width`                           |
| `shaftThicknessRatio` | `0.05`–`1.0`  | `0.4`   | Shaft thickness as a fraction of **head base width** (`headW`) |

**Default ratios reproduce the pre-`shape_params` arrow exactly** for any `width`/`height`. Legacy rows with `shape_params = NULL` must be treated as having these defaults.

**Known behavior — shaft/head coupling.** Because `shaftT` is expressed relative to `headW` (not `height`), changing `headWidthRatio` also changes the visible shaft thickness in pixels. In the editor, dragging the junction adjustment handle therefore visually fattens or thins the shaft as a side effect, even though `shaftThicknessRatio` is untouched. The shaft handle inverts this coupling, so it always lands on the pointer's Y. Generators can rely on this formula directly; it is stable and part of the format.

---

## 5. Clipboard interop format

Twig uses the system clipboard to copy and paste elements between slides and between windows. The clipboard payload is plain text (`text/plain`) containing JSON.

### Clipboard JSON structure

```json
{
  "__twig_clipboard__": true,
  "copyId": "<uuid-v4>",
  "elements": [ <TwigElement>, ... ]
}
```

| Field                | Description                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `__twig_clipboard__` | Always `true`. Acts as a sentinel so twig ignores unrelated clipboard text.                       |
| `copyId`             | A fresh UUID generated on every copy. Allows twig to detect when a new copy overwrites the last.  |
| `elements`           | Array of serialized `TwigElement` objects (same structure as the `elements` table rows, not SQL). |

Each element in `elements` is a plain JavaScript object with these fields:

```json
{
  "type": "rect",
  "id": "rect_3f2a1b...",
  "x": 480,
  "y": 270,
  "width": 150,
  "height": 100,
  "angle": 0,
  "fill": "#FF6F61",
  "zIndex": 2,

  // text elements only
  "text": "Hello",
  "fontSize": 40,
  "fontFamily": "Arial",
  "styles": null,

  // image elements only — base64 data URI, required (not optional on clipboard)
  "src": "data:image/png;base64,iVBOR...",
  "filename": "photo.png",

  // optional on all types
  "animations": null
}
```

> **Note on image `src`:** In the database, `src` is only written on initial INSERT and never updated. On the clipboard, `src` is always present for image elements because it is populated from an in-memory asset map, ensuring the full image data travels with the element.

### Paste behavior

When twig reads from the clipboard:

1. It reads `text/plain` from the clipboard event.
2. If the text is valid JSON with `__twig_clipboard__: true`, it processes the `elements` array.
3. Every element is **validated** before use. An element is rejected if:
   - `type` is not one of the seven valid values
   - `id` is not a string
   - `x`, `y`, `width`, `height`, `angle`, or `zIndex` is not a number
   - `type === "image"` but `src` is not a string
4. Each accepted element gets a **fresh ID** (`<original-type-prefix>_<new-uuid>`) and its position is offset by `pasteCount × 20 px` to avoid stacking.
5. `animations` is stripped to `undefined` — pasted copies start with no animation config.
6. Element centers are **clamped** to `[0, 959] × [0, 539]`.

If `text/plain` is not a twig payload, twig falls back to looking for an `image/*` clipboard item (e.g., a screenshot) and imports it as a new image element centered at `(480, 270)`, scaled to fit within 960×540.

### Producing clipboard-compatible JSON (for scripting / automation)

To place elements on the clipboard so twig will accept them on paste, write a JSON string of the above structure to the system clipboard. Minimal valid example:

```python
import json, uuid, subprocess, sys

payload = {
    "__twig_clipboard__": True,
    "copyId": str(uuid.uuid4()),
    "elements": [
        {
            "type": "rect",
            "id": f"rect_{uuid.uuid4()}",
            "x": 300, "y": 200,
            "width": 200, "height": 120,
            "angle": 0,
            "fill": "#4a90d9",
            "zIndex": 0
        },
        {
            "type": "text",
            "id": f"text_{uuid.uuid4()}",
            "x": 300, "y": 200,
            "width": 180, "height": 40,
            "angle": 0,
            "fill": "#ffffff",
            "text": "Pasted from script",
            "fontSize": 20,
            "fontFamily": "Arial",
            "zIndex": 1
        }
    ]
}

text = json.dumps(payload)

# macOS
subprocess.run("pbcopy", input=text.encode(), check=True)
# Linux (xclip): subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode())
# Windows: subprocess.run("clip", input=text.encode("utf-16"), check=True)

print("Clipboard ready — switch to twig and press Cmd/Ctrl+V")
```

---

## 6. Element ID naming convention

IDs use the pattern `<type>_<uuid-v4>`:

| Element type | ID prefix   | Example                 |
| ------------ | ----------- | ----------------------- |
| `rect`       | `rect_`     | `rect_3f2a1b4c-...`     |
| `ellipse`    | `ellipse_`  | `ellipse_9c1b2d3e-...`  |
| `triangle`   | `triangle_` | `triangle_7a8b9c0d-...` |
| `star`       | `star_`     | `star_1a2b3c4d-...`     |
| `arrow`      | `arrow_`    | `arrow_5e6f7a8b-...`    |
| `text`       | `text_`     | `text_2b3c4d5e-...`     |
| `image`      | `image_`    | `image_6f7a8b9c-...`    |

The prefix before `_` is used during paste to preserve element type in the regenerated ID. IDs must be unique across the entire file (all slides).

---

## 7. Z-index rules

- `z_index` is a non-negative integer.
- Elements are rendered in ascending `z_index` order — higher values render on top.
- The editor assigns z-index as `max(existing z_index) + 1` when adding a new element.
- For a fresh slide with no elements, the first element gets `z_index = 0`.
- There are no required gaps; sequential integers `0, 1, 2, ...` work fine.
- Duplicate z-index values are allowed; elements with the same z-index are ordered by database row order.

---

## 8. Fonts table

All fonts must be embedded in the `fonts` table so presentations render correctly on any machine — **except web-safe fonts**, which are guaranteed to be available everywhere and are intentionally skipped by the editor. The web-safe fonts exempt from embedding are:

`Arial`, `Helvetica`, `Times New Roman`, `Times`, `Courier New`, `Courier`, `Verdana`, `Georgia`, `Palatino`, `Garamond`, `Bookman`, `Comic Sans MS`, `Trebuchet MS`, `Impact`

Any `fontFamily` value not on this list must have a corresponding row in the `fonts` table.

```
fonts.variant format: "<weight>-<style>"
```

| Weight | Style  | `variant` value |
| ------ | ------ | --------------- |
| normal | normal | `normal-normal` |
| bold   | normal | `bold-normal`   |
| normal | italic | `normal-italic` |
| bold   | italic | `bold-italic`   |

Example insertion:

```python
with open("Roboto-Regular.ttf", "rb") as f:
    font_bytes = f.read()

db.execute(
    "INSERT OR REPLACE INTO fonts (id, fontFamily, fontData, format, variant)"
    " VALUES (?, ?, ?, ?, ?)",
    (str(uuid.uuid4()), "Roboto", font_bytes, "ttf", "normal-normal")
)
```

If a text element references a `fontFamily` that has no matching row in `fonts`, the renderer falls back to the browser's default font.

---

## 9. Complete worked example (Python)

This script creates a two-slide `.tb` presentation from scratch with no external dependencies beyond the standard library and `sqlite3`.

```python
#!/usr/bin/env python3
"""
Create a minimal twig presentation (.tb file) from scratch.
Requires only Python 3.6+ and its built-in sqlite3 module.
"""
import sqlite3
import json
import uuid
from datetime import datetime, timezone

# Format identity (see §11). 0x74776967 is ASCII for "twig".
TWIG_APPLICATION_ID = 0x74776967
CURRENT_FORMAT_VERSION = 1
APP_VERSION = "external-script-1.0"  # whatever your tool calls itself

def new_id():
    return str(uuid.uuid4())

def create_presentation(path: str) -> None:
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys = ON")

    # ── Format identity pragmas ───────────────────────────────────────────────
    # Stamp these BEFORE any inserts so twig recognises the file as a twig
    # presentation and not an unrelated SQLite DB.
    db.execute(f"PRAGMA application_id = {TWIG_APPLICATION_ID}")
    db.execute(f"PRAGMA user_version = {CURRENT_FORMAT_VERSION}")

    # ── Schema ────────────────────────────────────────────────────────────────
    db.executescript("""
        CREATE TABLE IF NOT EXISTS slides (
            id TEXT PRIMARY KEY,
            slide_order INTEGER NOT NULL,
            thumbnail TEXT,
            background TEXT,
            animation_order TEXT NOT NULL DEFAULT '[]',
            transition TEXT
        );
        CREATE TABLE IF NOT EXISTS elements (
            id TEXT PRIMARY KEY,
            slide_id TEXT NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            x REAL NOT NULL, y REAL NOT NULL,
            width REAL NOT NULL, height REAL NOT NULL,
            angle REAL NOT NULL,
            fill TEXT,
            text TEXT, fontSize REAL, fontFamily TEXT,
            fontWeight TEXT, fontStyle TEXT, underline INTEGER,
            styles TEXT,
            src TEXT, filename TEXT,
            z_index INTEGER NOT NULL DEFAULT 0,
            animations TEXT,
            shape_params TEXT
        );
        CREATE TABLE IF NOT EXISTS fonts (
            id TEXT PRIMARY KEY,
            fontFamily TEXT NOT NULL,
            fontData BLOB NOT NULL,
            format TEXT NOT NULL,
            variant TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT
        );
    """)

    # ── Reserved format-metadata rows (see §11) ──────────────────────────────
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    db.executemany(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [
            ("format_version", str(CURRENT_FORMAT_VERSION)),
            # Empty for v1 writers. Future writers put a forward-compat message
            # here (plain string OR a JSON object keyed by BCP-47 locale).
            ("compat_notes", ""),
            ("created_with_app_version", APP_VERSION),
            ("created_at", now_iso),
            ("last_written_with_app_version", APP_VERSION),
        ],
    )

    # ── Slide 1: title slide ──────────────────────────────────────────────────
    s1_id = new_id()
    db.execute(
        "INSERT INTO slides (id, slide_order, background, animation_order, transition)"
        " VALUES (?,?,?,?,?)",
        (
            s1_id,
            0,
            json.dumps({"type": "gradient", "angle": 135,
                        "stops": [{"offset": 0, "color": "#1a1a2e"},
                                  {"offset": 1, "color": "#16213e"}]}),
            json.dumps([]),            # no animations
            json.dumps({"type": "dissolve", "duration": 0.4}),
        )
    )

    # Decorative rectangle — bottom strip
    db.execute(
        "INSERT INTO elements (id, slide_id, type, x, y, width, height, angle, fill, z_index)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (f"rect_{new_id()}", s1_id, "rect", 480, 510, 960, 60, 0, "#0f3460", 0)
    )

    # Title text — centered
    db.execute(
        "INSERT INTO elements"
        " (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, z_index)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (f"text_{new_id()}", s1_id, "text",
         480, 240, 800, 80, 0, "#ffffff",
         "My Presentation", 56, "Arial", 1)
    )

    # Subtitle text
    db.execute(
        "INSERT INTO elements"
        " (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, z_index)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (f"text_{new_id()}", s1_id, "text",
         480, 320, 600, 50, 0, "#a0aec0",
         "Created by an AI agent", 28, "Arial", 2)
    )

    # ── Slide 2: content slide ────────────────────────────────────────────────
    s2_id = new_id()

    # Two animation action IDs — we'll reference them in animation_order
    bullet1_id = f"text_{new_id()}"
    bullet2_id = f"text_{new_id()}"

    db.execute(
        "INSERT INTO slides (id, slide_order, background, animation_order)"
        " VALUES (?,?,?,?)",
        (
            s2_id,
            1,
            json.dumps({"type": "solid", "color": "#ffffff"}),
            json.dumps([
                {"elementId": bullet1_id, "category": "buildIn"},
                {"elementId": bullet2_id, "category": "buildIn"},
            ]),
        )
    )

    # Slide heading
    db.execute(
        "INSERT INTO elements"
        " (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily, z_index)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (f"text_{new_id()}", s2_id, "text",
         480, 80, 880, 60, 0, "#1a1a2e",
         "Key Points", 44, "Arial", 0)
    )

    # Bullet 1 — fades in on first advance
    db.execute(
        "INSERT INTO elements"
        " (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily,"
        "  z_index, animations)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (bullet1_id, s2_id, "text",
         480, 220, 780, 50, 0, "#2d3748",
         "• Point one: fabric.js renders elements from z_index order", 24, "Arial",
         1,
         json.dumps({"buildIn": {"type": "fade-in", "duration": 0.4}}))
    )

    # Bullet 2 — fades in on second advance
    db.execute(
        "INSERT INTO elements"
        " (id, slide_id, type, x, y, width, height, angle, fill, text, fontSize, fontFamily,"
        "  z_index, animations)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (bullet2_id, s2_id, "text",
         480, 300, 780, 50, 0, "#2d3748",
         "• Point two: x/y are center coordinates, not top-left", 24, "Arial",
         2,
         json.dumps({"buildIn": {"type": "fade-in", "duration": 0.4}}))
    )

    db.commit()
    db.close()
    print(f"Created {path}")

if __name__ == "__main__":
    create_presentation("example.tb")
```

---

## 10. Checklist for AI-generated files

Use this list to validate a `.tb` file before opening it in twig.

- [ ] **Format identity pragmas set**: `PRAGMA application_id = 0x74776967` and `PRAGMA user_version = 1` (see §11)
- [ ] **Reserved `settings` rows present**: `format_version`, `compat_notes`, `created_with_app_version`, `created_at`, `last_written_with_app_version` (see §11)
- [ ] **All four tables exist**: `slides`, `elements`, `fonts`, `settings`
- [ ] **`slide_order`** is 0-based, sequential, no gaps, no duplicates
- [ ] **All UUIDs are unique** across the entire file (slides, elements, fonts)
- [ ] **Element IDs** follow the `<type>_<uuid>` pattern and the prefix matches `type`
- [ ] **`animation_order`** is present on every slide row — use `'[]'` not NULL or empty string
- [ ] **Every `AnimationStep.elementId`** in `animation_order` refers to an element on that slide
- [ ] **Every `AnimationStep` with `category = "action"`** has an `actionId` that matches an `id` in that element's `animations.actions`
- [ ] **Image elements have `src`** set to a valid base64 data URI
- [ ] **Non-web-safe fonts are embedded** in the `fonts` table — every `fontFamily` not in the web-safe list above must have a matching row in `fonts`
- [ ] **`font.variant`** matches the weight/style pattern `"<weight>-<style>"` (e.g. `"normal-normal"`)
- [ ] **`z_index` values are non-negative integers**; at least 0 on every element
- [ ] **Element coordinates** are within `[0, 959] × [0, 539]` (not required, but out-of-bounds elements will be partially off-canvas)
- [ ] **`PRAGMA foreign_keys = ON`** is set before any inserts if you want SQLite to enforce referential integrity during creation

---

## 11. Format version, provenance, and forward compatibility

Since twig 1.1.0, every `.tb` file carries a small amount of format-identity metadata that lets readers:

1. **Distinguish twig files from other SQLite files** without having to poke at table names.
2. **Detect files written by a newer twig** and refuse to silently misread them.
3. **Display a writer-supplied, human-readable message** to the user when a newer file is opened by an older twig — so the writer can explain what the older reader will get wrong, without the reader needing to know what was added.

### 11.1 Format identity pragmas

| Pragma           | Value                         | Meaning                                                       |
| ---------------- | ----------------------------- | ------------------------------------------------------------- |
| `application_id` | `0x74776967` (ASCII `"twig"`) | Marks the SQLite file as a twig presentation.                 |
| `user_version`   | `1` (current: v1)             | Format revision. Bumped when the schema changes incompatibly. |

Both pragmas must have these values on every write. Writers should set them **before** inserting any rows so that even a partially-written file is identifiable. Implementations may skip the physical PRAGMA write when the existing value is already correct.

### 11.2 Reserved `settings` rows

The same metadata is also mirrored as rows in the `settings` table so tools without PRAGMA access can still read it. Five keys are reserved by the format:

| Key                             | Value                                  | Lifetime                                                |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `format_version`                | decimal integer as string (`"1"`)      | Refreshed on every write.                               |
| `compat_notes`                  | string (plain text or JSON; see §11.4) | Refreshed on every write. Empty string in v1.           |
| `created_with_app_version`      | app version string (`"1.1.0"`)         | Written once via `INSERT OR IGNORE`; never overwritten. |
| `created_at`                    | ISO-8601 UTC timestamp                 | Written once via `INSERT OR IGNORE`; never overwritten. |
| `last_written_with_app_version` | app version string                     | Refreshed on every write.                               |

**Reserved means reserved.** Writers must not store user content under these keys. Readers detecting "is this an untouched blank presentation?" must ignore these five keys and count only other rows.

**Legacy files (written by twig 1.0.x, before format versioning existed):** on first open by a 1.1.0+ twig, the file is upgraded in place, pragmas are stamped, and the five rows are written. For such files `created_with_app_version` records **the twig version that first stamped the file** (not the original creator) and `created_at` records **the upgrade time**. Pre-versioning files carry no provenance to recover — this is the only faithful behaviour.

Opening a file read-write may also refresh missing or outdated metadata rows during initialization, even before the user edits slide content. Readers that only probe or open a too-new file read-only must not perform this refresh.

### 11.3 Probe flow (how readers detect format status)

Readers must not open a possibly-unknown `.tb` file for read-write access without first probing it. The probe uses a short-lived **read-only** SQLite connection so the file's bytes are never mutated on disk:

```
fileAppId       = PRAGMA application_id
fileUserVersion = PRAGMA user_version
tableNames      = SELECT name FROM sqlite_master WHERE type='table'

if fileAppId == 0x74776967:
    # Tagged twig file — dispatch on version.
    if fileUserVersion == CURRENT_FORMAT_VERSION:   → 'current'
    elif fileUserVersion < CURRENT_FORMAT_VERSION:  → 'older'   (schema migrate on open)
    else:                                           → 'tooNew'  (show compat_notes; offer read-only open)
elif fileAppId == 0:
    # Default SQLite app_id — no twig tag.
    if tableNames is empty:                         → 'fresh'
    elif {slides, elements, fonts, settings} ⊆ tableNames:
                                                    → 'legacy'  (pre-1.1.0 twig — upgrade on open)
    else:                                           → 'notTwig'
else:
    → 'notTwig'
```

Readers must refuse to treat `status == 'tooNew'` files as read-write. They may offer the user a **read-only** open that displays the file but disables every mutation path.

### 11.4 `compat_notes` — forward-compatibility messaging

`compat_notes` is the bridge between a newer writer and an older reader. The newer writer knows what it added; the older reader doesn't — so the writer puts a human-readable explanation in this field, and the older reader displays it verbatim.

Two forms are supported:

**Plain string** (simplest):

```
"Uses curved-arrow shapes introduced in twig 1.2. Older twig renders them as straight arrows."
```

**Locale-keyed JSON object** (recommended for published writers):

```json
{
  "en": "Uses curved-arrow shapes introduced in twig 1.2. Older twig renders them as straight arrows.",
  "zh": "使用 twig 1.2 引入的曲线箭头形状。旧版 twig 会渲染为直线箭头。",
  "_default": "Some shapes were introduced in a newer twig."
}
```

Readers resolve a locale-keyed object against the current UI locale using this priority:

1. Exact locale tag (e.g. `zh-CN`)
2. Language prefix of the tag (e.g. `zh-CN` → `zh`)
3. `_default`
4. `en`
5. Any remaining string value

Malformed JSON or a non-object JSON payload is treated as a plain string (the reader must not throw). An empty string means the writer has nothing to say.

Writers:

- v1 twig writes `""` (empty) — there is nothing older to warn.
- A future writer that introduces an incompatible element type, field, or rendering behaviour writes a short, user-facing sentence describing what will be lost or misrendered.
- Each writer refreshes `compat_notes` on every write — the message always reflects what the **current writer version** wants older readers to know, not history.

Readers must not attempt to interpret, translate, or abbreviate the text. Display it verbatim (after locale resolution).

### 11.5 Stamping ordering and atomicity

Writers should apply format metadata **before** any platform-specific shadow or backup copy is made. In twig's own implementation, `stampFileMetadata` runs on the read-write database handle immediately before the Mac App Store sandbox-shadow sync; reversing the order would let the shadow copy receive unstamped bytes.

The stamp operation itself is idempotent: running it twice in a row produces the same rows and pragma values (modulo `last_written_with_app_version`, which may be refreshed to the same or a newer app version). Implementations should avoid rewriting same-value pragmas and settings rows on hot save paths.

---

## 12. Format changelog

### v1 — 2026-04-24 (shipped in twig 1.1.0)

First versioned revision.

- Added `PRAGMA application_id = 0x74776967` and `PRAGMA user_version = 1` as format identity.
- Added five reserved `settings` rows: `format_version`, `compat_notes`, `created_with_app_version`, `created_at`, `last_written_with_app_version`.
- Added `compat_notes` writer contract (plain string or locale-keyed JSON object; see §11.4).
- `elements` schema of record includes `shape_params`, `fontWeight`, `fontStyle`, `underline` (previously added silently during the 1.1.0 dev cycle).
- Legacy 1.0.x files are upgraded in place on first open: missing columns added, pragmas stamped, reserved rows written. `created_with_app_version` records the upgrading twig version and `created_at` records the upgrade time.
