/**
 * `@codetta/annotations/bench/pdf`: the annotated-PDF export case (ADR-014), apart from the other
 * benches because it brings pdf-lib: only `pdf-report` and the `dev-perf` screen import it, so
 * the app's diagnostics screen, which runs the other cases in the store build, does not carry pdf-lib.
 */
export {
  ANNOTATED_PAGE_VARIANTS,
  annotatedPageRows,
  BIG_BOOK,
  type BookSpec,
  type ExportPhase,
  type MemoryProbe,
  type PdfExportBenchOptions,
  type PdfExportBenchResult,
  pdfExportMarkdown,
  runPdfExportBench,
  runPdfExportCases,
  SCORE,
  spreadPages,
  syntheticBook,
} from './pdf-export';
