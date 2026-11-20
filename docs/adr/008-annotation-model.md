# ADR-008 — Annotation model

> Condensed English version of ADR-008. The full record, in Spanish, is in the private repository.

**Status:** accepted. Scope: the annotation model and engine (`@codetta/annotations`); the reader UI (palette, layers panel) is a separate task.

## Context

Annotating is, together with turning pages, what musicians do most. The first release needs pen, highlighter, eraser, text, stamps, layers and undo, and the mobile app and the web must read and draw exactly the same thing. Two product rules weigh most: annotations use normalized 0–1 page coordinates, one row per element, never flattened except on export; and the live stroke must never block the JS thread (page turns stay under 50 ms).

Starting data: the sync spike (ADR-003) measured about 4.3 KB on device per 50-point stroke stored as a JSON array of decimals, and the Skia spike drew the live stroke in UI-thread worklets. The package is pure TypeScript, with no React and no Node APIs (ESLint forbids them in `src/`). The parts that run on the UI thread are worklets, and a test checks that every one of those functions is.

## Decisions

### 1. Page frame and coordinate spaces

**The frame** every annotation is normalized to is the page as a PDF viewer shows it: the CropBox clipped to the MediaBox (PDF 32000-1 §14.11.2), or the MediaBox if there is no CropBox, with the page's own `/Rotate` applied (`pageFrame`). Like pdf.js, broken boxes do not prevent annotating a page every renderer shows: an empty, non-finite or non-intersecting CropBox falls back to the MediaBox, and a broken MediaBox to US Letter (612 × 792 pt). The frame is taken **before** the user's crop and rotation (page settings). Those are view transforms: changing them never moves an annotation, and the user crop (`{x, y, w, h}`, 0–1) is defined in this same frame. **Everything that draws a page must use this frame:** PDFKit, `PdfRenderer`, pdf.js and the annotated PDF export (`normalizedToPdf` gives the matrix to PDF user space; ADR-014). iOS currently uses the MediaBox (see Risks).

| Space | What it is | Used for |
|---|---|---|
| Normalized | `x`, `y` in 0–1 of the frame's width and height, `y` down | What is stored |
| Width units | `(x, y · aspect)`, `aspect = height / width`; 1 is the frame width | Widths, font sizes, distances: equal horizontally and vertically |
| Outline units | Width units × 1000 (`OUTLINE_SCALE`) | Stroke outlines: the algorithm's absolute thresholds (§4) were designed for pixels; one unit is about 0.6 pt on an A4 page |

**View** (`viewTransform`, `src/geometry/view.ts`): frame in width units, then user crop, user rotation, fit (`contain` or `width`), zoom and pan. It returns `matrix` (normalized → screen) and its inverse for touches; `widthMatrix` and `outlineMatrix`, so shapes and cached outlines draw with a single Skia matrix and zoom never recomputes an outline; and `scale`, to turn a pixel radius into width units.

### 2. Format of `annotations.data`

**Common header:** every payload carries `v` (format version, currently 1) and an optional `anchor`. **Evolution rules:**
- a **new optional field** keeps `v`: objects are open (`z.looseObject`), so an older version reads the row and preserves the field when it rewrites `data` (`encodeAnnotationData`);
- anything an older version could not draw, or would draw wrongly, **bumps `v`**: a new `kind`, ink, glyph, `input` or other enum value, or a change of meaning. Hence a `v: 1` row with an unknown `kind` is `invalid`, not `unsupported`.

`parseAnnotationRow` never throws and returns one of three states: `ok`; `unsupported` (a `type` not drawn yet such as `link`, `button`, `marker`, a higher `v`, or an unknown `anchor`: the row is kept, not drawn, deleted or rewritten); `invalid` (logged and skipped; the rest of the page still draws). It reads rows from SQLite (0/1 booleans, JSON as text) as well as from Postgres or the data export.

| `type` | Data |
|---|---|
| `stroke` (pen) | pen `ink`, `width`, `input` (`pen` \| `touch` \| `mouse`), `points`, `taperStart?`, `taperEnd?` |
| `highlight` | Same, with a highlighter `ink`. Its own type, not a `stroke` with a `tool`: painted in its own pass, under the ink |
| `text` | `text` (1–2000 characters, not blank), `x`, `y` (top-left), `fontSize`, `ink`, `maxWidth?` |
| `stamp` | `x`, `y` (centre), `scale`, `ink`, and either `{ kind: 'smufl', glyph }` with the SMuFL **name**, or `{ kind: 'symbol', symbol: 'glasses' }` |
| `shape` | One of four kinds (§2.4), each with `ink` and `width` |

The types are exactly those of the existing database CHECK constraint. `width`, `fontSize`, `opening` and `maxWidth` are in width units, so they keep their look on any page shape. `taperStart` / `taperEnd` say whether each end is original (default) or a cut made by the future partial eraser (§5): a cut end is not tapered and gets a flat cap. No preset tapers today, so they only pick a round or flat cap; they are stored now so the format does not change later.

#### 2.1 Inks: a key, not a hex colour

The **ink key** is stored, so the Paper and Night appearances can remap every ink and a palette change also reaches existing annotations. **Pen:** the four `annotationInks` of the design tokens (red, blue, green, graphite). **Highlighter:** four `highlighterInks` (yellow, green, pink, blue), drawn at `highlighterOpacity` 0.4. Design-token tests require music under the highlighter to stay at 7:1 contrast against the paper and the highlight to be distinguishable from the paper (1.2:1). Both sets share `green` and `blue`, so the `type` says which set a key belongs to (`penInkColor`, `highlighterInkColor`). **Layer `color`** is also a pen key; any other text reads as "default ink".

#### 2.2 Stamps

