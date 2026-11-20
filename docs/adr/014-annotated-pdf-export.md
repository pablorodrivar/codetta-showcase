# ADR-014 — Annotated PDF export

> Condensed English version of ADR-014. The full record, in Spanish, is in the private repository.

**Status: accepted (decided 15 Nov 2026): the export uses an incremental update (Option B); pdf-lib (Option A) is discarded.** What is still to be verified no longer decides the technique, only whether the export ships in 1.0 or moves to 1.1. Two of the shipping conditions are already met on the emulator (memory of the incremental update alone, and Acrobat Reader); macOS Preview, PDFKit and a real device are pending. §1–§6 describe Option A and stay as a record; each says what still applies to the incremental update.

**Where the code lives.** This repository contains the annotation engine, `@codetta/annotations`. Its `src/pdf/` holds the pdf-lib export (`annotate-pdf.ts`, Option A) and the page-content operators (`content.ts`, exported as `@codetta/annotations/pdf/content`), which both options use; `src/bench/pdf-export.ts` and `pnpm pdf-report` hold the benchmark. **The incremental update writer (PDF lexer, xref reader, incremental writer, flate) lives in the app's core package, in the private repository;** its measurements are reported here.

## Context

The 1.0 release promises "Export annotated PDF": the score's PDF with the annotations drawn on its pages, to print it or open it in another app. It is the only time annotations are flattened. Exporting the user's data is covered separately by a ZIP of the data; this export can be cut to 1.1 if it does not meet the criteria. Requirements: **offline,** on the device; **the same frame as the renderers** (CropBox ∩ MediaBox with `/Rotate`, ADR-008 §1, through `normalizedToPdf`); **the same drawing as on screen,** with the inks of the Normal appearance because it is printed on white; **the original content untouched;** **no blocked UI,** with progress and cancellation; and **large files:** the reference is a scanned book of 342 pages, about 115 MB.

## Decision: the incremental update

**pdf-lib loses on time in every case.** On Hermes (emulator), the incremental update takes about 3 s against 71 s with 5 annotated pages, and about 13 s against 81 s with 50. With the whole book annotated, 71–82 s against about 2.4 min. Also:
- **It reads 1.8 MB of the book's 121 MB** and only appends what changes; pdf-lib reads and rewrites the whole file.
- **It blocks the JS thread less:** with 5 and 50 pages its longest block stays under 0.5 s, against 1.3 s for pdf-lib; with the whole book pdf-lib reaches 1.7 s. pdf-lib fails criterion 3 (≤ 1 s). The incremental update meets it with 5 and 50 pages, and with the whole book: 931 ms in the first, cold round and about 250 ms in the following ones, with 40 ms chunks.
- **It keeps pdf-lib out of the app** (+754 KB of Hermes bytecode, criterion 4), a library with no release since 2021 (Risks).
- If what is left to verify fails, **the export moves to 1.1**; it does not fall back to pdf-lib.

### Conditions for shipping it in 1.0

They come from the criteria below: "if it meets the criteria and Acrobat, Preview and PDFKit open it correctly", plus criterion 2, "without the system killing the app for memory".

| Condition | Where | Passes if | Result |
|---|---|---|---|
| **Memory of the incremental update alone**, whole book | Emulator, measuring screen of the app with the native memory probe, in a pass separate from the timing pass | Increase over baseline **≤ 150 MB** | **Pass:** 108, 112 and 99 MB |
| **Acrobat Reader**, the four sample files | Emulator round, desktop Acrobat | All four open without warnings, without asking to save on close, with the annotations on screen and in print preview | **Pass:** all four |
| **macOS Preview and PDFKit** | Mac | As Acrobat; Preview may rewrite the file on save, but not on open | Pending (Mac) |
| **Real Android tablet or iPad** | Device, release measuring build | Criteria 1 to 3 with device figures | Pending (Mac) |
| **Criterion 1 with the incremental update** (19-page score fully annotated in ≤ 10 s) | **Not measured:** no benchmark runs it. 50 pages of the book take about 13 s on the emulator, so 19 should stay below, but there is no figure | ≤ 10 s | Pending (remaining export work) |

