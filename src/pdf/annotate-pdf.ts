import { deflate as pakoDeflate } from 'pako';
import {
  EncryptedPDFError,
  PDFArray,
  PDFDocument,
  type PDFFont,
  PDFName,
  PDFNumber,
  type PDFPage,
  type PDFPageLeaf,
  StandardFonts,
} from 'pdf-lib';

import { type PageFrame, pageFrame, type PdfBox } from '../geometry/page-frame';
import type { PreparedAnnotation } from '../page/prepare-page';
import { pdfPageContent } from './content';

/**
 * The annotated-PDF export (ADR-014): the score's PDF with every visible
 * annotation drawn into its pages ("flattened", rule 4), with pdf-lib. It rewrites the whole
 * file, keeping every page, image and font as it was, and appends one content stream per
 * annotated page after the original content, which is wrapped in `q`/`Q` so a page that leaves
 * its graphics state changed cannot move the annotations.
 */

/**
 * Objects pdf-lib parses or writes before it yields to the event loop, and so the export by
 * default: the JS thread stays free to draw a progress bar and take a cancel (ADR-014 §4).
 */
export const EXPORT_OBJECTS_PER_TICK = 50;

export type AnnotatePdfProgress =
  | { readonly phase: 'load' }
  | { readonly phase: 'draw'; readonly pageIndex: number; readonly pageCount: number }
  | { readonly phase: 'save' };

export interface AnnotatePdfOptions {
  /**
   * Objects pdf-lib parses or writes between yields to the event loop (`setTimeout`); the
   * export also yields after each annotated page. `EXPORT_OBJECTS_PER_TICK` by default;
   * Infinity never yields (the bench compares the two).
   */
  readonly objectsPerTick?: number;
  /**
   * Compresses a content stream for `/FlateDecode` (zlib format). By default pako at level 1:
   * level 6, pdf-lib's own, takes about 2.4 times as long without a JIT for 15 % less (ADR-014).
   * The app may pass a native one; null writes the streams uncompressed.
   */
  readonly deflate?: ((bytes: Uint8Array) => Uint8Array) | null;
  /** Write objects in object streams (smaller, slower). False by default (ADR-014). */
  readonly useObjectStreams?: boolean;
  /** Each phase as it starts, and each annotated page once drawn. */
  readonly onProgress?: (progress: AnnotatePdfProgress) => void;
  /**
   * Checked after loading, between pages and before saving: when it is aborted, the export stops
   * with `cancelled`. An `AbortSignal` fits.
   */
  readonly signal?: { readonly aborted: boolean };
}

export type AnnotatePdfResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly pageCount: number;
      readonly annotatedPages: number;
      /** Text characters Helvetica cannot show, drawn as "?" (`win-ansi.ts`). */
      readonly replacedCharacters: number;
    }
  | {
      readonly ok: false;
      /**
       * - `encrypted`: pdf-lib cannot write encrypted files, even with only a permissions password;
       * - `unreadable`: pdf-lib cannot read the file or its page tree;
       * - `cancelled`: the signal was aborted;
       * - `failed`: anything else while drawing or saving (out of memory, a page whose resources
       *   pdf-lib cannot take, an error from `annotationsOf`), with its message.
       */
      readonly reason: 'encrypted' | 'unreadable' | 'cancelled' | 'failed';
      readonly message: string;
    };

/** The annotations of a page, in draw order, prepared with `frame.aspect`; empty for none. */
export type AnnotationsOfPage = (
  pageIndex: number,
  frame: PageFrame,
) => readonly PreparedAnnotation[] | Promise<readonly PreparedAnnotation[]>;

function fastDeflate(bytes: Uint8Array): Uint8Array {
  return pakoDeflate(bytes, { level: 1 });
}

/** The content (ASCII: operators, numbers and hex strings) as bytes. */
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

const nextTick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/** A box array of the page as numbers, or null if it is missing, not an array or broken. */
function box(node: PDFPageLeaf, name: PDFName): PdfBox | null {
  // Looked up without a type: pdf-lib's typed `MediaBox()` throws on a missing or odd box, and
  // a page every viewer shows must still be exported (ADR-008 §1).
  const value = node.context.lookup(node.getInheritableAttribute(name));
  if (!(value instanceof PDFArray) || value.size() !== 4) return null;
  const numbers = [0, 1, 2, 3].map((index) => {
    const entry = node.context.lookup(value.get(index));
    return entry instanceof PDFNumber ? entry.asNumber() : Number.NaN;
  });
  return numbers.every(Number.isFinite)
    ? [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0]
    : null;
}

