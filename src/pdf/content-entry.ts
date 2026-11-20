/**
 * `@codetta/annotations/pdf/content`: the operators of a page's annotations (ADR-014), without
 * pdf-lib, for an export that writes the PDF itself (the incremental update of ADR-014, in the private repository).
 */
export {
  outlineToPdf,
  type PdfPageContent,
  pdfPageContent,
  type PdfResourceNames,
} from './content';
export { winAnsiByte, winAnsiHex } from './win-ansi';