**Memory threshold: increase ≤ 150 MB over baseline,** measured as PSS on Android and `phys_footprint` on iOS:
- **The iPad Air 4 (4 GB) limit:** jetsam kills a foreground app around 2 GB. That is the published figure for 4 GB devices, unverified on ours; on iOS the probe reports the minimum of `os_proc_available_memory()`.
- **The app already spends its share:** the reader's page cache (about 100 MB on the iPad), the annotation pictures, the library index (about 17 MB) and the runtime. On the emulator the app with the reader open sits at 506–588 MB PSS (ADR-013 §2). With 150 MB more it stays below 750 MB: under 40 % of the limit, with room for system memory pressure and a second app in split view.
- **The incremental update does not grow with the book:** it keeps the objects of the annotated pages, the xref (1 MB) and what it appends (10 MB with the whole book), and prepares one page at a time. In Node the increase is 17–18 MB with `--jitless` and 50–56 MB on V8. 150 MB is three times that, for the Hermes heap, which grows in steps, and native buffers. A larger increase would be retained memory (a bug), not the cost of the technique. **In the benchmark the 121 MB book lives in JS memory.** In the app the PDF stays in native storage and is read through `readRange`. That is why the increase counts, not the peak.

### Hermes figures (emulator)

Release measuring build, Hermes, x86_64 Pixel Tablet emulator on a PC, three repetitions. **These are emulator figures, not those of an ARM tablet or the iPad:** they compare both techniques on the same CPU and give orders of magnitude, like those of ADR-008 §7. The figures that count are the device ones. This round was slower than an earlier one because of the emulator, not the code: code that did not change between rounds took 1.5 to 2.6 times longer (ADR-008 §7). Absolute figures may be inflated by that ratio. **The decision stands:** both techniques were measured in the same round.

| | pdf-lib, 5 p. | pdf-lib, 50 p. | Incremental, 5 p. | Incremental, 50 p. | pdf-lib, 342 p. | Incremental, 342 p. |
|---|---|---|---|---|---|---|
| Total | ≈ 71 s | ≈ 81 s | ≈ 3 s | ≈ 13 s | ≈ 2.4 min | 71–82 s |
| … of which preparing the annotations | — | — | — | — | — | 20–23 s |
| Reads of the original | all (121 MB) | all (121 MB) | 1.8 MB | 1.8 MB | all (121 MB) | ≈ 2 MB (Node) |
| Longest JS-thread block | ≈ 1.3 s | ≈ 1.3 s | ≤ 0.5 s | ≤ 0.5 s | up to 1.7 s | up to 537 ms (second round, all at once) |

- **Against the estimate** (`--jitless` × 2.5, below): the incremental update with the whole book lands where expected (≈ 74 s), and pdf-lib with 5 and 50 pages takes almost twice the estimate (≈ 38–47 s). With the round 1.5–2.6 times slower, that is not enough to say either cost differs from the estimate; it is compared again on the device. **Memory was not measured per technique in this round:** periodic `dumpsys meminfo` gave about 850 MB PSS, but each run held both techniques and the 121 MB book. The measuring screen now samples memory with a native thread that does not wait for the JS thread, and has a case for the incremental update alone.

A second emulator round (three runs per pass, app closed between runs, the first one cold) checked the memory and Acrobat conditions:

| Criterion | Result | Passes if | |
|---|---|---|---|
| Probe vs dumpsys | 407 MB from the probe against 385.5 MB `TOTAL PSS` (5.6 %) | < 10 % | Pass |
| Memory increase, incremental alone, whole book (probe on) | 108 · 112 · 99 MB | ≤ 150 MB | Pass |
| Longest block, 40 ms chunks (probe off) | 931 · 248 · 253 ms | ≤ 1 s | Pass |
| Total, 40 ms chunks (probe off) | 86.8 · 50.1 · 49.3 s | ≤ 3 min | Pass |
| Acrobat Reader, the four sample files | All four: no warnings, annotations shown, no save prompt on close, version ≥ 1.4, annotations in print preview | All four | Pass |

- **Waits between chunks:** 119 · 33 · 32 ms over the whole export with 40 ms chunks, against 48 · 22 · 23 s with 8 ms chunks waiting for the next frame. **All at once:** 86 · 63 · 48 s, with the longest block (up to 537 ms) in drawing and compressing one page. The total drops from the first round (71–82 s) because the benchmark no longer waits a frame per read of the original (below).
- **The first, cold run is the slowest** (87 s and a 931 ms block with 40 ms chunks, against about 50 s and 250 ms afterwards). It meets criterion 3 with little margin, so the remaining export work shortens the draw-and-compress step (chunked compression, below).
- **The probe:** each `Debug.getMemoryInfo` sample took up to about 120 ms with the process near 400 MB; at 250 ms between samples it used about a third of a core. The measuring screen now samples every 500 ms (20 % of the time); the export's peak rises slowly, page by page, so 500 ms does not miss it.
- **With this, the export stays in 1.0** unless Preview, PDFKit or the real device say otherwise.