The SMuFL name (`dynamicForte`) is the standard's stable identifier and does not depend on the font; the codepoint for Bravura comes from the catalogue (`src/stamps/catalog.ts`). Categories: dynamics, articulation and bowing, fingering, attention (glasses), breath and fermata, accidentals. The 35 codepoints were checked against the standard's `glyphnames.json`, and a test checks that the bundled `Bravura.otf` has them all. **Glasses** do not exist in SMuFL: they are a custom `symbol` whose vector drawing lives in the catalogue (`stampSymbolDrawing`: centre lines in stamp units, the −0.5 to 0.5 box the eraser also tests, with their thickness), so app and web draw the same icon. Accessible labels come from the app's i18n catalogue. Figured-bass stamps will arrive later as another `kind` (`figured`, reserved) with `v: 2`.

#### 2.3 Layers

`LayerRowSchema` validates `name`, `color` (key), `visible`, `locked`, `kind`, `position` and `purpose` (`'analysis'` or null). `name` follows the same rules as the database CHECK (`btrim` only strips spaces and `char_length` counts code points, so a name with an emoji or a line break the database accepts is valid here too). The `purpose` column does not exist yet: it reads as null until its migration (§8), and an unknown value also reads as null.

#### 2.4 Shapes

**`line`** from `from` to `to`; **`slur`**, a quadratic curve from `from` to `to` whose `bulge` is the apex height as a fraction of the chord, positive to the left of `from → to` (above, for a slur drawn left to right) and negative on the other side; **`hairpin`**, two lines from `apex` that open by `opening` at `end` (crescendo or diminuendo is just which side the apex is on); and **`rect`**. A phrase bracket arrives with manual analysis, with `v: 2`. `shapePolylines` gives their centre lines in width units, for drawing and for the eraser.

#### 2.5 Anchoring

Only `{ kind: 'page' }` exists today, which is also what a missing `anchor` means. A reflowing document (ChordPro, MusicXML) will anchor to a line or a bar: each reading engine will implement `AnchorResolver.resolve(anchor, pageIndex)`, returning the page and the rectangle the coordinates are relative to; the PDF engine uses `pageAnchorResolver`, the identity. Nothing more is implemented: `AnchorSchema` only accepts `page`, and any other kind reads as `unsupported`.

### 3. Point encoding

**`Point = [x, y, pressure, t]`.** In memory a stroke is a `Float32Array` with four values per point (`PointBuffer`). **Quantized at capture**, so the live stroke, the stored one and the one on another device are identical: `x` and `y` to 32,767 steps (sub-pixel at 8× zoom on a 2732 px iPad screen), pressure to 255 steps, `t` in whole ms up to 1 h. At most 10,000 points per stroke (about 42 s at 240 Hz); capture then starts a new stroke.

**Format v1** (`encodePoints`, `src/codec/points-codec.ts`), bytes then unpadded base64url: version; flags (bit 0: a single pressure for the whole stroke, the finger and mouse case); point count; the shared pressure, if any; then per point, deltas from the previous one: `x`, `y` and pressure as zigzag varints, `t` as an unsigned varint (it never decreases).

**Measurements** (`pnpm size-report`): 64 synthetic strokes (two seeds), 10,534 points, median 73 points per stroke.

| Encoding | chars/point | median per stroke | p95 per stroke | 50-point stroke |
|---|---|---|---|---|
| JSON, float64 as captured | 77.6 | 5703 | 38456 | 3879 |
| JSON, decimals already on the grid | 30.9 | 2192 | 15419 | 1547 |
| JSON integers with deltas | 11.0 | 728 | 5268 | 551 |
| **Varint + base64url, deltas (v1)** | **5.8** | **446** | **2655** | **292** |
| Varint + base64url, second-order deltas on `x`/`y` | 5.4 | 404 | 2659 | 271 |

**v1 is chosen.** It is about 5× smaller than the decimal JSON of ADR-003 (about 1.6 KB per 50-point stroke) and about 13× smaller than float64 JSON; a 50-point stroke is about 290 characters of points plus about 80 for the rest of `data`. Second-order deltas save only 7 %, not worth a harder-to-validate format. Point simplification (RDP) is left as an option if size ever demands it, because it changes the smoothing. **Validation on read** (`decodePoints`, inside a `z.codec`) rejects: characters outside the alphabet, padding or leftover bits; unknown version or flags; 0 or more than 10,000 points; truncated, overlong or non-canonical varints; coordinates off the page, pressure out of range or `t` over 1 h; trailing bytes; and, before decoding, a string longer than the maximum possible. It never throws, which a test with 2000 random inputs checks. The synthetic strokes are seeded and imitate annotating an A4 page with the Pencil at 240 Hz or a finger at 120 Hz (fingerings, slurs, circles, hairpins, words and an 8 s scribble), with tremor, sampling jitter and a pressure profile. Real captures go in `fixtures/strokes/`, and `size-report` includes them.

### 4. Smoothing: own implementation, incremental, in worklets

**Origin:** the algorithm is perfect-freehand 1.2.3 (MIT; its licence notice is in `src/smoothing/outline.ts`): `streamline` (the line follows the input with a slight lag), radius from real or velocity-simulated pressure, side offsets, caps and corners. It is rewritten for two reasons: **cost** (`getStroke` recomputes the whole stroke on every call, so live cost grows with the square of the length, §7) and **thread** (the live stroke is drawn in a UI-thread worklet, which a library from `node_modules` is not prepared for).

