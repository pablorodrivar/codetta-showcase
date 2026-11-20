// The annotated-PDF export case (ADR-014, with pdf-lib): a big book built in JS, so `pdf-report` (Node)
// and the device bench (`dev-perf`, Hermes) export the same bytes with the same annotations.
// Not for production code: lint keeps it out of everything but scripts, benches and dev screens.

import { PDFDocument, PDFName } from 'pdf-lib';

import { type PreparedAnnotation, preparePage } from '../page/prepare-page';
import { annotatePdf, type AnnotatePdfProgress } from '../pdf/annotate-pdf';
import { toPointBuffer } from '../points';
import { encodeAnnotationData } from '../schema/rows';
import { SMUFL_GLYPH_NAMES } from '../stamps/catalog';
import { seededRandom, syntheticStrokes } from '../test/synthetic-strokes';

/**
 * A scanned book like the 342-page one the app is measured with (the Beethoven scan of
 * fixtures/README.md, joined 18 times): the Beethoven scan has, per page, one bitonal image and about 140 small greyscale tiles. Here the
 * images are uncompressed grey noise of the same sizes, so the file has a similar number of
 * objects and bytes (what pdf-lib parses and writes) and still renders.
 */
export interface BookSpec {
  readonly pages: number;
  /** Bytes of the page's big image (8-bit grey, uncompressed). */
  readonly imageBytes: number;
  readonly tilesPerPage: number;
  readonly tileBytes: number;
}

/** About beethoven-x18.pdf: 342 pages, ~115 MB, ~48,000 images. */
export const BIG_BOOK: BookSpec = {
  pages: 342,
  imageBytes: 120_000,
  tilesPerPage: 140,
  tileBytes: 1_500,
};

/** About the Beethoven scan itself: 19 pages, ~6 MB. */
export const SCORE: BookSpec = { ...BIG_BOOK, pages: 19 };

/** Page size of the Beethoven scan, in points. */
const PAGE_SIZE: [number, number] = [700, 982];

/** Grey noise to cut the images from: different bytes for every image, cheaply. */
function noise(bytes: number): Uint8Array {
  const random = seededRandom(17);
  const pool = new Uint32Array(Math.ceil(bytes / 4));
  for (let index = 0; index < pool.length; index++) pool[index] = random() * 0x1_0000_0000;
  return new Uint8Array(pool.buffer, 0, bytes);
}

function imageSize(bytes: number): { width: number; height: number } {
  const width = Math.round(Math.sqrt(bytes * (PAGE_SIZE[0] / PAGE_SIZE[1])));
  return { width, height: Math.floor(bytes / width) };
}