### Chunking the preparation

The 20–23 s spent preparing the book's annotations are about 60 ms per page on Hermes, back to back, with peaks on the page with the 1,900-point scribble. In the export, each page's annotations are prepared with a `PageJob` in chunks that **yield the thread without waiting for the next frame**. The page-turn budget is not used:
- **8 ms chunks waiting for the frame** (what the reader does) turn 20 s of preparation into about 2,500 chunks with up to 16 ms of wait each: about 20 s more on top of 71–82 s, 30–50 % more (30–45 % in `--jitless`).
- **40 ms chunks (30–50 ms) that yield without waiting** are enough behind a progress sheet: Cancel and the screen reader respond, and criterion 3 is met with margin.

**How to yield without waiting for the frame in React Native** (checked in the RN 0.88.1 source, the one in SDK 58):
- **`setTimeout(0)` waits for the frame on Android:** with the New Architecture, timers go from the C++ `TimerManager` to `JavaTimerManager`, which fires them from `Choreographer.doFrame`. iOS is to be checked on the Mac.
- **`setImmediate` does not yield:** it is a microtask (`immediateShim`), so neither touches nor native calls get through.
- **The runtime scheduler does:** `nativeRuntimeScheduler.unstable_scheduleCallback` (the C++ `RuntimeScheduler` React uses on native) runs the task as soon as the JS thread is free, after queued events, which have higher priority. The measuring screen uses it for the 40 ms chunks, with `setTimeout(0)` as fallback. It is an internal RN API, so the export wraps it in a function with its fallback. **Confirmed on the emulator:** the waits between 40 ms chunks add up to 32–119 ms over the whole export, against 22–48 s with 8 ms chunks at the next frame.

**The first-round incremental figures include benchmark waits:** the benchmark's byte source resolved each read with `setTimeout(0)`, which waits for the frame on Android, while the app's native `readRange` resolves through the runtime's call queue. Part of the ≈ 3 s, ≈ 13 s and 71–82 s is waiting for frames the app will not have. pdf-lib does not read through that source, so the comparison favours pdf-lib and the decision stands. This ADR does not change `PageJob` (tuned for the reader, ADR-008 §7): the export only uses its `run` with its own budget.

**Node measurements** (the incremental update alone, all 342 pages annotated, Node 22.23). The frame wait is simulated with a timer up to the next multiple of 16.7 ms; on the device it is `requestAnimationFrame`.

| | All at once | 8 ms chunks, next frame | 40 ms chunks, no frame wait |
| --- | --- | --- | --- |
| `--jitless`: Total | 34.8 s | **45.2 s (+30 %)** | **33.3 s (−4 %)** |
| `--jitless`: Preparing the annotations (JS thread) | 9.4 s | 9.8 s | 9.3 s |
| `--jitless`: Waits between chunks | 0 | 9.9 s | 7 ms |
| `--jitless`: The PDF (read, draw, write) | 25.4 s | 25.5 s | 24.0 s |
| `--jitless`: Longest JS-thread block | 183 ms | 121 ms | 150 ms |
| `--jitless`: … preparing, longest stretch | 52 ms | 9 ms | 40 ms |
| `--jitless`: … drawing and compressing a page, longest | 129 ms | 102 ms | 103 ms |
| `--jitless`: Memory increase (RSS) | 17 MB | — | — |
| V8: Total | 3.9 s | 3.8 s | 3.9 s |
| V8: Longest JS-thread block | 74 ms | 33 ms | 26 ms |
| V8: Memory increase (RSS) | 56 MB | — | — |

These are the second run, with a corrected benchmark (the first counted a collection and the first memory sample as a block). The first run matched within 10 %, except the cost of waiting for the frame: +44 % (45.8 s against 31.9 s). So the frame wait costs 30–45 %.
- **40 ms chunks cost nothing;** 8 ms chunks at the next frame cost 30–45 % without JIT. On V8 almost every page fits in one chunk and the wait goes unnoticed.
- **The remaining block is drawing and compressing a page:** about 100–130 ms in `--jitless`, ≈ 0.25–0.33 s estimated on Hermes (× 2.5); on the emulator, up to 537 ms all at once and about 250 ms with 40 ms chunks. Chunking only the preparation barely lowers it. Next steps, in order: chunked compression with fflate's streaming `Zlib`, yielding between chunks; if that is not enough, writing the operators in groups of annotations; native compression (§3) only if the figures ask for it. **Memory is measured only in the first column:** Node's RSS does not drop after collection, so later columns inherit earlier memory (hence "—"). The same happens with PSS on the device if Hermes does not expose `gc()`.

