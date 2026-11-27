# ADR-013 — The app's score reader: Study, annotation and Stage modes

> Condensed English version of ADR-013. The full record, in Spanish, is in the private repository.

**Status:** accepted (November 2026). Budgets marked as proposals are confirmed or revised when measured on the iPad Air and on real Android hardware.

## Context

The reader is the largest part of the 1.0 and the one that touches the most product rules: turning a page in under 50 ms, a Stage mode with no animations, popups or accidental gestures, and annotations stored in normalized page coordinates with one row per element. It builds on:

- **The PDF renderer spike:** a native renderer module, the page shown as a native view (`ScorePageView`), Skia only for annotation, a prefetch window with a byte-sized cache, and a native module for keyboard and pedal events.
- **The import pipeline decision:** the process-wide lock of Android's `PdfRenderer` must be handled before the 1.0.
- **ADR-008:** the annotation model and its §7, measured in Hermes: outline cache keyed by `(id, updated_at)`, pages prepared ahead of time in chunks of at most 8 ms and never during a turn, and the final outline reused from the live one when the pen lifts.
- **The setlist logic:** `nextPlayable`, `previousPlayable` and `setlistProblems` for Stage mode and the "Before the concert" check.
- **The library search:** its index is built frame by frame and deferred while the reader is open.
- **A web test reader**, which had already solved spreads, keyboard input, history, a row store, drag shapes and stamp and text metrics, in platform-free TypeScript.

Reviewing the code for this plan surfaced four constraints: `ScorePageView` showed **one page per view** (two React views for two pages or a half turn can tear, and moving to the next piece would need a React render); there were no annotation or layer repositories, nor the local `(score_id, page_index)` index that ADR-008 §8 asked for; the "page where you left off" had no column; and Gesture Handler exposes neither contact size nor `FLAG_CANCELED`, and system edge gestures cannot be blocked from JS.