/** The page frame of ADR-008 §1, from the same boxes pdf.js and PDFium read, broken or not. */
export function framePdfPage(node: PDFPageLeaf): PageFrame {
  const rotate = node.context.lookup(node.getInheritableAttribute(PDFName.of('Rotate')));
  return pageFrame({
    mediaBox: box(node, PDFName.of('MediaBox')),
    cropBox: box(node, PDFName.of('CropBox')),
    rotate: rotate instanceof PDFNumber ? rotate.asNumber() : 0,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown error';
}

const failure = (
  reason: 'unreadable' | 'cancelled' | 'failed',
  error?: unknown,
): AnnotatePdfResult => ({
  ok: false,
  reason,
  message: error === undefined ? reason : messageOf(error),
});

/**
 * Never throws: every failure comes back as a result (`AnnotatePdfResult`), so the export screen
 * always has something to say and offers the data ZIP instead (ADR-014 §5).
 */
export async function annotatePdf(
  source: Uint8Array,
  annotationsOf: AnnotationsOfPage,
  options: AnnotatePdfOptions = {},
): Promise<AnnotatePdfResult> {
  const objectsPerTick = options.objectsPerTick ?? EXPORT_OBJECTS_PER_TICK;
  const deflate = options.deflate === undefined ? fastDeflate : options.deflate;
  const { onProgress, signal } = options;
  let document: PDFDocument;
  let pages: { readonly page: PDFPage; readonly frame: PageFrame }[];
  onProgress?.({ phase: 'load' });
  try {
    document = await PDFDocument.load(source, {
      // pdf-lib's name for objects per tick when loading.
      parseSpeed: objectsPerTick,
      // The user's file: its title, author and dates stay as they were.
      updateMetadata: false,
    });
    // A broken page tree only shows here, not while loading.
    pages = document.getPages().map((page) => ({ page, frame: framePdfPage(page.node) }));
  } catch (error) {
    const message = messageOf(error);
    // pdf-lib is compiled to ES5, where `instanceof` fails for its own Error subclasses.
    return error instanceof EncryptedPDFError || message.includes('is encrypted')
      ? { ok: false, reason: 'encrypted', message }
      : failure('unreadable', error);
  }

  try {
    const { context } = document;
    let font: PDFFont | null = null;
    let annotatedPages = 0;
    let replacedCharacters = 0;
    for (const [pageIndex, { page, frame }] of pages.entries()) {
      if (signal?.aborted) return failure('cancelled');
      const items = await annotationsOf(pageIndex, frame);
      if (items.length === 0) continue;
      const opacities = new Map<number, string>();
      let fontName: string | null = null;
      const { content, replacedCharacters: replaced } = pdfPageContent(items, frame, {
        textFont: () => {
          // pdf-lib embeds it once (no font file: a standard font) and names it on each page.
          font ??= document.embedStandardFont(StandardFonts.Helvetica);
          fontName ??= page.node.newFontDictionary('CodettaText', font.ref).toString();
          return fontName;
        },
        fillOpacity: (opacity) => {
          let name = opacities.get(opacity);
          if (name === undefined) {
            name = page.node
              .newExtGState('CodettaAlpha', context.obj({ Type: 'ExtGState', ca: opacity }))
              .toString();
            opacities.set(opacity, name);
          }
          return name;
        },
      });
      const bytes = latin1Bytes(content);
      const stream =
        deflate === null
          ? context.stream(bytes)
          : context.stream(deflate(bytes), { Filter: 'FlateDecode' });
      // `addContentStream` normalizes the page first: the original content goes into an array,
      // wrapped in q/Q, and this stream after it.
      page.node.addContentStream(context.register(stream));
      annotatedPages++;
      replacedCharacters += replaced;
      onProgress?.({ phase: 'draw', pageIndex, pageCount: pages.length });
      // Like pdf-lib between objects: one page is the most the export itself runs in a row.
      if (Number.isFinite(objectsPerTick)) await nextTick();
    }

    if (signal?.aborted) return failure('cancelled');
    onProgress?.({ phase: 'save' });
    const output = await document.save({
      objectsPerTick,
      useObjectStreams: options.useObjectStreams ?? false,
      addDefaultPage: false,
      // No form fields are touched: leave their appearances alone.
      updateFieldAppearances: false,
    });
    return {
      ok: true,
      bytes: output,
      pageCount: pages.length,
      annotatedPages,
      replacedCharacters,
    };
  } catch (error) {
    return failure('failed', error);
  }
}