## Option A: pdf-lib (§1–§6), discarded

This describes Option A as measured. **Still valid for the incremental update:** the operators of §2 (`pdfPageContent`, `@codetta/annotations/pdf/content`, used without pdf-lib), the compression options of §3 (the incremental update uses fflate at level 1), the error reasons of §5 and the benchmark of §6. pdf-lib and `annotatePdf` stay in this package for the benchmark and the tests; the remaining export work removes the pdf-lib case from the app's measuring screen.

### §1. pdf-lib 1.17.1, in JS, in a separate entry point

`annotatePdf(bytes, annotationsOf, options)` (`src/pdf/`) is exported as `@codetta/annotations/pdf`, **a separate entry point:** the reader and the web import `@codetta/annotations` without pdf-lib or pako, and ESLint forbids importing them outside `src/pdf` and the benchmark. pdf-lib reads **the whole file** and rewrites it with all its objects as they are (it does not save incrementally), with **metadata untouched** (`updateMetadata: false`). **The caller chooses the annotations:** `annotationsOf(pageIndex, frame)` returns each page's annotations, already prepared for the frame's proportions and in drawing order (visible layers, sorted by layer and then by `z`, as in the web reader). Discarded alternatives:

| | Why not |
|---|---|
| Native | iOS could use PDFKit. Android ships nothing that writes a PDF from another: `PdfRenderer` only reads, and PDFium, MuPDF or iText are large binaries or AGPL. Two implementations with two different results. |
| `@cantoo/pdf-lib` 2.x | Maintained fork of pdf-lib, but it pulls in `culori` and `node-html-better-parser` to draw SVG and HTML. Kept as a way out if pdf-lib causes trouble. |
| PDF annotations (`/Annot` with appearance) | They look different in each viewer, some do not print them and they can be moved or deleted. Flattening requires drawing them on the page. |

### §2. One content stream per annotated page

The original content is wrapped in `q`/`Q` (pdf-lib does it when normalising the page), so a page that leaves the graphics state changed does not move the annotations; then a new stream with the annotations is appended. Other pages are not touched. **Coordinates:** everything is written in outline units under one `cm` per page. `outlineToPdf` is the scale to normalised coordinates followed by `normalizedToPdf`, with one decimal (0.06 pt on A4). Each SMuFL stamp adds its own `cm` inside a `q`/`Q`, from font units to outline units. The operators are written by `pdfPageContent`, which is pure: it does not use pdf-lib.

| Type | How it is drawn |
|---|---|
| Pen | The outline from `preparePage`, nonzero fill, as on screen. Simplified with Ramer-Douglas-Peucker at 0.1 units (`SIMPLIFY_TOLERANCE`), the precision it is written with. 53 % of the vertices of the synthetic strokes of ADR-008 remain, so half as much is written and compressed. |
| Highlighter | First, under the ink. An `ExtGState` with `/ca 0.4` and one fill per stroke: a fill does not darken its own overlaps. **Today, one fill per stroke:** two crossing strokes of the same ink darken the crossing, unlike the app and the web, which use one layer per ink (ADR-008 §4). Fixing it is a requirement (What is left). |
| Shapes | The polylines from `shapePolylines`, with their width and round caps and joins. |
| SMuFL stamps | Bravura outlines, generated from `Bravura.otf` into `src/stamps/generated/smufl-outlines.ts` (35 glyphs, 33 KB; `pnpm generate`, checked by a test). The font is not embedded. The ink box is centred on the stamp's point, as in the renderers. |
| Glasses | Their polylines, with the width from `stampSymbolDrawing`. |
| Text | **Standard Helvetica, not embedded,** with WinAnsiEncoding, which fully covers Spanish, English, Dutch and German. A missing character (♩, emoji, other scripts) becomes "?" and is counted (`replacedCharacters`) so the UI can warn. The first line sits at `TEXT_BASELINE`, the top of Inter's em, like `textBaseline = 'top'`; the rest at `TEXT_LINE_HEIGHT`, one paragraph per line, as in the web reader. |

**Text is not identical to the screen:** Helvetica does not have Inter's widths (also with the incremental update, which uses the same operators). Two alternatives, for the remaining export work or 1.1: embed Inter with `@pdf-lib/fontkit` (+940 KB minified, measured with esbuild: too much), or draw text as Inter outlines for a fixed character set, like the stamps (tens of KB, but the text can no longer be selected).

### §3. Compression with pako at level 1, injectable