**How it is incremental:** a point's outline only depends on the previous points, the next one and its distance from the end (the 3-unit end noise and the end taper). A point is committed once its successor is stable, the initial pressure is settled (10 points) and every possible future end is that far away. From then on each event only recomputes the tail. **Live drawing:** `takeCommittedChunks` yields new chunks to append to the stroke's `SkPath`, and `tailPolygon` the tail for each frame. With nonzero fill the chunks add up to exactly the same figure, because shared edges run in opposite directions; a test checks the winding number at random points. Highlighter chunks overlap on those edges, so each live highlighter stroke is drawn in its own Skia layer (`saveLayer`) with the opacity applied to the whole layer.

**Stored highlighters: one layer per ink.** In the app, the web test reader and the annotated PDF, a page's highlighters go in one layer per ink used (at most 4). Strokes are opaque inside the layer, and the layer is composited once with its ink's opacity. Layers are ordered by each ink's first appearance, not by `z`: with yellow, pink and another yellow on top, the pink stays above the second yellow. Same-ink crossings never darken, within a stroke or between strokes. This is what musicians expect and what score apps do; what matters is that app, web and PDF look the same. The reference is `highlightGroups` and `paintPage` (`src/paint/paint-page.ts`); the web test reader redraws the page's highlighter canvas on a new stroke (a browser test compares one-ink and two-ink crossings), and the annotated PDF uses one transparency group per ink and page (ADR-014).

**Equivalence (`src/smoothing/outline.test.ts`):** for five option variants, every prefix of a stroke and its special cases (1 and 2 points, repeats, no pressure, corners, end noise), the polygon matches `getStroke` within 1e-9. perfect-freehand is only a devDependency, for that test and for the Node measurement (`pnpm perf-report`, via `src/bench/naive.ts`). It never reaches the app: the bench entry point does not export that module, lint forbids importing perfect-freehand or that module anywhere else in `src/` (including the `src/test` helpers the bench uses) except tests, and a test checks the entry point does not re-export it.

**Presets** (`outlineOptions`):

| Tool | Input | Options |
|---|---|---|
| Pen | Stylus | Device pressure, `thinning` 0.6, `streamline` 0.35, round caps |
| Pen | Finger or mouse | Velocity-simulated pressure, `thinning` 0.35, `streamline` 0.5 |
| Highlighter | Any | Constant width, flat caps (chisel marker) |

**Capture** (`createStrokeCapture`, `addSample`): snaps each sample to the §3 grid, clips to the page, keeps `t` monotonic even if the clock jitters, and drops samples within 0.25 outline units of the previous one (about 0.05 mm), because a still pencil at 240 Hz piles up points that take space and keep the tail from committing. Thanks to quantization the live outline is identical to the one later drawn from the database (`freehandOutline`); a test checks it.

### 5. Eraser: whole strokes in the first release

**The eraser moves as a capsule:** each event tests the segment from the previous to the current position, widened by the eraser radius, so a fast sweep never skips a stroke between two events. Everything is in width units. Each type is tested against its geometry:
- **stroke and highlight:** the input polyline widened by the half-width drawn at maximum pressure, `width / 2 · (1 + |thinning|)` (0.8 × width for the pressure pen), so the visible edge of a hard-pressed stroke also erases. The small `streamline` offset between drawn and input lines falls inside the eraser radius;
- **shapes:** their centre lines; the inside of a rectangle or hairpin does not erase;
- **text and stamps:** their box. The text box is estimated from characters and lines (wrapped lines with `maxWidth`), or from the renderer's `measureText` when available.

Each annotation's box (`hitTarget`, cached with the page) is checked first. `erasableOn(layers)` is the default filter: only live annotations on live, visible, unlocked layers. A whole gesture is one undo step (`group`). **Partial ("by area") erasing comes later.** It will split the stroke into new rows with cut ends (`taperStart`/`taperEnd` false), soft-delete the original and group everything into one undo step. The schema already allows it, so the format does not change.

### 6. Pure undo/redo, one history per score

**Scope:** one history per open score, covering all its pages, unlimited, lost on close. If a step affects another page, `nextUndoPage` says which, so the reader goes there first. **Commands:** `add`, `remove`, `update` (with `before` and `after` values), and `group` (one gesture, one step; undone backwards, redone forwards). Layer visibility, lock and order are view state and stay out of the history. **Mutations return `undo` and `redo`**, applied by the repository in a transaction: `softDelete`; `restore` (`deleted_at` back to null, same id; the row guard trigger allows it and `annotations` has no UNIQUE); `patch`. There is never a DELETE, so sync only sees updates (ADR-003). **Guard:** before each step, `getCurrent` checks that the row exists and is live or deleted as the command left it, and, for an `update`, that the columns it changed still hold the values it wrote. Changes to other columns do not block it, and `record` rejects an `update` whose `before` and `after` have different columns. Inside a group, each command's guard already sees the earlier mutations of the same step (the future partial eraser cuts a stroke and then one of its pieces in the same sweep). If another device or path changed the row, that step is skipped, reported in `skipped` and dropped from the history; for a group the rest is applied and only that part moves to redo.

