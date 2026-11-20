/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PDFRef } from 'pdf-lib';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRawStream,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { applyToPoint, invert } from '../geometry/matrix';
import { normalizedToPdf, type PageFrame, pageFrame } from '../geometry/page-frame';
import { type PreparedAnnotation, preparePage } from '../page/prepare-page';
import { NO_PRESSURE, toPointBuffer } from '../points';
import type { encodeAnnotationData } from '../schema/rows';
import { centre, interpretContent } from '../test/pdf-content';
import { storedRow } from '../test/stored-row';
import { annotatePdf, framePdfPage } from './annotate-pdf';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');

function fixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, path)));
}

type Data = Parameters<typeof encodeAnnotationData>[0];

function prepared(frame: PageFrame, annotations: readonly Data[]): PreparedAnnotation[] {
  const rows = annotations.map((annotation, z) => storedRow(z, annotation));
  return [...preparePage(rows, frame.aspect, { now: () => 0 }).items];
}

/** A 2 % square outline centred on a normalized point. */
function square(x: number, y: number): Data {
  return {
    type: 'shape',
    data: {
      v: 1,
      kind: 'rect',
      x: x - 0.01,
      y: y - 0.01,
      w: 0.02,
      h: 0.02,
      ink: 'red',
      width: 0.001,
    },
  };
}

/** The page's content streams, decoded, in order. */
function contents(page: PDFPage): string[] {
  const raw = page.node.get(PDFName.of('Contents'));
  const value = page.doc.context.lookup(raw);
  const refs: PDFObject[] = value instanceof PDFArray ? value.asArray() : raw ? [raw] : [];
  return refs.map((ref) => {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error('Not a content stream');
    return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
  });
}

interface FramesPage {
  readonly mediaBox: readonly [number, number, number, number];
  readonly cropBox: readonly [number, number, number, number] | null;
  readonly rotate: number;
  readonly squares: readonly { x: number; y: number; side: number; visible: boolean }[];
}

/** The pages of fixtures/frames/frames.pdf and their squares, from the fixture's own module. */
const { PAGES } = (await import(pathToFileURL(join(FIXTURES, 'frames', 'pages.mjs')).href)) as {
  PAGES: readonly FramesPage[];
};

/** Each page: its frame as pageFrame gives it from the boxes, and the visible squares' centres. */
const FRAME_PAGES = PAGES.map((page) => {
  const { width, height } = pageFrame({
    mediaBox: page.mediaBox,
    cropBox: page.cropBox,
    rotate: page.rotate,
  });
  return {
    width,
    height,
    centres: page.squares
      .filter((square) => square.visible)
      .map(({ x, y, side }) => [x + side / 2, y + side / 2] as const),
  };
});