New streams are compressed (`/FlateDecode`), **by default with pako at level 1,** which already comes with pdf-lib and adds no weight. **Level 6,** pdf-lib's `flateStream` default, takes 2.4 times longer without JIT (210 against 88 ms per heavily annotated page) for 15 % less (41 against 49 KB, measured before outline simplification). `deflate` accepts **any other function,** for example native zlib (`java.util.zip.Deflater` and Apple's `Compression` library); `deflate: null` writes the streams **uncompressed,** and a fully annotated book weighs about 15 MB more.

### §4. Yielding the JS thread

pdf-lib yields every 50 objects when reading and writing (`EXPORT_OBJECTS_PER_TICK`, the default `objectsPerTick`); the export yields after each annotated page. **Progress and cancellation:** `onProgress` reports the start of each phase (read, draw, write) and each annotated page. With an aborted `signal`, the export stops after reading, between pages or before writing, and returns `cancelled`. Reading and writing do not report progress: pdf-lib does not provide it. The benchmark records the phase in which the longest block ends. If less blocking is needed, each page's steps (prepare, draw, compress) are split with the frame scheduler and `PageJob` of ADR-013.

### §5. Files that cannot be exported

`annotatePdf` never throws: it returns `{ ok: false, reason, message }`, with reason **`encrypted`** (pdf-lib does not write encrypted files, not even those with only a permissions password, which import accepts), **`unreadable`** (pdf-lib does not understand it, or the page tree is broken), **`cancelled`** (§4) or **`failed`** (any other failure while drawing or writing: a page with resources pdf-lib rejects, running out of memory for the output, or an error from `annotationsOf`). A page with no MediaBox, or with malformed boxes or `/Rotate`, is not a failure: `framePdfPage` reads them untyped and `pageFrame` falls back to the CropBox, the MediaBox or US Letter, like pdf.js (ADR-008 §1). The UI explains the failure and offers the data ZIP, which does not depend on the PDF.

### §6. The benchmark: a synthetic book

`syntheticBook` (`@codetta/annotations/bench/pdf`) builds in JS a PDF with the structure of the scanned book: per page, a large image (120 KB) and 140 uncompressed grey-noise tiles (1.5 KB); 19 pages for the score and 342 for the book (121 MB, about 49,000 objects, which pdf-lib reads and writes). Each page carries the 50 annotations of `annotatedPageRows`, an extreme case: the 32 synthetic strokes of ADR-008 (one a 1,900-point scribble), 3 highlights, 4 texts, 8 stamps and 3 shapes. It is synthetic so that Node and Hermes export the same bytes without reading device files. It runs with `pnpm pdf-report` and from the measuring screen of the app.

## Option A measurements

Node 22.23. Hermes ≈ 2.5 × `--jitless` (ADR-008 §7). "Drawing" includes yielding after each page. Annotation rows are built before the timer starts (in the app they come from SQLite); the benchmark cycles 16 distinct annotated pages.

V8 (with JIT) and `node --jitless` (no JIT, the reference closest to Hermes):

| | Score, 19 p. | Book, 342 p. | Book, 342 p., uncompressed |
|---|---|---|---|
| V8: Size, input → output | 6.7 → 7.3 MB | 121.4 → 131.3 MB | 121.4 → 146.4 MB |
| V8: Read the PDF (pdf-lib `load`) | 163 ms | 2.2 s | 2.2 s |
| V8: Prepare the annotations | 144 ms | 1.2 s | 1.3 s |
| V8: Draw them (operators and Flate) | 218 ms | 2.4 s | 1.5 s |
| V8: Write the PDF (pdf-lib `save`) | 200 ms | 2.8 s | 2.9 s |
| V8: Total | 726 ms | 8.6 s | 7.8 s |
| V8: Longest JS-thread block | 93 ms, drawing | 70 ms, drawing | 55 ms, drawing |
| V8: Memory, peak (Node RSS) | 149 MB | 633 MB | 707 MB |
| `--jitless`: Read the PDF (pdf-lib `load`) | 436 ms | 8.6 s | 8.1 s |
| `--jitless`: Prepare the annotations | 471 ms | 8.5 s | 8.1 s |
| `--jitless`: Draw them (operators and Flate) | 1.6 s | 27.0 s | 9.8 s |
| `--jitless`: Write the PDF (pdf-lib `save`) | 490 ms | 8.9 s | 10.2 s |
| `--jitless`: Total | 3.0 s | 53.0 s | 36.2 s |
| `--jitless`: Longest JS-thread block | 186 ms, drawing | 506 ms, drawing | 445 ms, drawing |
| **Total on Hermes, ≈ estimate (× 2.5)** | **≈ 7.5 s** | **≈ 2.2 min** | **≈ 1.5 min** |
| **Longest block on Hermes, ≈ estimate** | **≈ 0.5 s** | **≈ 1.3 s** | **≈ 1.1 s** |