/** The book's PDF. `yieldNow` runs between pages, so a screen stays responsive. */
export async function syntheticBook(
  spec: BookSpec,
  yieldNow: () => Promise<void> = () => Promise.resolve(),
): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const { context } = document;
  const pool = noise(1 << 20);
  const big = imageSize(spec.imageBytes);
  const tile = imageSize(spec.tileBytes);
  const columns = Math.ceil(Math.sqrt(spec.tilesPerPage));
  let offset = 0;
  const image = (size: { width: number; height: number }) => {
    const length = size.width * size.height;
    if (offset + length > pool.length) offset = (offset % 997) + 1;
    const bytes = pool.subarray(offset, offset + length);
    offset += length;
    return context.register(
      context.stream(bytes, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: size.width,
        Height: size.height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
  };
  for (let pageIndex = 0; pageIndex < spec.pages; pageIndex++) {
    const page = document.addPage(PAGE_SIZE);
    const xObjects = context.obj({});
    const operators = [`q ${String(PAGE_SIZE[0])} 0 0 ${String(PAGE_SIZE[1])} 0 0 cm /I0 Do Q`];
    xObjects.set(PDFName.of('I0'), image(big));
    const tileWidth = PAGE_SIZE[0] / columns;
    const tileHeight = PAGE_SIZE[1] / columns;
    for (let index = 0; index < spec.tilesPerPage; index++) {
      const name = `T${String(index)}`;
      xObjects.set(PDFName.of(name), image(tile));
      const x = (index % columns) * tileWidth;
      const y = Math.floor(index / columns) * tileHeight;
      operators.push(
        `q ${tileWidth.toFixed(2)} 0 0 ${tileHeight.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`,
      );
    }
    page.node.set(PDFName.of('Resources'), context.obj({ XObject: xObjects }));
    page.node.set(
      PDFName.of('Contents'),
      context.register(context.flateStream(operators.join('\n'))),
    );
    if (pageIndex % 20 === 19) await yieldNow();
  }
  return document.save({ useObjectStreams: false, addDefaultPage: false });
}

const ROW_BASE = {
  owner_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
  score_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
  layer_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
  created_at: '2026-11-10T00:00:00Z',
  updated_at: '2026-11-10T00:00:00Z',
  deleted_at: null,
};

/**
 * A well-annotated page, as the local SQLite returns it (JSON text rows): the 32 synthetic pen
 * strokes of ADR-008 (fingerings, slurs, circles, hairpins, words and a 1,900-point scribble),
 * 3 highlights, 4 texts, 8 stamps and 3 shapes. 50 annotations.
 */
export function annotatedPageRows(pageIndex: number): string[] {
  const random = seededRandom(pageIndex + 101);
  const rows: { type: string; data: unknown }[] = [];
  const strokes = syntheticStrokes(pageIndex + 1);
  for (const stroke of strokes) {
    rows.push({
      type: 'stroke',
      data: {
        v: 1,
        ink: 'red',
        width: 0.003,
        input: stroke.input,
        points: toPointBuffer(stroke.points),
      },
    });
  }
  for (const stroke of strokes.slice(0, 3)) {
    rows.push({
      type: 'highlight',
      data: {
        v: 1,
        ink: 'yellow',
        width: 0.02,
        input: 'pen',
        points: toPointBuffer(stroke.points),
      },
    });
  }
  for (const text of ['rit.', 'a tempo', 'più mosso', 'dolce\ncon moto']) {
    rows.push({
      type: 'text',
      data: { v: 1, text, x: random() * 0.7, y: random() * 0.9, fontSize: 0.025, ink: 'blue' },
    });
  }
  for (let index = 0; index < 8; index++) {
    rows.push({
      type: 'stamp',
      data: {
        v: 1,
        kind: 'smufl',
        glyph: SMUFL_GLYPH_NAMES[Math.floor(random() * SMUFL_GLYPH_NAMES.length)],
        x: 0.05 + random() * 0.9,
        y: 0.05 + random() * 0.9,
        scale: 1,
        ink: 'graphite',
      },
    });
  }
  const at = (): [number, number] => [0.1 + random() * 0.8, 0.1 + random() * 0.8];
  rows.push(
    {
      type: 'shape',
      data: { v: 1, kind: 'slur', from: at(), to: at(), bulge: 0.2, ink: 'red', width: 0.002 },
    },
    {
      type: 'shape',
      data: {
        v: 1,
        kind: 'hairpin',
        apex: at(),
        end: at(),
        opening: 0.03,
        ink: 'blue',
        width: 0.002,
      },
    },
    {
      type: 'shape',
      data: { v: 1, kind: 'rect', x: 0.1, y: 0.4, w: 0.3, h: 0.1, ink: 'green', width: 0.002 },
    },
  );
  return rows.map(({ type, data }, z) =>
    JSON.stringify({
      ...ROW_BASE,
      id: `019a7a2e-1c2d-7e3f-8a4b-${String(pageIndex * 100 + z).padStart(12, '0')}`,
      page_index: pageIndex,
      type,
      data: JSON.stringify(
        encodeAnnotationData({ type, data } as Parameters<typeof encodeAnnotationData>[0]),
      ),
      z,
    }),
  );
}

/** Distinct annotated pages the bench cycles through, built before the clock starts. */
export const ANNOTATED_PAGE_VARIANTS = 16;

export type ExportPhase = AnnotatePdfProgress['phase'];

export interface PdfExportBenchResult {
  readonly label: string;
  readonly pages: number;
  readonly annotatedPages: number;
  readonly inputMB: number;
  readonly outputMB: number;
  /** Parsing the file (pdf-lib `load`). */
  readonly loadMs: number;
  /**
   * Reading the rows and building the outlines of every page (`preparePage`). The rows are
   * built before the clock starts: in the app they come from SQLite.
   */
  readonly prepareMs: number;
  /** Writing the pages' content streams (operators and Flate), and yielding after each. */
  readonly drawMs: number;
  /** Writing the file (pdf-lib `save`). */
  readonly saveMs: number;
  readonly totalMs: number;
  /** The longest the JS thread went without running a timer: what a progress bar would show. */
  readonly longestBlockMs: number;
  /** The phase that block ended in. */
  readonly longestBlockPhase: ExportPhase;
  /** Peak memory during the export, in MB (`memoryProbe`, or `memory()` sampled), if given. */
  readonly peakMemoryMB: number | null;
}

/**
 * Memory sampled by the host away from the JS thread, so a long block does not hide the peak:
 * on the device, the `memory-probe` module (PSS on Android, `phys_footprint` on iOS).
 */
export interface MemoryProbe {
  /** Memory in use now, in bytes, or null if the platform cannot say. */
  current(): number | null;
  /** Starts sampling; the peak counts from here. */
  start(): void;
  /** Stops sampling and gives the peak since `start`, in bytes, or null. */
  stop(): Promise<number | null>;
}

export interface PdfExportBenchOptions {
  readonly now: () => number;
  /** Objects pdf-lib handles between yields: the export's default unless a run compares. */
  readonly objectsPerTick?: number;
  /** Memory in use, in bytes (Node: `process.memoryUsage().rss`), sampled during the export. */
  readonly memory?: () => number;
  /** Sampled off the JS thread; wins over `memory` when both are given. */
  readonly memoryProbe?: MemoryProbe;
  /** As `annotatePdf`'s: null writes the content streams uncompressed. */
  readonly deflate?: ((bytes: Uint8Array) => Uint8Array) | null;
  /** The pages that carry annotations (`spreadPages`); every page by default. */
  readonly pages?: ReadonlySet<number>;
}

/** `count` page indices spread evenly over a book of `total` pages, from the first. */
export function spreadPages(count: number, total: number): Set<number> {
  const pages = new Set<number>();
  for (let index = 0; index < Math.min(count, total); index++) {
    pages.add(Math.floor((index * total) / Math.min(count, total)));
  }
  return pages;
}

/**
 * Exports `source` with a well-annotated page on every page (or on `pages`), timing each phase from inside
 * `annotatePdf` (its callbacks), and the longest stretch without a timer turn and its phase.
 */
export async function runPdfExportBench(
  label: string,
  source: Uint8Array,
  options: PdfExportBenchOptions,
): Promise<PdfExportBenchResult> {
  const { now } = options;
  const rows = Array.from({ length: ANNOTATED_PAGE_VARIANTS }, (_, index) =>
    annotatedPageRows(index),
  );
  let phase: ExportPhase = 'load';
  let peak = options.memory?.() ?? 0;
  let longestBlockMs = 0;
  let longestBlockPhase: ExportPhase = 'load';
  let last = now();
  let ticking = true;
  const block = (at: number) => {
    if (at - last > longestBlockMs) {
      longestBlockMs = at - last;
      longestBlockPhase = phase;
    }
    last = at;
  };
  const tick = () => {
    block(now());
    if (options.memory) peak = Math.max(peak, options.memory());
    if (ticking) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  options.memoryProbe?.start();

  let prepareMs = 0;
  const marks: { loadEnd: number | null; saveStart: number | null } = {
    loadEnd: null,
    saveStart: null,
  };
  const start = now();
  const result = await annotatePdf(
    source,
    (pageIndex, frame): readonly PreparedAnnotation[] => {
      const before = now();
      // The first page asked for ends the load.
      marks.loadEnd ??= before;
      phase = 'draw';
      if (options.pages && !options.pages.has(pageIndex)) return [];
      const page = preparePage(rows[pageIndex % rows.length] ?? [], frame.aspect, { now });
      prepareMs += now() - before;
      return page.items;
    },
    {
      ...(options.objectsPerTick === undefined ? {} : { objectsPerTick: options.objectsPerTick }),
      ...(options.deflate === undefined ? {} : { deflate: options.deflate }),
      onProgress: (progress) => {
        if (progress.phase === 'save') marks.saveStart = now();
        phase = progress.phase;
      },
    },
  );
  const end = now();
  ticking = false;
  block(end);
  const probePeak = options.memoryProbe ? await options.memoryProbe.stop() : null;
  if (!result.ok) throw new Error(`Export failed: ${result.message}`);
  const peakBytes = options.memoryProbe ? probePeak : options.memory ? peak : null;
  const loadEnd = marks.loadEnd ?? end;
  const saveStart = marks.saveStart ?? end;
  return {
    label,
    pages: result.pageCount,
    annotatedPages: result.annotatedPages,
    inputMB: source.length / 1e6,
    outputMB: result.bytes.length / 1e6,
    loadMs: loadEnd - start,
    prepareMs,
    drawMs: saveStart - loadEnd - prepareMs,
    saveMs: end - saveStart,
    totalMs: end - start,
    longestBlockMs,
    longestBlockPhase,
    peakMemoryMB: peakBytes === null ? null : peakBytes / 1e6,
  };
}

/** The ADR-014 table: one column per run. */
export function pdfExportMarkdown(results: readonly PdfExportBenchResult[]): string {
  // Decimal commas, like the ADRs (`formatMs`).
  const decimal = (value: number, digits: number) => value.toFixed(digits).replace('.', ',');
  const ms = (value: number) =>
    value < 10_000 ? `${value.toFixed(0)} ms` : `${decimal(value / 1000, 1)} s`;
  const phases: Record<ExportPhase, string> = {
    load: 'reading',
    draw: 'drawing',
    save: 'writing',
  };
  const row = (title: string, cell: (result: PdfExportBenchResult) => string) =>
    `| ${[title, ...results.map(cell)].join(' | ')} |`;
  return [
    row('', (result) => result.label),
    `|${['', ...results].map(() => '---').join('|')}|`,
    row(
      'Pages (annotated)',
      (result) => `${String(result.pages)} (${String(result.annotatedPages)})`,
    ),
    row(
      'Size, input → output',
      (result) => `${decimal(result.inputMB, 1)} → ${decimal(result.outputMB, 1)} MB`,
    ),
    row('Read the PDF (pdf-lib `load`)', (result) => ms(result.loadMs)),
    row('Prepare the annotations', (result) => ms(result.prepareMs)),
    row('Draw them (operators and Flate)', (result) => ms(result.drawMs)),
    row('Write the PDF (pdf-lib `save`)', (result) => ms(result.saveMs)),
    row('Total', (result) => ms(result.totalMs)),
    row(
      'Longest block of the JS thread',
      (result) => `${ms(result.longestBlockMs)}, ${phases[result.longestBlockPhase]}`,
    ),
    row('Memory, peak', (result) =>
      result.peakMemoryMB === null ? '—' : `${result.peakMemoryMB.toFixed(0)} MB`,
    ),
  ].join('\n');
}

/**
 * The cases of the ADR-014 table, in order: the 19-page score, then the big book compressed
 * (pako, level 1) and uncompressed. Each book is built just before its runs.
 */
export async function runPdfExportCases(
  options: Omit<PdfExportBenchOptions, 'objectsPerTick' | 'deflate'> & {
    readonly onCase?: (label: string) => void;
    readonly yieldNow?: () => Promise<void>;
  },
): Promise<PdfExportBenchResult[]> {
  const base = { ...options };
  const results: PdfExportBenchResult[] = [];
  const run = async (label: string, source: Uint8Array, deflate?: null): Promise<void> => {
    options.onCase?.(label);
    await options.yieldNow?.();
    results.push(
      await runPdfExportBench(label, source, deflate === null ? { ...base, deflate } : base),
    );
  };
  options.onCase?.('Building the 19-page score');
  await run('Score, 19 pp.', await syntheticBook(SCORE, options.yieldNow));
  options.onCase?.('Building the 342-page book');
  const book = await syntheticBook(BIG_BOOK, options.yieldNow);
  await run('Book, 342 pp.', book);
  await run('Book, 342 pp., uncompressed', book, null);
  return results;
}