describe('annotatePdf', () => {
  it('reads each page frame from its boxes and /Rotate, like pdf.js', async () => {
    const document = await PDFDocument.load(fixture('frames/frames.pdf'));
    expect(
      document.getPages().map((page) => {
        const { width, height } = framePdfPage(page.node);
        return { width, height };
      }),
    ).toEqual(FRAME_PAGES.map(({ width, height }) => ({ width, height })));
  });

  it('draws each annotation where the page shows its normalized point (frames.pdf)', async () => {
    const result = await annotatePdf(fixture('frames/frames.pdf'), (pageIndex, frame) => {
      const toNormalized = invert(normalizedToPdf(frame));
      const page = FRAME_PAGES[pageIndex];
      return prepared(
        frame,
        (page?.centres ?? []).map(([px, py]) => {
          const [x, y] = applyToPoint(toNormalized, px, py);
          return square(x, y);
        }),
      );
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ pageCount: 3, annotatedPages: 3, replacedCharacters: 0 });
    const output = await PDFDocument.load(result.bytes);
    output.getPages().forEach((page, pageIndex) => {
      const drawn = interpretContent(contents(page).at(-1) ?? '').paths;
      const expected = FRAME_PAGES[pageIndex]?.centres ?? [];
      expect(drawn).toHaveLength(expected.length);
      drawn.forEach((path, index) => {
        const [x, y] = centre(path.points);
        expect(x).toBeCloseTo(expected[index]?.[0] ?? Number.NaN, 1);
        expect(y).toBeCloseTo(expected[index]?.[1] ?? Number.NaN, 1);
      });
    });
  });

  it('keeps the original content, wrapped in q/Q, and appends the annotations after it', async () => {
    const source = fixture('scores/bach-bwv1011-mutopia.pdf');
    const before = await PDFDocument.load(source);
    const original = contents(before.getPage(0));
    const result = await annotatePdf(source, (pageIndex, frame) =>
      pageIndex === 0 ? prepared(frame, [square(0.5, 0.5)]) : [],
    );
    if (!result.ok) throw new Error(result.message);
    expect(result).toMatchObject({ pageCount: 9, annotatedPages: 1 });
    const after = await PDFDocument.load(result.bytes);
    const streams = contents(after.getPage(0));
    expect(streams.slice(1, -2)).toEqual(original);
    expect(streams[0]?.trim()).toBe('q');
    expect(streams.at(-2)?.trim()).toBe('Q');
    expect(streams.at(-1)).toMatch(/^q\n.* cm\n/);
    // A page without annotations is left as it was.
    expect(contents(after.getPage(1))).toEqual(contents(before.getPage(1)));
  });

  it('names a translucent graphics state for highlights and Helvetica for text, per page', async () => {
    const result = await annotatePdf(fixture('frames/frames.pdf'), (pageIndex, frame) =>
      pageIndex === 1
        ? prepared(frame, [
            {
              type: 'text',
              data: { v: 1, text: 'dolce', x: 0.1, y: 0.1, fontSize: 0.03, ink: 'blue' },
            },
            {
              type: 'highlight',
              data: {
                v: 1,
                ink: 'yellow',
                width: 0.02,
                input: 'mouse',
                points: toPointBuffer([
                  [0.2, 0.5],
                  [0.6, 0.5, NO_PRESSURE, 16],
                ]),
              },
            },
          ])
        : [],
    );
    if (!result.ok) throw new Error(result.message);
    const page = (await PDFDocument.load(result.bytes)).getPage(1);
    const resources = page.node.Resources();
    const fonts = resources?.lookup(PDFName.of('Font'), PDFDict);
    const states = resources?.lookup(PDFName.of('ExtGState'), PDFDict);
    const content = contents(page).at(-1) ?? '';
    const fontName = /(\/CodettaText\S*) 1 Tf/.exec(content)?.[1] ?? '';
    const stateName = /(\/CodettaAlpha\S*) gs/.exec(content)?.[1] ?? '';
    const font = fonts?.lookup(PDFName.of(fontName.slice(1)), PDFDict);
    expect(font?.get(PDFName.of('BaseFont'))).toBe(PDFName.of('Helvetica'));
    expect(font?.get(PDFName.of('Encoding'))).toBe(PDFName.of('WinAnsiEncoding'));
    const state = states?.lookup(PDFName.of(stateName.slice(1)), PDFDict);
    expect(state?.lookup(PDFName.of('ca'), PDFNumber).asNumber()).toBe(0.4);
  });

  it('adds no font when no page has text', async () => {
    const result = await annotatePdf(fixture('frames/frames.pdf'), (_, frame) =>
      prepared(frame, [square(0.5, 0.5)]),
    );
    if (!result.ok) throw new Error(result.message);
    const document = await PDFDocument.load(result.bytes);
    const fontsOnPages = document
      .getPages()
      .map((page) => page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)?.keys() ?? []);
    expect(fontsOnPages.flat()).toEqual([]);
    expect(
      document.context
        .enumerateIndirectObjects()
        .some(
          ([, object]: [PDFRef, unknown]) =>
            object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Font'),
        ),
    ).toBe(false);
  });

  it('frames a page without a MediaBox as US Letter and ignores a /Rotate that is not a number', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 400]);
    page.node.delete(PDFName.of('MediaBox'));
    page.node.set(PDFName.of('Rotate'), PDFName.of('Ninety'));
    let seen: PageFrame | null = null;
    const result = await annotatePdf(await document.save(), (_, frame) => {
      seen = frame;
      return prepared(frame, [square(0.5, 0.5)]);
    });
    expect(seen).toMatchObject({ width: 612, height: 792, rotation: 0 });
    expect(result).toMatchObject({ ok: true, annotatedPages: 1 });
  });

  it('returns a failure instead of throwing, for a page pdf-lib cannot take or a bad callback', async () => {
    const document = await PDFDocument.create();
    document.addPage().node.set(PDFName.of('Resources'), document.context.obj(5));
    const broken = await document.save();
    expect(
      await annotatePdf(broken, (_, frame) => prepared(frame, [square(0.5, 0.5)])),
    ).toMatchObject({ ok: false, reason: 'failed' });
    expect(
      await annotatePdf(fixture('frames/frames.pdf'), () => {
        throw new Error('no rows');
      }),
    ).toEqual({ ok: false, reason: 'failed', message: 'no rows' });
  });

  it('reports each phase and annotated page, and stops when cancelled', async () => {
    const progress: string[] = [];
    const signal = { aborted: false };
    const result = await annotatePdf(
      fixture('frames/frames.pdf'),
      (pageIndex, frame) => (pageIndex === 2 ? [] : prepared(frame, [square(0.5, 0.5)])),
      {
        onProgress: (step) => {
          progress.push(step.phase === 'draw' ? `draw ${String(step.pageIndex)}` : step.phase);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(progress).toEqual(['load', 'draw 0', 'draw 1', 'save']);
    const cancelled = await annotatePdf(
      fixture('frames/frames.pdf'),
      (_, frame) => {
        signal.aborted = true;
        return prepared(frame, [square(0.5, 0.5)]);
      },
      { signal },
    );
    expect(cancelled).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it.each([
    // pdf-lib cannot write encrypted files, even with a permissions-only password the import accepts.
    ['import/bach-user-password.pdf', 'encrypted'],
    ['import/bach-owner-password.pdf', 'encrypted'],
    ['import/corrupt.pdf', 'unreadable'],
    ['import/not-a-pdf.pdf', 'unreadable'],
  ])('refuses %s as %s', async (path, reason) => {
    const result = await annotatePdf(fixture(path), () => []);
    expect(result).toMatchObject({ ok: false, reason });
  });
});