What pdf-lib itself costs, reading and writing, is a third: 17.5 s of the book's 53 s in `--jitless`. The rest is preparing the annotations (the same outlines the reader computes) and writing and compressing them; compression is almost two thirds of drawing (27.0 s against 9.8 s uncompressed). **The longest block always ends while drawing a page:** preparing, writing and compressing it run back to back, about 100 ms per page on average in `--jitless`; the maximum, about 500 ms, matches the heaviest page or a GC pause. **With the Hermes estimate it already exceeds 1 s** (criterion 3). The case is extreme: a real score carries far fewer annotations per page.

**Bundle size:** +754 KB of Hermes bytecode (+9.6 %), measured with `npx expo export --platform android`: 7.85 MB without the export and 8.61 MB with it. With esbuild, +474 KB minified: about 436 KB of pdf-lib and 32 KB of Bravura outlines. The benchmark case has its own entry point, `@codetta/annotations/bench/pdf`, so the diagnostics screen shipped in store builds, which imports `@codetta/annotations/bench`, does not include it. **Memory:** Node's RSS includes the garbage from building the book; what counts is the app's PSS on the device.

## Criteria

On the release measuring build, on the emulator and, when available, on the tablet, the export **is good enough** if all four hold:
1. the 19-page score, fully annotated, in ≤ 10 s;
2. the 342-page book, fully annotated, in ≤ 3 min, with progress and without the system killing the app for memory;
3. no JS-thread block longer than 1 s;
4. the bundle size is acceptable (+754 KB of bytecode, +9.6 %).

If any of the first three fails, before cutting, in order: native compression (§3); splitting each page into steps with `PageJob` in 30–50 ms chunks that do not wait for the frame; reusing the annotations already prepared by the reader (`PreparedCache`). If it still falls short, the export is cut to 1.1. The plan was to compare both techniques with Hermes figures (5 and 50 pages) and the readers in the compatibility table, and propose the incremental update if it met the criteria and Acrobat, Preview and PDFKit opened it correctly. With the Hermes figures pdf-lib fails criterion 3 in every case and the incremental update is faster in all of them, so it was chosen early. The reader checks and the memory of criterion 2 became the conditions for shipping in 1.0.

## Option B: incremental update without pdf-lib

