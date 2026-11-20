/**
 * `@codetta/annotations/pdf`: the annotated-PDF export (ADR-014). A separate entry
 * because it brings pdf-lib: only the export imports it.
 */
export {
  annotatePdf,
  type AnnotatePdfOptions,
  type AnnotatePdfProgress,
  type AnnotatePdfResult,
  type AnnotationsOfPage,
  EXPORT_OBJECTS_PER_TICK,
  framePdfPage,
} from './annotate-pdf';
export {
  outlineToPdf,
  type PdfPageContent,
  pdfPageContent,
  type PdfResourceNames,
} from './content';
export { winAnsiByte, winAnsiHex } from './win-ansi';
