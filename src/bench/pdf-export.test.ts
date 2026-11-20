import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { preparePage } from '../page/prepare-page';
import {
  annotatedPageRows,
  pdfExportMarkdown,
  runPdfExportBench,
  syntheticBook,
} from './pdf-export';

const TINY = { pages: 2, imageBytes: 2_000, tilesPerPage: 3, tileBytes: 100 };

describe('the annotated-PDF export bench', () => {
  it('builds a book pdf-lib reads back, page by page', async () => {
    const document = await PDFDocument.load(await syntheticBook(TINY));
    expect(document.getPageCount()).toBe(2);
    expect(document.getPage(0).getSize()).toEqual({ width: 700, height: 982 });
  });

  it('annotates a page with 50 valid annotations of every type', () => {
    const page = preparePage(annotatedPageRows(3), 982 / 700, { now: () => 0 });
    expect(page.invalid).toEqual([]);
    expect(page.items).toHaveLength(50);
    expect(new Set(page.items.map((item) => item.annotation.type))).toEqual(
      new Set(['stroke', 'highlight', 'text', 'stamp', 'shape']),
    );
  });

  it('times every phase apart and writes the ADR-014 table with decimal commas', async () => {
    const book = await syntheticBook(TINY);
    let clock = 0;
    const result = await runPdfExportBench('tiny', book, { now: () => (clock += 1) });
    expect(result).toMatchObject({
      label: 'tiny',
      pages: 2,
      annotatedPages: 2,
      peakMemoryMB: null,
    });
    for (const phase of [result.loadMs, result.prepareMs, result.drawMs, result.saveMs]) {
      expect(phase).toBeGreaterThan(0);
    }
    expect(['load', 'draw', 'save']).toContain(result.longestBlockPhase);
    const table = pdfExportMarkdown([{ ...result, inputMB: 1.25, totalMs: 12_340 }]);
    expect(table).toContain('| 1,3 → ');
    expect(table).toContain('| 12,3 s |');
  });
});