`appendAnnotations(source, pages, annotationsOf)` (the app's core package, private repository):
- **The original bytes are not touched:** it returns only what is appended to the end of the file (PDF 32000-1, §7.5.6, incremental update). In the app, native code copies the PDF and appends those bytes; nothing of the book passes through JS.
- **It reads with the core package's PDF reader** (the one that also reads metadata on import), through `readRange`: the xref, following `/Prev` and `/XRefStm`; the page tree, the nodes on the path to each annotated page with their children; and for each page, its Resources (inherited or not), its boxes and `/Rotate`.
- **It writes** the new streams, with the operators of `@codetta/annotations/pdf/content`, compressed with fflate at level 1; two `q` and `Q` streams shared by all pages; Helvetica and one ExtGState per opacity, once; a new version of each annotated page with the same object number, its `/Contents` as an array `[q, original…, Q, annotations]` and its Resources as a direct dictionary with its own (including inherited ones) plus a text font and an alpha ExtGState under the export's own names, renamed if those already exist; and an xref section with `/Prev` pointing to the original's most recent section, with the trailer below.
- **Same xref kind as the original:** if its latest section is an xref stream (PDF 1.5, with object streams), so is the new one, uncompressed; a classic table gets a table. A page that lived in an object stream is rewritten as a normal object: the new section wins.
- **Never throws:** returns `encrypted` (without reading further), `unreadable` (a broken xref: pdf-lib rebuilds some and this reader does not), `cancelled` or `failed`, like `annotatePdf`. With no annotated pages it appends nothing. Progress through `onPage` after each page; `signal` is checked before each. No time limit of its own; the caller cuts it.
- **The new trailer** copies every entry of the previous one except those of its own section (§7.5.6) and changes the second half of `/ID` (§14.4). New objects start after `/Size` and after the highest object in the xref, in case `/Size` is wrong.
- **Edge cases:** a PDF older than 1.4 gets `/Version /1.4` in a new version of its catalog, because the highlighter uses `/ca`; a hybrid file (classic table with `/XRefStm`) gets a classic table whose `/Prev` points to its own, as §7.5.8.4 allows (tested, with the pages only in the `/XRefStm` stream); a page's new version keeps its generation, even when it is not 0 (tested).
- **The page tree, without shortcuts:** to descend a node it reads all its children and counts their pages, because a tree that looks flat can hold an empty node (left by some tools when deleting pages) or a branch (tested). What is read is cached, so each object is read once. Children are read 32 at a time, one native round trip per batch, and each object in a small read: up to the next object's offset in the xref (64 B to 16 KiB), more if it does not fit. In a flat scanned book that is its 342 page objects, about 2 KB each.
- **Classic xref tables and strings:** the 20-byte entries are read in place, without the lexer; in `--jitless`, reading a 49,000-object table went from 0.5 s to a fraction. Tables with entries of another size still go through the lexer (tested). The table is read in one go (up to 32 MiB, about 1.6 million objects); import keeps its 1 MiB cap. When copying a page, strings are read in full (an object is read in a window of up to 256 KiB); the metadata reader still truncates them at 4 KiB.

### Reader compatibility

Checked on a score with a classic table, the same score saved with object and xref streams, a test PDF with CropBox and `/Rotate`, and the scanned book (linearised, xref streams with predictor):

| Reader | Result |
|---|---|
| PDFium (pypdfium2 159; the engine of Chrome and of Android's `PdfRenderer`) | Annotated pages with their frame; other pages unchanged; text extracts |
| pdf.js 6.5 (the web reader; Firefox) | Same: operators and text of the annotated pages |
| Poppler (`pdftoppm`) | Same, in both xref variants |
| pdf-lib 1.17.1 and the core reader | Open the result: tests check it with `PDFDocument.load` and the core reader, and that each new object starts at its offset |
| Acrobat Reader | **Pass:** the four sample files open without warnings, show the annotations, do not ask to save on close, have version 1.4 or later and print the annotations |
| macOS Preview and PDFKit | **Pending,** a shipping condition (Mac) |

Acrobat saves annotations and forms this way, so no surprises are expected; Preview, in contrast, tends to rewrite the whole file. Linearisation ("fast web view") is lost, as with any incremental save. A signed PDF keeps the signature of the previous revision (pdf-lib, rewriting it all, breaks it), except a certification signature that allows no changes: the viewer will flag the update as not allowed.

### Measurements

The same 342-page book (121 MB) of §6, with 5 and 50 annotated pages spread through it, 50 annotations each. The benchmark's byte source yields on every read, like the native `readRange`.

V8 and `node --jitless`:

| | pdf-lib, 5 p. | pdf-lib, 50 p. | Incremental, 5 p. | Incremental, 50 p. | Incremental, 342 p. (all) | Incremental, 50 p., xref stream |
|---|---|---|---|---|---|---|
| V8: Total | 4.9 s | 5.3 s | 201 ms | 569 ms | 3.0 s | 537 ms |
| V8: Preparing the annotations | 48 ms | 215 ms | 19 ms | 169 ms | 1.0 s | 134 ms |
| V8: The PDF (read, draw, write) | 4.8 s | 5.1 s | 183 ms | 399 ms | 2.0 s | 403 ms |
| V8: Reads of the original | all (121.4 MB) | all (121.4 MB) | 354 (1.76 MB) | 399 (1.79 MB) | 691 (2.04 MB) | 69 (0.53 MB) |
| V8: Written | 121.6 MB, whole file | 122.9 MB, whole file | 147 KB appended | 1,472 KB appended | 10,075 KB appended | 1,470 KB appended |
| V8: Longest JS-thread block | 109 ms | 68 ms | 37 ms | 23 ms | 19 ms | 44 ms |
| `--jitless`: Total | 15.0 s | 18.9 s | 848 ms | 4.6 s | 29.4 s | 4.7 s |
| `--jitless`: Preparing the annotations | 108 ms | 1.0 s | 116 ms | 1.0 s | 7.1 s | 1.1 s |
| `--jitless`: The PDF (read, draw, write) | 14.9 s | 17.9 s | 732 ms | 3.6 s | 22.2 s | 3.6 s |
| `--jitless`: Longest JS-thread block | 476 ms | 491 ms | 114 ms | 134 ms | 138 ms | 154 ms |
| **Total on Hermes, ≈ estimate (× 2.5)** | **≈ 38 s** | **≈ 47 s** | **≈ 2.1 s** | **≈ 12 s** | **≈ 74 s** | **≈ 12 s** |
| **Longest block on Hermes, ≈ estimate** | **≈ 1.2 s** | **≈ 1.2 s** | **≈ 0.3 s** | **≈ 0.3 s** | **≈ 0.3 s** | **≈ 0.4 s** |

With the whole book (criterion 2): ≈ 74 s estimated on Hermes against ≈ 2.2 min with pdf-lib; measured on the emulator, 71–82 s against about 2.4 min.
- **Cost grows with annotated pages, plus a fixed part that grows with the book:** the xref and, in a flat tree, the page objects. With 5 pages it reads 1.76 MB in 354 reads: 0.98 MB is the xref table (about 49,000 objects), in one go, and the rest the 342 page objects. With an xref stream the xref is much smaller and the page objects sit together in object streams: 69 reads. It writes 147 KB; pdf-lib always reads and writes the 121 MB.
- **Small reads cost mostly round trips:** in the benchmark each waits a timer turn, almost all the time on V8 with 5 pages. Reading children 32 at a time went from 590 to 201 ms. The cost of each native `readRange` is measured with a real PDF.
- **With 50 pages, what remains is drawing and compressing** (about 80 ms per page in `--jitless`), the same as with pdf-lib. Native compression (§3) would help here too. **No memory peak:** only the annotated pages' objects and what is appended. pdf-lib holds the input, the objects and the output at once.
- **Bundle size:** about 3 KB minified on top of the metadata reader the app already ships, plus the operators (about 35 KB, mostly Bravura outlines), against pdf-lib's +754 KB of bytecode. To be confirmed with `expo export`.

## What is left

The remaining export work starts once the library's action menu exists, since the action lives there. It brings:
- **the native part:** copy the PDF to the cache and append the bytes (with `Uint8Array`, no base64), share it with `expo-sharing`, and read the original through `readRange` as a `PdfByteSource`, which splits large reads because the xref table is read in one go (up to 32 MiB) and `readRange` has a per-call cap (`maxReadBytes`); plus preparation in 30–50 ms chunks and chunked compression;
- **the progress sheet:** "Page x of n", `accessibilityRole="progressbar"` with its value, a live region that does not announce every page, Cancel, the errors of §5 and the `replacedCharacters` warning, in Spanish, English, Dutch and German;
- **the entry point:** the overflow menu of the library card and row, and an "Export annotated PDF" accessibility action (not long press, which the library uses for selection); and removing the pdf-lib case from the measuring screen;
- **highlighters with one layer per ink (ADR-008 §4), a requirement:** per ink and page, a transparency group (a Form XObject with `/Group << /S /Transparency >>` holding that ink's strokes opaque), drawn with `Do` under an `ExtGState` with its alpha (`/ca`), inks in order of first appearance, like `highlightGroups`, checked with the readers of the compatibility table by comparing one-ink and two-ink crossings with the app. The layers that go in are the visible ones, as in the reader.
- **Also:** more real PDFs (public-domain libraries, publishers, scans from other tools) with testers; Preview, PDFKit and a real tablet or iPad; and whether the native `readRange` serves concurrent reads (if it queues them, reading children 32 at a time gains less than in the benchmark, where all resolve in the same turn).

## Consequences

- **The same frame:** `framePdfPage` reads boxes and `/Rotate` like pdf.js, and a test checks that each mark lands where `normalizedToPdf` says. The iOS MediaBox fix of the native renderer is still needed for screen and export to match on iOS.
- **Stamps identical to the screen:** their outlines come from the same Bravura. If the stamp catalogue or the font changes, a test asks to regenerate them. **Text differs from the screen:** it is Helvetica (§2).
- **Requested from the library:** the export joins the library's list of score actions, marked as presenting a system sheet (on iOS it waits for the menu to close), without touching the grid or the list.
- **The inks of the Normal appearance,** even when reading in Paper or Night: the PDF is for printing.

## Risks

- **pdf-lib is unmaintained:** the latest version, 1.17.1, dates from November 2021, with no npm release since. It was one reason to discard it; the incremental update depends neither on it nor on its forks. Only the benchmark and the tests use it.
- **Memory on Hermes:** the incremental update never holds input and output at once. Measured alone on the emulator: 99–112 MB over baseline, under the 150 MB threshold. The iPad (`phys_footprint`) is still to be measured.
- **PDFs the core reader misreads** (broken xref tables) return `unreadable`. pdf-lib rebuilt some and the incremental update does not: the UI then offers the data ZIP, and the import fixtures and real PDFs are tested.
- **Export and screen must match:** checked with `pdftoppm` (Poppler) and with an operator interpreter in the tests. Opening it in the iOS and Android system viewers is still to be done.