**What is public.** The reader app itself (its screens, native modules and the app's core package) is not published. The parts that live in the public `@codetta/annotations` package are:

| Piece | Path in the package |
|---|---|
| `PageJob` and `pageFromCache` (chunked page preparation) | `src/page/page-job.ts` |
| `preparePage`, `PreparedCache`, `preparedFinishedStroke` | `src/page/prepare-page.ts` |
| `FinishedStrokeJob` (a stroke's cache entry, by parts, from its live outline) | `src/page/finished-stroke-job.ts` |
| `PointsDecoder` (resumable points decoder) | `src/codec/points-codec.ts` |
| `createOutlineBuilder`, `addInputPoint`, `tailPolygon`, `packOutlineParts` | `src/smoothing/outline.ts` |
| `finishStroke`, `finishStrokeParts` (worklets, final outline from the live one) | `src/smoothing/stroke.ts` |
| `paintPage`, `highlightGroups` | `src/paint/paint-page.ts` |
| `shapeFromDrag`, stamp and text metrics, `viewTransform`, `pageFrame` | `src/geometry/` |
| `parseAnnotationRowDeferred` | `src/schema/rows.ts` |
| SMuFL stamp outlines (from Bravura) | `src/stamps/generated/` |
| Synthetic benchmarks (`@codetta/annotations/bench`) | `src/bench/` |

## Decisions

### 1. Scope of the 1.0

**Study mode.**
- **Views:** portrait shows one page and the half turn; landscape shows two pages if the window is at least 1300 pt/dp wide, otherwise one page with the half turn. The half turn also works with two pages.
- **Window size:** the view recomposes on rotation **and** on window resizing (Split View, Stage Manager, Android multi-window), since iPadOS is moving towards requiring it and Android 16 ignores orientation and resize locks on large screens.
- **Bars:** hidden by default, drawn over the page without recomposing it or rendering the reader (they live in their own store). Top: back, title and composer, the view controls, the metronome entry behind a feature flag, and later layers, annotate, page look and Stage. Bottom: "Page 4 of 19", an accessible page slider and "Next in setlist".
- **When bars show:** a centre tap (or the accessible action "Show bars") toggles them; **any page turn hides them**, because they cover the first and last staff lines and an accidental centre tap must not leave a musician playing with covered music; the slider and view changes leave them as they are; with VoiceOver or TalkBack they are always visible. The system status bar hides with them.
- **View controls** are two independent controls: a "1 · 2" segmented control (only where the window offers both) and a separate half-turn switch. Underneath they are the same four views, remembered per orientation. The page slider moves only its label while dragging and jumps on release; for screen readers it is adjustable, one step per page turn.
- **Reader state is pure** (in the app's core package): the position is a page, not an index, so rotating, resizing, changing the view or receiving real page sizes recomposes and returns to the same page. A turn only moves between existing positions; recomposition never happens inside a turn. A page whose size is still unknown takes the size of the first page, not an A4, so the render window is right for Letter or scanned scores. The screen keeps that state in a ref: a turn renders no React.
- **Accessibility:** the page is an adjustable element whose label is the page ("Page 4 of 19"); swiping up or down turns the page, and every turn is announced. A two-finger pinch never turns a page; iOS has no back-swipe in the reader, since an edge swipe turns the page; keys only count while the reader has focus.
- **Open errors** (score gone or in the trash, not a PDF, PDF not on this device, cannot open) each get their own message and a way back to the library.
- **Known gap:** when Android recreates the activity (density or font scale change) the reader closes and the app returns to the library; the remembered page (§6) reopens it where it was. The app only navigates with the router from its own tree, because the global router disconnects when the old root unmounts after recreation.

**Moved to 1.1**, in priority order: pinch zoom (design from the spike kept), continuous scrolling, thumbnails with bookmarks, and the movement selector.

**Annotation:** pen with pressure, highlighter, whole-stroke eraser, text and stamps; shapes are attempted and are the first to be cut. Layers: list, visibility, active layer, new and rename (colour and locking in 1.1). Undo and redo use the per-score history of ADR-008 §6. Palette: four inks and three favourite pens, fixed in 1.0.

**Also in scope:** Stage mode and "Before the concert" (§7 and §3); the next setlist piece already rendered and its annotations prepared before the current piece ends (§4); only a placeholder for the metronome, behind a flag; page look only if time allows (§9).

### 2. The page: a native spread view

`ScorePageView` now composes a **spread**: one or more page pieces, from one or two documents, in the same frame.

- **Imperative command** `showLayout(documents, layout)`, outside React rendering. Each slot has its document, page, a normalized `source` rect on the page, a `target` rect in the view, and the pixel size of the whole page at that scale, which is its cache key. One page is one slot; two pages, two slots side by side; the half turn, the top half of the next page and the bottom half of the current one, separated by an accent line drawn natively; the next piece, a slot from another document.
- **Same frame:** Android draws the hardware `Bitmap`s in a single `onDraw`; iOS swaps sublayer `contents` inside a `CATransaction` without animations. If a page is missing, the view keeps the previous spread and shows the new one whole once all its pages are ready: **never half a spread**. Each slot receives its own bitmap (or `CVPixelBuffer`), taken at render time, so a tight cache cannot evict it before presentation. Replaced bitmaps are recycled two frames later, without waiting for the GC.
- **`showLayout` resolves once** with `{ presented, cached }`, when drawn, or with `presented: false` if another spread replaces it first. A replaced spread stops requesting its pages, so a burst of cold turns never renders them before the visible spread's window. The turn never awaits the promise.
- **`onPageShown`** reports the drawn frame **only while measuring** (the developer HUD, or a "measure page turns" switch in the Diagnostics screen). With measuring off, the view emits nothing and the turn does no extra work.
- **`RenderBudget`** splits the module's cache budget between open documents, so the next piece's document does not double memory. If the shares add up to more than the total, all shrink proportionally.
- **`windowIdle`** fires once per window, carrying its window number, when the render thread has nothing pending: a late notice from an old window cannot mark the new one complete.
- **Page sizes on demand:** only the first page at open; requested sizes first, the rest on the render thread, emitted in batches of 32. The next piece reads nothing until its window is requested.

Measured on the Android emulator (API 29 and 35, development build): key-to-frame latency 20–34 ms with cached pages; memory stable over 200 turns (`TOTAL PSS` 574 to 588 MB on API 35, 506 to 516 MB on API 29). The Swift side is written but untested.

The annotation layer stays a Skia canvas on top, using each slot's transform (`viewTransform` of ADR-008 §1, clipped to the `target`). Whether it changes in the same frame as the spread is **to be verified** (§5).

### 3. Input

**Touch turns on lift**, in Study and Stage. In Study a short contact without movement in a zone turns the page, and a swipe turns it only if enabled in the touch-zone settings; in Stage the lift reveals whether the contact was a palm, a second finger or a drag (§7). The turn is measured from the lift, and the HUD also records touch duration.

**Pedals and keyboard act on key down**: there is nothing to disambiguate.
- **Android:** an invisible focusable view receives keys in `dispatchKeyEventPreIme`, so the first key after a touch is not lost. A wrapped `Window.Callback` lets page-turn keys (arrows, Page Up/Down, Enter) turn pages from any focused control except a text field. The wrapper coexists with other wrappers, and the view releases focus on unmount.
- **iOS:** the view is first responder only while the reader is on screen; keys are `UIKeyCommand`s with priority over the system ones (written, untested; key repeat must be checked so a held pedal cannot run through the score).
- **Scope:** listens only while the reader is on screen, so keyboard navigation elsewhere keeps working. The one exception is the library's ⌘K / Ctrl+K to the search box: a separate view that never takes the focus and only takes that letter with the command key, through the same window wrapper on Android and as a key command on iOS. Tab walks the reader's controls (with a visible focus outline); a tap on the page gives keys back to it. Space and Enter activate a control only if it has keyboard focus, otherwise they turn the page (some pedals send Enter).
- **Keys:** page turns, undo and redo with modifiers, and Esc (closes a panel, then leaves annotating, then goes back). **In Stage only page-turn keys count:** Esc does nothing, undo does not exist and Tab cannot leave the page. A held key never repeats a turn in any mode.
- **Keys reach JS through the module's event, not the view's.** On Android, Fabric hands a view event to JS only at the next vsync, so a turn left one frame late (warm p95 of 34–35 ms to the start of the frame, against 21–23 ms in the spike, which used the module's event). React Native 0.88 has no stable way to dispatch a view event without that wait: the `Discrete` category only reorders events after the beat, and synchronous dispatch is internal and blocks the UI thread. So the key view emits the module's event with its target id, and each reader takes only its own. The old path stays behind a development switch, for an A/B in the same build. **Measured on the emulator:** the warm p50 drops by 14–15 ms, and the wait from native dispatch to the JS handler goes from 8–13 ms to 0.4–0.9 ms. The p95 tail is still there: some keys find the JS thread busy. **Measured:** the tail is Hermes's collections within the turn (dispatch to handler p95 60–75 ms with one, 1–9 ms with none); it goes to the annotation layer's follow-up work, not to the key path. No preparation chunk fell in a key's wait at one key every 600 ms: preparation pauses during a turn and resumes a frame after the spread is drawn, so its chunks run right after the turn and end long before the next key.
- **The key view is never a Tab stop:** it takes the focus itself, but the keyboard's focus search skips it, so Tab goes from the last control back to the first. The title of the top bar is a heading for screen readers but not a keyboard stop either (on Android, `screenReaderFocusable` instead of `accessible`). For TalkBack it is a single stop, «title, composer, heading»: the label is on the group and the two texts are hidden. When the bars show for a screen reader, its focus moves to that heading, instead of landing on the page slider.
- **Tab out of the app's lists (Android, to be confirmed on a device):** React Native 0.88's own focus search in scroll views (`enableCustomFocusSearchOnClippedElementsAndroid`, on by default) searches again among the scroll view's children whenever the platform's focus finder leaves it, and takes anything below *or to the right* as the next Tab stop. In the library grid, with a short last row, that sent Tab back to the row above forever. The flag is turned off right after React Native loads (it can only be set once, so this replaces the provider `load()` chose, with that one flag off; a config plugin puts the call in the generated `MainApplication`), and the lists walked with the keyboard keep their rows attached, since the platform's focus finder only sees attached views. React Native is not patched: it ships prebuilt, and changing its Kotlin or C++ would mean building it from source. Checked again on every React Native upgrade.

**Pen versus finger:** a pure function of pointer type, mode, "has pen" and the "finger draws" setting returns draw, navigate or ignore. A finger or palm touching while the pen is down is ignored. The first pen touch stores "has pen" on the device; a mouse counts as a finger; an Apple Pencil double tap follows `UIPencilInteraction.preferredTapAction` (default: toggle the eraser).

**Accessibility:** turn zones are gestures, so the page exposes a label and the actions "Next page", "Previous page", "Back to library" and "Show bars". With VoiceOver or TalkBack the system intercepts touches, so these actions are how pages are turned.

### 4. Prefetch and preparation, never during a turn

**Urgency order** (computed in the app's core package from `prefetchOrder`): the visible spread (in the overlapping half turn, the next page before the current one); then ±2 spreads in reading direction; then the first position of the next setlist piece, per `nextPlayable`.

**Rendering (native):** each document has its window. The next piece's document opens with a budget of 1–2 pages, and its window is requested when the current document emits `windowIdle` or, at the latest, when the last page is shown. On switching pieces, the next document becomes current and the previous one closes after the frame of the switch.

**Annotation preparation (JS)** follows the same order with `pageFromCache` and `PageJob` from `@codetta/annotations` (`src/page/page-job.ts`, ADR-008 §7), run by a frame scheduler:
- **Chunks of at most 8 ms:** the scheduler, shared with the library index build, gives each chunk a time budget and yields between chunks. Tasks run by priority and arrival; a new task with the same key replaces the old one.
- **Suspended** while a turn is in flight (from each new spread until its result plus one frame, capped at 1 s) and while the pen is in contact. Pauses carry a reason and end only when all are resumed.
- **Long strokes are split internally** instead of allowing "8 ms or one stroke": the outline with `createOutlineBuilder` and `addInputPoint`, the points with the resumable `PointsDecoder`.
- **The turn never waits:** an unprepared page appears without annotations, which appear when ready.

**When the window changes size** (split screen, rotation, switching between one and two pages), every page's render size changes. Waiting for the new renders left the old spread on screen, misplaced, for seconds with the scanned score. Now:
- **A scaled stand-in:** a page not cached at its size but cached at another is drawn at once from that size (the nearest width), the whole spread, and replaced by the sharp one when its pages arrive. Never half a spread and never animated. The annotation layer switches in the same frame, because the stand-in counts as drawn at once.
- **What is on screen is never evicted:** each page a view holds, at its own size, is pinned under the same lock that hands it out, so after a resize there is always something to stand in. Unpinning evicts nothing on the UI thread.
- **Never the old spread after a resize:** with nothing to stand in, white sheets mark where the pages go until they arrive. A turn at the same size still keeps the previous spread, and opening a score shows the background as before.
- **The render window waits for the size to settle** (150 ms), so the intermediate sizes of the animation are not rendered; the spread itself follows at once.
- **A layout waiting for its pages survives the view being detached** (going Home): dropping it left the old spread on screen.
- **The annotation layer is one frame behind the page on a turn** (measured on the emulator: +1 frame in 36–37 of 40 turns, with keys by either path and with taps). It predates the change of key path; the fix is described in §5 («The layer one frame behind»): the layer and the page in the same frame, or else an empty layer in that frame, never the previous page's annotations.
- **Still to check on the emulator:** a timeline of each resize (what JS sends and what the native view draws, on one clock) shows where a remaining delay or annotation offset comes from.

### 5. Annotations

**Drawing:**
- Each prepared page is recorded as an `SkPicture` per `(page, version of its rows, page look)`. On a turn, a shared value switches which pictures the canvas draws; the canvas is not re-rendered by React.
- Until 21/11/2026 the canvas had 4 fixed groups (the slots of a two-page half turn), each with its clip, slot matrix and picture as shared values; since then one picture of the spread is set on a picture view from JS (below, «The layer one frame behind»).
- **Same frame as the spread: to be verified.** `showLayout` is called from JS while the shared value is read on the UI runtime, and on Android the Skia canvas is a separate surface from the view's `onDraw`. An overlay coordinator handles it: when the render window is complete and the spread is inside it, the layer switches with the page; otherwise the layer hides during the turn and returns when `showLayout` reports `presented`. A replaced spread in a burst never shows its annotations, a spread that fails to draw hides the layer, and failed predictions are counted (the target is 0). The HUD measures the offset between the layer frame and the page frame.
- **To be verified:** that an `SkPicture` recorded on the JS thread can be drawn from a shared value on the UI runtime with Skia 2.14 and Reanimated 4.7. If not, recording moves to the UI runtime, inside the same chunks.
- **Tested on the emulator on 20/11/2026** (a release measurement build):
  - import, all nine pages (guides, strokes, highlighters that do not darken, text, stamps), rotation, split screen and re-importing without reopening the reader were right;
  - bursts and slider jumps had no failed prediction and never showed the new annotations early;
  - turns with annotations had a warm-key p95 of 19.4 ms in portrait, but 48–57 ms with two pages, the tail in the key's delivery to JS;
  - the layer was one frame late (same frame 6, +1 in 92, +2 in 2);
  - preparation chunks went over 8 ms because of the collector (ADR-008 §7);
  - the extreme page (645 annotations) showed at once and its strokes 1.6–2.7 s later, with 88 → 225 MB of memory;
  - and at the end of a two-page score with half turns, «the frame of page 9 goes on below the brass line». A test that walks every position through the layer finds the layout right, so the cause is the drawing (most likely the layer kept the previous position). The fix below no longer goes that way, and the next session tells the layer's guide from the native page's edge.
- **The layer one frame behind (measured on 21/11/2026, fix written the same day, native part pending the device):**
  - **Why**, read in the code of Skia 2.14, Reanimated 4 and Expo (not measured): the shared values reached the UI runtime, Reanimated's mapper applied them at the next frame, and Skia redrew in a plain main-thread message that waits for the pending frame, into a TextureView (the layer is transparent), which reaches the screen one frame after it receives a buffer. The spread arrives through Expo's coroutine, whose asynchronous messages skip the pending frame's barrier, and is drawn in that frame.
  - **The fix:** the layer becomes a single picture view. On each change, one picture of the spread is recorded on the JS thread (one `drawPicture` per slot, with its clip and matrix, four at most) and set on the view directly, **before** the spread is sent, so Skia's redraw is queued first. With an `afterLayer` flag, the Android spread view presents the spread from a plain main-thread message, behind that redraw, so both reach the same frame; a spread sent while another waits waits too. The cost: when a frame was already pending, the page comes one frame later than before. With no annotations on screen before or after, nothing waits.
  - **How it is checked:** the emulator's recording keeps 2–3 frames per second, so a video cannot prove «same frame». A HUD switch draws the same marker (the spread's pages and id) twice in a corner, once in the native view's `onDraw` and once in the layer's picture: any recorded frame says whether they match, and long series catch the turn frames. The HUD rows that compared the layer's frame with the page's go: they timed the UI runtime, not the screen.
  - **Allocation:** the composition keeps its recorder, paints and bounds, and releases each picture as soon as the view holds it; `dev-perf` measures its bytes next to the turn's own, so the fix does not add collections to the turn.
- **The layer ahead of the page (measured on 21/11/2026; pre-drawn views written on 22/11, native part pending the device):** with the fix above, the layer was never late but sometimes early: 19 of 203 key turns a frame early, and up to two spreads early in bursts.
  - **Why:** Skia draws the latest picture JS has set, not the one of the turn that asked for the redraw (the picture changes at once on the JS thread and redraws coalesce); and the layer's TextureView learns of its new frame through an asynchronous message that goes before the pending frame, while the spread waited behind its barrier.
  - **A first probe** drew the layer from the native view as it presented the spread (a worklet run on the UI runtime with Expo's `Worklet.execute`, the picture passed through a worklets synchronizable). It worked, but Skia's drawing inside the turn cost 16 ms p50 and 28 ms p95 on the emulator, the warm-key p95 rose to 70.8 ms, and in 80 of 100 turns the vsync arrived during the drawing, so the layer reached the next frame.
  - **The fix: pre-drawn layer views.** The layer is three Skia views, each holding the picture of one spread: the one on screen and its two neighbours, the reading direction first. A turn sends the token of the view that already holds the new spread; as the native view presents the spread it shows that view and hides the others, in the same message. Visibility belongs to the view tree, so both change in the same frame, and nothing is drawn in the turn. With no view holding the spread (cold, a jump, a change of view, back-to-back bursts) every view is hidden: the spread shows without annotations until its view is drawn, never with another page's.
  - **Drawing** into a hidden view runs the same worklet, in an idle moment of the main thread (nothing due: no key, touch or frame waiting) and never within 250 ms of the last spread, so the next key in a burst never waits behind a draw. Neighbours give their buffers back in the background and on a memory warning (two or three view-sized buffers each, about 31–46 MB on a 4 GB iPad).
  - **How it is checked:** each marker box now carries its id in bars, and a script reads both codes in every frame of a recording and counts the frames where they differ, with their sign. The pre-drawn views are the default on Android since the device session of 22/11/2026, and a HUD switch keeps the previous way as the alternative to compare with.
  - **Measured on the emulator on 22/11/2026** (landscape, release build): no frame with the layer and the page out of step in 200 key turns, 40 taps, 80 burst turns and the half turn; the previous way had 24 out of step in the key series, all one frame early. Warm-key p95 19.1 ms, burst 16.1 ms, warm-tap p95 50.7 ms (0.7 ms over the 50 ms budget, with only 40 samples: to be measured again; the previous way gave 64.1 ms). Memory: 15 MB more (193.9 to 208.6 MB PSS). The accessibility tree is identical with both.
  - **Decision of 23/11/2026 (provisional):** in bursts (under 250 ms between turns), jumps, cold opens and view changes the spread may appear without annotations until its view is drawn (never with another page's). Normal turns are unchanged. This relaxes the budget of at most one frame without annotations only in those cases. It is reopened if (a) a tester notices it, (b) on the iPad the gap after stopping exceeds 500 ms, or (c) in Stage mode a jump during a performance (next piece of the setlist, repeats) leaves the page without annotations. Next step: measure the gap with the HUD in burst, jump and cold cases, then choose between a targeted fix (draw after an isolated jump without waiting for the quiet period, and pre-draw predictable targets, at a memory cost) or bringing the single-drawing approach forward. First result (24/11/2026, emulator, release builds): on a cold open of the reader, with no annotations, the log shows exactly three "EGLConsumer is not attached to an OpenGL ES context" lines in a row (three `SurfaceTexture`s) within about 100 ms, and none in bursts, jumps or view changes; no crashes, and the store and development builds agree. The hypothesis to check is which views those three belong to and whether they coincide with the gap without annotations.
  - **Why not a single drawing now:** rasterising each page's annotations into a native buffer drawn by the spread view in the same pass would be exact by construction on both platforms, but costs one page-sized image per page of the window, and a rasterisation that cannot be chunked off the JS thread. It stays as the basis for zoom, where the layer and the page must move together every frame.
- **Recording** turns `paintPage` operations (`src/paint/paint-page.ts`: fills, shape strokes, SMuFL glyphs, text in Inter at its baseline) into Skia calls in chunks. Each path is built from one SVG string in a single call (one JSI call per vertex would cost more than drawing) and freed at once. Highlighters are one group per ink, painted opaque and composited with their alpha (`highlightGroups`), and a group stays open across chunks. Work is counted as one step plus one per 64 outline vertices.
- Inks are resolved when recording: switching Paper or Night only re-records pictures, never recomputes outlines. The picture of the previous page is kept until the new one exists (no flicker) and released a couple of frames later, since the layer may still be drawing it.

**Reading, in two phases:** first `id`, `updated_at`, `layer_id`, `z` and `deleted_at` of the page's rows through the local `(score_id, page_index)` index; then `data` only for the ids missing from `PreparedCache`, queried in batches of 500 and validated by `PageJob` while preparing. Hidden layers are neither read nor prepared.

**Validation:** Zod stays at the database boundary, unchanged. Validating 300 rows costs about 10 ms in `node --jitless` including the `JSON.parse` of `data` (about 25 ms in Hermes, estimated); replacing `z.uuid()` by a length check saves nothing measurable. What changes is that stroke points are validated while decoding them in chunks (`parseAnnotationRowDeferred` and `PointsDecoder`).

**Faster decoder** (`src/codec/points-codec.ts`): a base64url table in a `Uint8Array` and inline varints writing straight into a `Float32Array`, with no per-point arrays or closures; resumable between chunks; strict validation and the 2,000-random-input test kept. Figures in ADR-008 §7.

**Live stroke and saving:** the live stroke is drawn in UI-thread worklets (ADR-008 §4). **On pen lift**, the final outline is the live one: the committed pieces plus the final tail. The reader's UI runtime computes only that tail and hands the JS thread the quantized points and the outline's parts, packed in one `Float64Array` with native copies (`finishStrokeParts`, `packOutlineParts`): the polygon is not assembled on the UI runtime. JS encodes the row, pushes it to history and writes to the database without waiting; `FinishedStrokeJob` (`src/page/finished-stroke-job.ts`) then assembles the polygon and the eraser box a few points at a time in the frame scheduler, bit for bit the same as `freehandOutline`, and puts the entry in `PreparedCache`, so the page is recorded again without reading or preparing the stroke. Whether this beats assembling the polygon on the UI runtime (`finishStroke`, which `preparedFinishedStroke` pairs with, still used by the web test reader) is confirmed with the Hermes figures; if it does not, the reader goes back to it. **The outline is never recomputed on lift.**

**Persistence** (in the app's core and sync packages):
- Annotation and layer repositories on the PowerSync views, working with and without an account; Zod at the boundary; composite foreign keys checked before writing; a colour that is not an ink is rejected on write.
- An annotation session joins a page-based in-memory store, the editor with its history and a writer. The UI works on the store; the SQLite write follows without blocking. A page stays in memory while history or pending writes refer to it, and a database read never overwrites newer in-memory state.
- **The writer** is a single ordered queue for store writes and undo/redo steps (ADR-008 §6). Pending writes are grouped into one transaction and consecutive updates to a row merge; a layer delete or restore acts as a barrier. An insert is never merged with what follows, so a stroke drawn and erased before being written is stored as both, in order. Failures retry with growing delays (0.25 s, 1 s, 5 s, 15 s, then 30 s repeated), always the head of the queue; rows the repository rejects are dropped and logged. `flush()` runs when the app goes to background and when the score closes. A hard kill right after a stroke can lose at most that stroke.
- **Timestamps** come from the store, each at least 1 ms after the previous one even if the clock has not moved: otherwise erasing a stroke and its layer in the same millisecond would share `deleted_at`, and restoring the layer would bring back the erased stroke. Sync returns them as written, in milliseconds (ADR-003 §3).
- The default layer is created with the first annotation, named in the app's language at that moment.

**Code moved out of the web test reader** so app and web share it: spreads, the editor and the row store go to the app's core package (they depend on UUID v7 and ordering keys, and the dependency runs from core to annotations, never the reverse); drag shapes and stamp and text metrics go to `@codetta/annotations`.

### 6. Device-local settings

Reader preferences live in a **local-only database table** (`device_settings`: key and JSON value), validated with Zod on read. Not in AsyncStorage, which the import pipeline decision keeps out of backups: these settings must survive a restore. Like other local machinery tables (PowerSync `localOnly`, ADR-003), it does not exist in Postgres and is not synced, so it has no RLS or server columns.

Stored: the view per score and orientation, and the **last page**; "has pen" and "finger draws"; touch zones; the global page look and dimmer with a per-score override, and the setlist look in Stage; the "first time" of each setlist in "Before the concert". Each setting has a schema and a default; a value that no longer validates reads as the default, and an invalid one is never written. Per-score keys carry the score id and are removed on sign-out; device ones stay. They are **not** part of the data export: they describe the device, not the user's data. The last page is saved one second after settling on it, or immediately on blur, background or close.

The 1.0 has no account or sync: a synced last page (a new column) arrives with accounts, after 1.0. In the 1.0 the score reopens at its last page.

### 7. Stage mode

**Native contact filter** (Kotlin and Swift): a view that only emits "tap in a zone", "exit notice" (over about 300 ms) and "exit" (1 s hold). Only a small contact without movement counts. Ignored: two or more simultaneous contacts; the palm (`getTouchMajor` on Android, `majorRadius` on iOS; from 20 mm); drags; contacts the system cancels (`FLAG_CANCELED` on Android 13+, `.cancelled` on iOS). Classifying natively avoids gesture conflicts and JS judging every contact. The tap event goes to JS, which calls `showLayout`; if that hop adds a frame, plan B is for the filter to call the spread view directly.

**Accessibility:** with VoiceOver or TalkBack the filter receives nothing, so the view exposes the actions "Next page", "Previous page" and "Exit Stage". **System edges:** on Android, `setSystemGestureExclusionRects` on the sides and an intercepted back button; exclusion covers at most **200 dp of height** per edge, so turn zones are designed around it. On iOS, the deferring-edges and home-indicator overrides belong to the view controller, which an Expo Module view cannot set without a subclass; the native stack's auto-hide may suffice. The home gesture cannot be blocked: "Before the concert" recommends Guided Access (iPad) or app pinning (Android).

**Brightness:** the app never changes system brightness. The screen stays on with `expo-keep-awake`, and "Before the concert" reminds the musician to set brightness.

**Slow taps:** a tap over 300 ms currently does not turn the page, and a page that does not turn is the worst possible failure. The simulated concert includes slow taps of 400–600 ms, and the exit-notice threshold (maybe 500 ms) is decided with those measurements.

**Imports** wait while the reader is open (§8). The rest follows the design: a "Next" card on the last page without transition, a fixed notice when a deleted piece is skipped, a minimal bottom line, the half turn, and no metronome or tuner.

### 8. Mandatory native work

**The `PdfRenderer` lock.** A **reader gate** (`setReaderActive`), tied to screen focus rather than mount: while the reader is open, an import copies and hashes but waits before validating and before drawing the thumbnail. No validation *starts* with the reader open. A **cheap tail check** before opening `PdfRenderer` or PDFKit reads the last 4 KB (then 64 KB, for padding after `%%EOF`), looks for `%%EOF` and `startxref`, and checks that the offset points to a cross-reference table or object:
- **No PDF end:** truncated or garbage; rejected as corrupt in milliseconds (36–78 ms on the emulator). On iOS it is treated as doubtful until PDFKit is checked on a truncated file.
- **Doubtful:** has an end, but the offset is wrong; PDFium rebuilds the table by scanning the whole file. Not rejected, since many repair fine.
- **Sound:** validation is brief, even for a 116 MB scan.

No PDF that imports today may start failing; a reference implementation is tested against every fixture, and the Kotlin port has JVM tests.

**The uncovered case** is a validation already running when the reader opens. Measured on an x86_64 Android emulator (API 35, not ARM): a 115 MB file with a broken cross-reference table validates in **1.6 s** (1.58–1.65 s; copy and hash about 10 s before), so the reader would open up to 1.6 s late. That is not a page-turn stall, and the time grows with file size (about 14 s at the 1 GiB import limit, extrapolated linearly) and on slower ARM tablets. **Decision:** a separate validation process is not built for 1.0; it is a known risk, re-measured on a real device, and reopened for 1.1 if a realistic doubtful file exceeds 3 s. Meanwhile "Before the concert" warns while an import is running, and entering Stage during a doubtful validation shows a fixed notice (no popup).

**`PdfRenderer` finalizers on Android 15.** On the emulator, the app was killed by `FinalizerWatchdogDaemon`: `PdfRenderer$Page.finalize()` timed out after 10 seconds, while the scanned score (0.5–0.7 s per page) was rendered in split screen and in Recents.
- **It is not an unclosed page:** every place that opens a `Page` always closes it (`use {}` or `try/finally`).
- **It is the platform** (the API 35 SDK sources): `Page.finalize()` always calls `doClose()`, which does not check whether the page is already closed and calls `PdfProcessor.releasePage` again. That call takes a static lock shared by every PDF in the process, the same lock `renderPage` holds for the whole render. While the render thread chains renders (one for each size the window passes through), the finalizer thread waits for the lock and the other finalizers queue behind it; after 10 s the watchdog kills the app. Android 10–14 does not close a closed page again.
- **The fix:** between renders, the render thread waits for pending finalizers without holding any lock (`Runtime.getRuntime().runFinalization()`, not `System.runFinalization()`, which also collects for apps targeting SDK 34 or lower), so no finalizer waits for more than one render. And no bursts of renders: a new size for a page drops the queued, unstarted and unawaited older sizes of that page (with a JVM test), so only the last one renders; a render already started finishes and goes to the cache.
- **Tested on the emulator (API 35, local release):**
  - **The diagnosis, confirmed by a thread dump** of the instrumented test's process. The finalizer daemon is blocked in `PdfProcessor.releasePage`, waiting for the lock a render thread holds inside `PdfDocumentProxy.render`. Another render thread waits for the same lock in `ensurePdfDestroyed`: closing a document needs it too.
  - **The fix does not slow the page turn:** the burst p95 went from 83.1 to 32.7 ms.
  - **The scanned score in split screen:** no crash in 8 rounds with the fix, against 1 in 9 without it. Too few rounds, so a long automated series followed: **30 of 30 rounds without a single finalizer timeout or crash**.
  - **The instrumented test passes but does not tell the two apart** on this emulator: it does not reproduce the 10 s (worst wait 668 ms without the fix, 892 ms with it). It catches a gross stall, not a regression.

**minSdk 29:** the zero-copy rendering path needs `Bitmap.wrapHardwareBuffer`; no software path is written for Android 8–9.

**CropBox on iOS:** the page frame is CropBox ∩ MediaBox with the same fallbacks as `pageFrame` (ADR-008 §1), drawn with the crop box and swapping width and height for `/Rotate` 90 or 270. A pixel probe and a test PDF of coloured frame marks check both platforms, and annotations exported from the web reader on that file must line up in the app.

### 9. Page look, if time allows

First Normal, Paper and the dimmer; Night if the iOS test succeeds. All applied when composing the spread, never touching the cache. Android uses a `ColorMatrixColorFilter` on the `onDraw` paint for all four. iOS uses semi-transparent layers for Paper and the dimmer (`(1 − a)·page + a·colour`) and, for Night, a white layer with `compositingFilter = "differenceBlendMode"` between page and annotation, plus a warm layer on top whose alpha is tuned with the design-token contrast test. Apple does not officially support `compositingFilter` on iOS: if it works and page turns measure well, Night ships in 1.0; otherwise it moves to 1.1 with Metal.

### 10. Performance: budgets and where they are measured

Tools: the synthetic `dev-perf` benchmarks (built on `@codetta/annotations/bench`, on the JS thread and the UI runtime); the reader HUD, in measurement builds only, which measures real turns up to the start of the frame (1–2 vsyncs of composition remain) and, with annotations, the layer/page offset (until 21/11/2026; since then a marker drawn by both, §5), preparation chunks, cached page and recording; and the Diagnostics screen, which also ships in the store build.

The HUD splits each source into four rows that never overlap (warm, burst, cold, cold burst) and each turn into stages on one clock: input to native dispatch, dispatch to the JS handler, JS until the spread is sent, to the UI thread, and to the frame. Each turn also records whether the render thread was busy, whether the HUD repainted nearby, and what kept JS busy before the handler. The HUD's switches are the key path A/B, the preparation chunks' reserve (1.5 or 3 ms; ADR-008 §7), the layer marker above and a continuous preparation that keeps chunks running, so keys meet them. Since 21/11/2026 each turn also records how long collections within it stopped the JS thread, whether one was of the old generation, and the bytes the turn's JS allocated: collections within the turn were the tail of the dispatch-to-JS stage (p95 60–75 ms with one, 1–9 ms without), and the turn now leaves for after its frame everything that does not draw it (the label, the bars, the render and annotation windows, the remembered page), once per burst. The real interval of every turn is in its dump, so a series can be checked against the interval it asked for. Only release builds count, and only real-device figures are binding: the emulator is for development.

| What | Where | Budget |
|---|---|---|
| Page turn with annotations, key to frame (warm and burst) | HUD | p95 < 50 ms |
| Turn to the next piece | HUD (`cached: true`) | Same as a turn |
| 300-stroke page **with cache** (query, cache and pictures) | `dev-perf` and HUD | ≤ 30 ms (ADR-008 §7) |
| Cold preparation chunk | HUD and `dev-perf` | p95 ≤ 8 ms, recording the maximum |
| Decode 2,000 points | `dev-perf` and `perf-report` | ≤ 0.5 ms (later replaced by a per-step budget inside the chunk; ADR-008 §7) |
| Live stroke event | `dev-perf` | ≤ 0.5 ms p95 |
| Eraser with 500 strokes | `dev-perf` | ≤ 1 ms |
| Save a 2,000-point stroke (encode, row, history, cache) | `dev-perf` and HUD | **Proposal:** ≤ 2 ms of JS, no dropped UI frame |
| Zod on a 300-row page | `dev-perf` | **Proposal:** ≤ 10 ms, **in doubt** (about 10 ms jitless, about 25 ms in Hermes, estimated) |
| Short query (phase 1) of 300 rows | HUD | **Proposal:** ≤ 5 ms of JS |
| Build Skia paths and record the picture | `dev-perf` and HUD | Within the 8 ms chunks |
| The layer's picture of the spread, on every turn | `dev-perf` | **Proposal:** adds no collections to the turn |
| Memory with two documents and pictures | `dumpsys meminfo` on Android; Xcode on the iPad | Set when measured |

A burst is a turn less than 250 ms after the previous one. Proposals become budgets once measured on a device.

Diagnostics adds no second way to measure a turn (the screen and the switch were written on 24/11/2026 and the native probe after them; none of it is compiled or measured on a device yet; the switch is off at every start, and by design, off, the reader holds no meter and the native view emits nothing): its switch wraps the HUD's turn meter, keeps the last 200 turns in memory only, turns itself off 15 minutes after it was turned on (checked against the clock too, since timers stop in the background) and keeps its statistics until it is turned on again. It also counts input samples per second per pointer, apart from the events that carry them, against the display's refresh rate (the system's nominal rate is the reference, and the one measured from frame intervals only stands in for it), in two boxes drawn in separately, one from what reaches the gesture and one from a native probe, with no gesture over it, that counts what the system gives (Android's historical samples, iOS's coalesced touches) and reports each stroke once it ends, and shares a strictly validated report with no user content: no titles, paths, ids or device name.

### 11. PR review

The three riskiest PRs (annotation and layer repositories, Stage mode, ZIP export) get an extra cloud review on top of the usual automated reviewer and the owner's review.

### 12. The reader's pure logic

It lives in the app's core package, without React or platform APIs, with tests; the reader screen, the native spread view and the Stage contact filter use it.

- **Views:** `{ pagesPerView, halfTurn }`; defaults as in §1 (`TWO_PAGE_MIN_WIDTH` = 1300). A remembered view the window no longer allows is dropped.
- **Positions:** the reader advances through positions (whole spread, a half, or the overlapping half turn), each drawn as page slots (normalized source, destination in pt/dp). With sizes on demand, positions are recomposed when real sizes arrive and the reader returns via `positionOfPage(currentPage(…))`, never during a turn. The next piece only needs `firstPosition`. **Single pages in two-page view** (cover, or an odd last page) are placed at the scale of the surrounding pairs, centred, and count as a pair when choosing the half-turn shape.
- **Two half-turn shapes**, chosen per spread: **overlapping** when the spread already fills the window (top half shows the start of the next spread, bottom half keeps the end of the current one, with the accent line between); **by halves** when showing half a page makes it at least 1.25 times larger (`HALVES_MIN_GAIN`; a portrait page in a landscape window gains 2×). By halves, the end of one page and the start of the next are not seen together; this stays for 1.0, as in other score readers. By halves, the page is scaled to the smaller of the window width and twice its height, so two halves cover it. A width-fitted A4 on a landscape iPad Air is 2.04 window heights (two steps would leave 29 pt unseen); scaled this way it is 1159 of 1180 pt wide, 10 pt of margin per side.
- **Input:** zones by thirds; tap or swipe on lift; pen versus finger; the Stage policy with thresholds as constants (palm from 20 mm, exit notice at 300 ms, exit at 1 s); no key repeat; Alt forms no shortcut; keys belong to an open text field.
- **Prefetch** in the §4 order, with `nextScoreDue` saying when to start on the next piece.
- **Frame scheduler:** priority and arrival order, replacement by key, pauses with reasons, per-chunk durations for the HUD histogram, and `budgetedTask` to adapt any time-budgeted job.

## Alternatives

- **Two `ScorePageView`s for two pages and the half turn.** No module change, but can tear between views, and switching pieces would need a React render. Rejected.
- **Turning on touch down.** Faster, but in Stage it cannot discard a palm or second finger, and in Study it cannot tell a tap from a swipe. Rejected; pedals do act on key down.
- **Classifying Stage contacts in JS with Gesture Handler.** No contact size or `FLAG_CANCELED`. Rejected.
- **Changing system brightness in Stage.** On iOS it changes the system value, which must be restored; rejected as a product decision.
- **Last page in a database column.** Needs a migration, and 1.0 does not sync. Arrives with sync.
- **Reader settings in AsyncStorage.** Simpler, but excluded from backups and lost on restore. Rejected.
- **Chunks of "8 ms or one stroke".** A 10,000-point stroke would take about 80 ms in Hermes. Rejected.
- **Night on iOS straight with Metal.** More work and one extra draw per page; the difference layer is tried first.

## Risks and open questions

- **iOS is written but not yet built or tested;** it is compiled as soon as a Mac is available. If iOS is late, Android ships first.
- **Coalesced samples:** react-native-gesture-handler 3.3.0 shows no use of `coalescedTouches` (iOS) or `getHistoricalX` / `historySize` (Android). If worklets only get one sample per event, a small native input module is needed. It is measured as samples per second reaching the worklet, per pointer type, against display and touch rates: with the Apple Pencil, about 60 per second instead of 240 would show coalesced samples are lost. Active Android pens (S Pen, USI) are measured by testers; a passive stylus arrives as a finger. The emulator's mouse represents neither.
- **The x86_64 emulator may be faster than a mid-to-low-end ARM tablet.** If budgets fail on real Android, the levers are smaller chunks and preparing more pages ahead.
- **Opening the reader during a doubtful validation** (§8): 1.6 s on the emulator with 115 MB; grows with file size and slower CPUs. Building Skia paths and recording pictures has not been measured yet either.
- **Memory on the 4 GB iPad:** page cache (about 100 MB), plus the next piece, plus pictures, plus the library index (about 17 MB).
- **`compositingFilter` on iOS** is unsupported officially: if an iPadOS release breaks it, Night would show uninverted, so the reader must detect it and fall back to Normal.
- **System edges:** Android gesture exclusion covers at most 200 dp per edge, and the home gesture cannot be blocked on either platform.

## Consequences

- The native renderer module changes its interface (`showLayout`, `windowIdle`, `RenderBudget`, the pixel probe, on-demand sizes), so a new development build is needed.
- The key-events module, the score-files module (gate and tail check) and the Stage view add native code; the first three native changes are stacked so a single build tests them.
- minSdk rises to 29, which would also allow variable fonts on mobile (not needed for 1.0).
- The app's core package gains the reader's pure logic and the frame scheduler; `@codetta/annotations` gains the faster decoder, `pageFromCache` and `PageJob`, `paintPage`, and the code moved from the web test reader; the sync package gains the repositories and the local index.
- The web test reader now uses what moved into the packages.