**In the database, with its own guard** (`applyHistoryStep`, in the app's core package): the step is applied in memory first, against the store's rows, and the UI does not wait. It then goes through the annotation writer's queue, **behind every pending write**, and in one transaction reads the rows the command touches as they are in the database, runs the same pure guard again and applies what passes. Without the queue, drawing and undoing at once would find the stroke not yet saved: the guard would skip it as "changed by another device" and the stroke would reappear. Only the part memory applied reaches the database; anything memory applied but the database skipped is re-read, and memory takes the database version. Memory and database use the same timestamp for `updated_at` and `deleted_at`.

**Deleting a layer** deletes its live annotations with the **same** `deleted_at`, in one transaction, like the setlist soft-delete. Restoring it brings back only the annotations sharing that `deleted_at`; ones deleted earlier stay deleted. In the history it is a `remove` of the layer whose undo is the `restore` with those annotations. The server keeps `deleted_at` as received (the row guard trigger only touches `updated_at`), so the restore finds the same set after syncing. **Visibility:** an annotation shows if it is live **and** its layer is live, which also covers another device drawing offline on a layer deleted here: its stroke arrives live but is not shown. **Deleting a score** does not touch its layers or annotations: it goes to the trash whole and restoring it brings it back complete.

### 7. Performance

`pnpm perf-report` runs V8 with JIT, warmed up: a **lower bound**. Hermes, with no JIT, is several times slower on device and is measured with the app's `dev-perf` screen. The cases and data for both are in `src/bench`. "Live" rows are the distribution of all events while drawing a stroke of that length (each adds a point, takes new chunks and redoes the tail). Page rows come from `preparePage`, with per-phase timings, so the breakdown adds up. Maxima are garbage collector or JIT pauses.

**V8, development PC** (Node 24, idle; median of three runs):

| Operation | p50 | p95 | max |
|---|---|---|---|
| Live event, incremental, stroke of 1000 / 4000 / 10,000 points | 0.010 / 0.007 / 0.004 ms | 0.025 / 0.013 / 0.008 ms | 0.49 / 0.50 / 0.56 ms |
| Live event recomputing with perfect-freehand, 4000 points | 0.53 ms | 1.1 ms | 4.2 ms |
| Finished outline, 2000 points | 0.91 ms | 1.5 ms | 1.8 ms |
| Finished outline, 10,000 points | 5.4 ms | 8.8 ms | 10 ms |
| Decode 2000 points (15,200 characters) | 0.51 ms | 0.83 ms | 1.5 ms |
| Decode 10,000 points | 2.3 ms | 4.1 ms | 4.8 ms |
| Page of 300 strokes × 100 points, cold, all (`preparePage`) | 50 ms | 58 ms | 59 ms |
| … reading rows (JSON, Zod, decoding) / outlines / eraser boxes | 12 / 37 / 1.7 ms | 13 / 43 / 2.7 ms | 18 / 44 / 3.2 ms |
| One eraser move, 500 strokes on the page | 0.037 ms | 0.093 ms | 0.24 ms |

**Hermes, Android emulator** (release build, Hermes without JIT, x86_64 Pixel Tablet emulator on the development PC, cold start; median of three rounds). **These are emulator figures on a PC, not from an ARM tablet or the iPad:** they compare against V8 on the same CPU and show orders of magnitude. Medians vary under 15 % between rounds; maxima are single samples. The perfect-freehand row was measured once; that case later left the bench entry point so perfect-freehand never reaches the app (§4), and only `perf-report` measures it now.

| Operation | JS p50 | JS p95 | JS max | UI runtime p50 | UI p95 | Budget |
|---|---|---|---|---|---|---|
| Live event, incremental, 1000 / 4000 / 10,000 points | 0.030 ms (all) | 0.055 / 0.054 / 0.052 ms | 2.8 / 3.1 / 2.3 ms | 0.061 ms (all) | 0.100 / 0.096 / 0.10 ms | ≤ 0.5 ms ✓ |
| Live event recomputing with perfect-freehand, 4000 points | 5.9 ms | 14 ms | 25 ms | — | — | — |
| Finished outline, 2000 points | 6.9 ms | 10 ms | 12 ms | 19 ms | 20 ms | ≤ 2 ms ✗ |
| Finished outline, 10,000 points | 46 ms | 57 ms | 79 ms | 101 ms | 132 ms | — |
| Decode 2000 points | 8.0 ms | 9.4 ms | 13 ms | — | — | ≤ 0.5 ms ✗ |
| Decode 10,000 points | 36 ms | 42 ms | 54 ms | — | — | — |
| Page of 300 strokes, cold (`preparePage`) | 404 ms | 479 ms | 501 ms | — | — | chunked |
| … reading rows / outlines / eraser boxes | 156 / 228 / 18 ms | 176 / 249 / 23 ms | 216 / 280 / 24 ms | — | — | — |
| One eraser move, 500 strokes | 0.40 ms | 0.84 ms | 1.3 ms | — | — | ≤ 1 ms ✓ |

**Page breakdown in Hermes** (JS thread; 300 strokes, 30,000 points). Rows marked (est.) split the measured reading time using V8 proportions measured the same day on the same PC.

| Phase | Hermes | Per stroke | Per point | Hermes / V8 |
|---|---|---|---|---|
| Reading rows | 156 ms | 0.52 ms | 5.2 µs | × 13 |
| … row `JSON.parse` (est.) | ≈ 13 ms | 0.04 ms | 0.4 µs | — |
| … Zod (est.) | ≈ 30 ms | 0.10 ms | 1.0 µs | — |
| … decoding points (est.) | ≈ 113 ms | 0.38 ms | 3.8 µs | — |
| Outlines | 228 ms | 0.76 ms | 7.6 µs | × 6.2 |
| Eraser boxes | 18 ms | 0.06 ms | 0.6 µs | × 10.6 |
| **Total** | **404 ms** | **1.35 ms** | **13.5 µs** | **× 8** |

On the page the outline costs 7.6 µs per point versus 3.5 µs in a 2000-point stroke: each stroke has a fixed cost of about 0.4 ms, which dominates in 100-point strokes. On the UI runtime, outlines take 2.2–2.75× longer than on the JS thread. **Live stroke:** the cost per event does not grow with stroke length. A deterministic test that counts work instead of timing it shows each new point visits at most 24 points in a 4000-point stroke (15 measured), versus 4000 when recomputing; CI catches a regression to quadratic cost without flaky timing tests.

**Device budgets** (checked with the development screen):

| Operation | Budget |
|---|---|
| Live event | ≤ 0.5 ms p95 |
| Outline of 2000 points | ≤ 2 ms (reference only, see below) |
| Decode 2000 points | Originally ≤ 0.5 ms; now per step, inside the chunk (see "Per-point steps") |
| Eraser with 500 strokes on the page | ≤ 1 ms |
| Prepare a 300-stroke page, **cached** | ≤ 30 ms |
| Prepare a page **cold** | No total budget: ≤ 8 ms per chunk (per frame), never during a page turn |

The 2000-point outline is a reference, not a budget: Hermes takes 6.9 ms. It is no longer computed on pen-up, so it only matters when preparing a cold page, which is chunked. A heavily annotated cold page costs 50 ms in V8 and 404 ms in Hermes (emulator), far above 30 ms; lightly annotated pages, the majority, cost proportionally less (about 1.35 ms per 100-point stroke in Hermes). **Decision: cache outlines and never prepare during a page turn.**
- **Cache** by `(id, updated_at)` and page aspect (`PreparedCache`, in memory): a prepared stroke is never validated, decoded or outlined again.
- **Neighbouring pages prepared ahead**, chunked into frames that yield the JS thread.
- **A page turn never waits for preparation.** Jumping to an unprepared, heavily annotated page shows the page at once and its annotations when preparation ends.

Why, from the figures above:
- **Cached**, the 300-stroke page costs **1.15 ms in V8** versus 59 ms uncached in the same run; in Hermes ≈ 10–20 ms (est.), almost all of it the rows' `JSON.parse` (they still carry 238,000 characters of encoded points). Building the Skia `Path` objects is not yet measured.
- **Off the page turn:** at 1.35 ms per stroke, 8 ms chunks (half a frame) fit about 6 strokes, so the extreme page needs ≈ 50 frames, about 0.8 s on the emulator (est.), once per `(id, updated_at)`.
- **Simplifying points on save (§3)** only reduces the per-point part (≈ 220 ms, est.); the per-stroke fixed cost (≈ 125 ms of outline, ≈ 43 ms of JSON and Zod, est.) stays. Halving the points would bring the page to ≈ 290 ms (est., −28 %) and change stored data. Rejected for now.
- **Another worklet runtime:** the UI runtime is 2.2–2.75× slower than the JS thread for outlines. It would free the JS thread but take longer. Rejected.
- **Native code:** V8 on the same CPU outlines 7.6× and decodes 16× faster than Hermes; native code would land near V8 (≈ 40–60 ms, est.), but it means two implementations (Kotlin and Swift, or shared C++) with equivalence tests, for what the cache already solves. Not now.
- **Persistent disk cache:** with the memory cache and prefetched neighbours it would only help the first jump after launch. Not now.

**On pen-up the outline is not recomputed** (19 ms on the UI runtime for 2000 points, more than a frame; 6.9 ms on the JS thread). The live outline is reused: the committed chunks (`takeCommittedChunks`) plus the final tail (`tailPolygon(builder, true)`, via `outlineParts`). Its cost depends on the tail, not the stroke length, and the figure equals the full outline (§4). If a recompute is ever needed (say, a width change), it is chunked or deferred while a page turn is pending, never on the UI thread.

#### Two-phase, chunked reading

Implemented for the reader (ADR-013 §4 and §5):
- **Two phases:** `pageFromCache` builds the page from `id` and `updated_at` alone and reports which rows are missing; `PageJob` (`src/page/page-job.ts`) prepares those rows in chunks (validate, decode, outline, eraser box) into `PreparedCache`.
- **Real chunks, also inside a stroke:** `PointsDecoder` decodes a stroke in parts with the same checks as `decodePoints`; the outline is fed in parts with `addInputPoint`, `POINTS_PER_STEP` (256) points at a time; `PageJob` stops before a step that may not fit in what is left of the budget. Long strokes are split internally instead of "≤ 8 ms or one stroke".
- **Validation:** `parseAnnotationRowDeferred` validates the row with Zod and leaves the encoded points to `PointsDecoder`. Zod stays as is for now: under `node --jitless` (the JIT-less reference measurable in Node), validating 300 rows costs about 10 ms, ≈ 25 ms in Hermes (est.), above the ≤ 10 ms proposed in ADR-013 §10; replacing the id format check by a length check saved nothing measurable, and with the cache each row is validated once per `(id, updated_at)`.
- **Decoder:** one-byte varints (almost all) are read inline and grid values come from tables; base64url is decoded four characters at a time with pre-shifted tables, on demand as points are read. Merely walking the 15,200 characters of a 2000-point stroke with `charCodeAt` already costs 0.85 ms under `--jitless`, so the 0.5 ms decode budget is out of reach without JIT; with chunked decoding it no longer blocks. `--jitless` figures come out at about 40 % of Hermes-on-emulator figures and keep the proportions.

| Operation | jitless before | jitless after | V8 before | V8 after | Budget |
|---|---|---|---|---|---|
| Decode 2000 points | 3.2 ms | 2.1–2.5 ms | 0.33 ms | 0.15–0.17 ms | ≤ 0.5 ms ✗ without JIT |
| Decode 10,000 points | 14 ms | 8.8–11 ms | 1.6 ms | 0.6–0.9 ms | — |
| Read the 300-stroke page's rows | 60 ms | ≈ 47 ms | 7.0 ms | ≈ 4 ms | — |
| Cached 300-stroke page (`pageFromCache` lookup only) | — | 0.15–0.27 ms | — | 0.15–0.26 ms | ≤ 30 ms ✓ |
| Each `PageJob` chunk, that page cold | — | p50 7.5–7.7, p95 7.9–8.0, max 8.3–8.6 ms | — | p50 7.9, max 8.4 ms | ≤ 8 ms: p95 ✓ |
| Each `PageJob` chunk, one 10,000-point stroke | — | p50 7.2–7.3, max 7.9–8.3 ms | — | p50 5.6, max 6.9 ms | ≤ 8 ms: p95 ✓ |

#### Per-point steps and an interpreter-friendly decoder

**Starting point** (Hermes on the Android emulator, release build): each `PageJob` chunk had a p95 of 8.2–8.9 ms on the cold page (max 17–33 ms) and 11–12 ms with a 10,000-point stroke, over the 8 ms budget; decoding 2000 points had a p95 of 11–14 ms; the cold page took about 700 ms. That emulator round was 1.5–2.6× slower than the earlier one on unchanged code, so emulator sessions are not comparable as-is: the bench now has a **calibration row** (below). **Where it was measured:** the app's Hermes version, built from source on a Linux x86_64 cloud machine, with the lockfile's `hermesc -O` and Babel preset, each file transformed separately as Metro does. That CPU is 4–8× faster than the emulator's, so its figures only compare alternatives with each other. **Diagnosis** (bytecode and measurements): in base64url, each character cost a `charCodeAt` call plus a helper call, about 15 calls per point; in the point loop, each imported constant was a cross-module property read in the Metro bundle, five per point (`--jitless` did not show it, because Ignition caches them). Typed-array writes were not the problem (about 10 ns, like reads). Closing a 10,000-point stroke was two whole-stroke passes (polygon and eraser box), and the stop rule (`longestStep × 1.25`) aimed at exactly 8 ms and overshot when the next step was of another kind. Steps where a garbage collection landed lasted up to 2.4 ms (1.6 ms without); a page allocated 33 MB, half of it feeding the outline.

**Decision: the decode budget changes from "≤ 0.5 ms per 2000-point stroke" to "per step, inside the chunk".** Without JIT each point runs about 90 bytecode instructions; the simplest possible loop for 2000 points already costs 0.29 ms on the cloud machine plus 0.26 ms for base64url, about 4–5 ms on the emulator (est.). Decoding already runs in parts inside 8 ms chunks, which is what protects the page turn. The decode row stays as a reference; steps are measured with `page-job-step` and `page-job-step-long`. **Plan B, described but not done:** decoding natively in the app's Expo module, one call per stroke returning the `Float32Array` with the same checks. Only if device figures demand it, given the two implementations and their equivalence tests.

**What changed** (point format v1 unchanged):
- **Base64url:** character codes arrive in one native call (`TextEncoder.encodeInto`, falling back to `charCodeAt`); 256-entry tables read inline; a non-ASCII character yields bytes ≥ 0x80, which the tables reject.
- **Point loop:** imported constants are copied to locals before the loop.
- **Bytecode test** (in the mobile app): compiles both hot loops as the app does and fails, naming the instruction and line, if a property read, call or closure read returns to the loop; lines marked `// cold` are exempt. It also fails if `hermesc` is missing or the dump format changes: it is never skipped.
- **`PageJob` by points:** every step of a stroke is points-based: decoding; feeding the outline together with the eraser box (`addFreehandHitPoints`); and building the polygon (`continueOutlinePolygon`). Closing the stroke (native `concat`, eraser box, cache) is its own step, estimated from the polygon's point count and not started if it does not fit. Each phase learns its cost per point, and each step takes the points that fit in what is left of the chunk, up to `STEP_TARGET_MS` (1 ms), keeping `CHUNK_RESERVE_MS` (1.5 ms) for the clock, a misestimated step and a small collection. Reading a row cannot be split: its cost is estimated from the text length. A NaN clock or budget never stalls the job. `outlinePolygon` stays one-shot for the live stroke and `finishStroke`, and a test checks it equals the chunked build for several part sizes.

**Cloud Hermes, before and after** (relative only; median of three rounds; p50 / p95 / max):

| Operation | Before | After |
|---|---|---|
| Decode 2000 points | 1.0 / 1.7 / 2.0 ms | 0.71 / 0.82 / 1.9 ms |
| Decode 10,000 points | 4.4 / 4.6 / 7.6 ms | 3.0 / 3.2 / 4.0 ms |
| Cold 300-stroke page (`preparePage`) | 86 / 93 / 118 ms | 80 / 94 / 118 ms |
| … eraser boxes | 3.2 / 4.1 / 4.2 ms | 1.9 / 2.6 / 2.8 ms |
| Each `PageJob` step, 300-stroke page | — | 0.042 / 0.17 / 0.63 ms |
| Each `PageJob` step, 10,000-point stroke | — | 0.20 / 0.81 / 1.4 ms |
| Calibration | — | 0.85 / 1.1 / 1.3 ms |

To approximate a slower machine, `PageJob` was given a clock multiplied by 6 (it assumes everything slows down equally). Chunk p95 in emulated ms, with chunks over 8 ms: 300-stroke page 7.8–8.0 (3–8 of ~150) → 6.6 (1–3 of ~160); one 10,000-point stroke 7.7–9.9 (3 of ~40) → 6.6–7.2 (1–2 of ~25); 20 × 2000 plus 100 × 100 points 7.8–8.0 (4–8 of ~170) → 6.8–7.3 (3–4 of ~155). The remaining maxima (≈ 9–17 ms emulated) are garbage collections. V8 on the same cloud machine: page chunks 6.5 / 6.7 / 8.1 ms, long-stroke chunks 4.5 / 4.5 / 4.9 ms. **Calibration:** the `calibration` row is a fixed JS loop (arithmetic, typed-array reads, `push`, calls) with no annotation code. `perf-report` prints it in its header, and the bench's Markdown table lists it per column; to compare two sessions, divide each row by that session's calibration. **Proposed, not implemented:** a bench case for `finishStroke` from a live capture carrying the 2 ms budget (the from-scratch outline stays a reference); not building the polygon on the UI runtime in the reader; outline storage with capacity instead of growing `number[]`; and, for the eraser (`eraseHits`), checking the box inline before the `isErasable` filter, then a per-page grid if 500 strokes need it.

#### What the outline allocates, and the garbage collector

**Question:** if emulator collector pauses were 6–14 ms, about 15 per page across about 100 chunks would set the chunk p95 even with perfect steps. Would allocating less shorten or space them out? The single estimate left for the emulator (≈ 6–8× the cloud machine, est.) is 8–10 collections per page, mean pause ≈ 2–3 ms and longest ≈ 8–17 ms, derived from Hermes's mean pause (`js_gcTime`), not from chunk maxima. **Measured on cloud Hermes** (median of five preparations of the 300-stroke page): 32 MB allocated per page; feeding the outline is 16.1 MB, of which 6.6 MB remain (sides 4.3 MB, stable points 1.6 MB, inputs 0.7 MB). The rest is `number[]` growth: Hermes reserves about 21 bytes per number, with `push` or `new Array(n)`. The sides are the outline itself and cannot shrink. 8–10 collections per page, mean pause 0.32–0.42 ms, longest 1.3–2.1 ms (`js_gcTime` only counts time the JS thread is stopped).

**Tried and rejected: `Float64Array` storage in the outline builder** (also sides and polygon). The outline was bit-identical and the heap fell from 32 to 16.5 MB per page, but collections did not drop (9 → 11, because Hermes counts typed-array external memory almost like heap when deciding to collect), the mean pause did not change (0.32 → 0.33 ms) and the page got slower (92 → 118 ms): a helper function per pair costs about 8 times a native `push`; written inline, feeding the outline is still 13 % slower, and building the polygon goes from 10 to 21 ms, because converting back to `number[]` costs about 15 ns per number. It allocates less but does not collect less, and works more. **Done: inputs as fields.** Only the first two and last two input points are ever read; they are now builder fields instead of three numbers per point. The page allocates 6 % less (32.1 → 30.2 MB) and a 10,000-point stroke 14 % less (5.0 → 4.3 MB), at the same time and collection count.

**Bit-identical outline:** `src/smoothing/outline.golden.json` stores fingerprints of every outline from the previous builder, for 1, 2, 100, 2000 and 10,000 points and five option sets (pen, finger, highlighter, no caps, tapered): one-shot, chunked and the whole live sequence (every committed chunk and tail); `pnpm outline-golden` regenerates the report. Hermes and V8 differ in the last bit in 8 of 25 cases because of their trigonometric functions, which does not matter: live and stored outlines are computed on the same engine. **New bench rows** (Hermes only, via `HermesInternal.getInstrumentedStats`): `page-gc-count` (collections while preparing the 300-stroke page in chunks; a count, not ms) and `page-gc-pause` (mean JS-thread pause per young collection). The Markdown table also lists, per budgeted case, how many samples exceeded the budget (`overBudget`). Cloud Hermes: 8–9 collections, 0.35–0.39 ms.

**If the collector turns out to set the chunk p95 on device:** store the cached outline as a `Float32Array` (the only change that removes real bytes, as the polygon is half of what remains; it changes what the reader reads); or raise the reserve to the typical pause, at the cost of shorter chunks. `PageJob` accepts the reserve as an option (`reserveMs`; default `CHUNK_RESERVE_MS`), and the bench has `page-job-chunk-reserve-3` and `page-job-chunk-long-page-reserve-3` (3 ms reserve: chunks end near 5 ms instead of 6.5, and the page needs 17 chunks instead of 14, +21 %). The reader does not pass it yet.

#### Exporting the annotated PDF

Android emulator figures (release build, Hermes, x86_64 Pixel Tablet on a PC), not from an ARM tablet or the iPad; absolute numbers may be inflated by emulator variance, but the two techniques were compared in the same round. Details and decision in ADR-014:
- **Incremental update versus pdf-lib:** about 3 s versus 71 s with 5 annotated pages, and about 13 s versus 81 s with 50; longest JS-thread block ≤ 0.5 s versus 1.3 s.
- **Whole book (342 pages, 50 annotations each):** 71–82 s incremental, of which 20–23 s preparing annotations (`preparePage`, about 60 ms per page); about 2.4 min with pdf-lib, with blocks up to 1.7 s.
- **Memory:** not yet measured per technique (about 850 MB PSS mixing both).

The export prepares each page with `PageJob` in 30–50 ms chunks that do not wait for the frame, not with the page-turn budget: a progress sheet has no page turn to protect, and waiting for frames lengthens the export (ADR-014). `pnpm pdf-report` measures it in Node.

### 8. Database

**The first release needs no migration:** `type`, `data jsonb` and `color text` (≤ 32) already suffice. Left for separate migrations: `annotation_layers.purpose text null check (purpose in ('analysis'))`, with manual analysis; optionally, a CHECK restricting layer `color` to ink keys. **Per-page loading:** a local `(score_id, page_index)` index in the PowerSync client schema, on both tables of each pair (with and without an account); a test checks with `EXPLAIN QUERY PLAN` that the page query uses it. Alongside it, `annotations (layer_id)` for deleting and restoring a layer, and `annotation_layers (score_id, position)`.

### 9. Web test bench (test reader)

The web test reader is this package's test bench in Chrome: pdf.js with the annotation layer on top. It is a development tool that only exists in the dev server. **What it validates:**
- **The frame (§1):** pdf.js only exposes `view` (already the CropBox clipped to the MediaBox) and `rotate`; the reader uses `pageFrame({ mediaBox: view, rotate })`, which gives the same frame, and checks on every page that pdf.js's scale-1 viewport matches. A frames fixture PDF (CropBox ≠ MediaBox, `/Rotate 90` and `180`) and a browser test check with pixels that marks land where `normalizedToPdf` says.
- **The live stroke (§4):** PointerEvents with `getCoalescedEvents()`, stylus pressure and the incremental builder: `takeCommittedChunks` appended to a `Path2D`, `tailPolygon` redone every frame. The live highlighter is painted opaque on its canvas with the opacity on the whole canvas; stored highlighters are grouped per ink on an auxiliary canvas and composited once (§4).
- **The rest of the model:** capsule eraser and `erasableOn` (§5), undo/redo (§6), text, Bravura stamps, shapes and layers.
- **Rows:** stored in IndexedDB exactly as the package defines them, exported and imported as JSON with each page's frame, to compare with the native reader. The format lives in the app's core package, which the mobile app also imports.

**Measurements** (Playwright's headless Chromium in the development container, no GPU, DPR 2; indicative, software rendering):

| Operation | p50 | p95 |
|---|---|---|
| Turning to a pre-rendered page: canvas swap (JS thread) | 0.8 ms | 1.9 ms |
| … until the next frame | 10 ms | 17 ms |
| pdf.js page render (background): engraved / scanned score | 39 ms / 281 ms | 98 ms / 794 ms |
| Live stroke event (all its samples) | 0.02 ms | 0.06 ms |
| Saving a stroke on a 300-stroke page (row, history, draw on top) | 0.95 ms | 1.8 ms |
| Cold prepare of a 300 × 100-point page, from JSON | 35 ms | 52 ms |
| … reading rows / outlines / eraser boxes | 5 / 29 / 0.6 ms | 8 / 42 / 1.4 ms |
| `Path2D` for those 300 outlines | 7 ms | 7 ms |
| Drawing that page on its two canvases, rasterization included | 140 ms | 150 ms |

**Consequences for the reader:** cold preparation of the heavy page matches Node (§7) and also exceeds 30 ms, now the cached-page budget; on the web it runs while prefetching neighbours, one page per `requestIdleCallback`, memoized by `(id, updated_at)`. Drawing is the most expensive part without a GPU: a new stroke on the top layer is drawn over what is there, while erasing, undoing and layer changes redraw the page. `preparePage` and `PreparedCache` live in `src/page/prepare-page.ts` and are exported from the package's root entry point; the web test reader, `perf-report`, the `dev-perf` screen and the mobile reader use them.

## Alternatives

- **perfect-freehand at runtime, splitting the live stroke into segments to cap the quadratic cost.** Simpler, but the live stroke would be computed on the JS thread and seams would show between segments. Rejected.
- **Drawing the live stroke unsmoothed and smoothing on pen-up.** Cheap, but the stroke jumps when it ends. Rejected.
- **Storing the ink hex.** Annotations would ignore palette changes and could not be remapped for the Paper and Night appearances. Rejected.
- **Storing the stamp codepoint.** Depends on the font for optional glyphs and cannot be validated against a catalogue. Rejected.
- **Second-order point deltas.** 7 % smaller (§3); not worth it.
- **One history per page.** Simpler, but undoing an erase on another page after turning would not behave as musicians expect. Rejected.

## Risks and open questions

- **iOS draws the MediaBox (must be fixed before the first release):** the iOS renderer draws and measures with `.mediaBox`, while Android (`PdfRenderer`/PDFium) and pdf.js use the CropBox. With a PDF whose CropBox differs from its MediaBox, the same annotation would be offset between platforms, and the annotated PDF export depends on the same frame. It is fixed in the first iOS change made on a Mac, using the frames fixture (§9).
- **Coalesced Pencil samples:** if Gesture Handler does not deliver `coalescedTouches` (iOS) or `MotionEvent` history (Android) to the gesture worklets, the 60 Hz iPad Air would get about 60 samples per second instead of 240. To be checked in the Skia spike on a Mac; the model works the same either way.
- **Hermes on real devices:** all §7 rows on the Android tablet and the iPad are still missing (they are the figures that count), including the per-chunk p95 ≤ 8 ms and per-step p95 ≤ 3 ms targets, whether `STEP_TARGET_MS` and `CHUNK_RESERVE_MS` hold there, the cached page and building Skia `Path` objects for a prepared page (today estimated or unmeasured), and export memory for the incremental technique alone. The decode and Zod budgets are decided with those figures. Phase one's short query (only `id` and `updated_at` from SQLite) belongs to the reader.
- **Real captures:** measurements are synthetic today; the development screen will record real strokes in the `fixtures/strokes/` format.
- **Ink mapping for Paper and Night:** still pending in the design tokens.
- **SMuFL stamp and text sizes:** resolved; `STAMP_EM_PER_BOX` (2.5 stamp boxes per em, glyph ink box centred on the point) and `TEXT_LINE_HEIGHT` (1.3, with Inter) live in `src/geometry/text-and-stamps.ts`, used by the web test reader and the eraser (stamps erase by their box, `STAMP_BASE_SIZE`); the mobile reader adopts them next.
- **Licence notices:** the app must show third-party licences, including perfect-freehand (MIT) for the derived code.

## Consequences

The app and the web draw with the same package, and what is stored is validated on the way in and out. The format supports future partial erasing as is; manual analysis arrives with `v: 2`, which older versions preserve without drawing. The app's core package can validate its repository rows with this package (the dependency goes from core to annotations, never the reverse).
