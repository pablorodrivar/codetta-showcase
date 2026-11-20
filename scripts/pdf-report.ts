/// <reference types="node" />
/**
 * `pnpm pdf-report`: the annotated-PDF export on a big scanned book
 * (ADR-014, with pdf-lib). Node (V8 with JIT) is a lower bound: Hermes is measured on the device with
 * the measuring screen (`dev-perf`), which runs these same cases (`../src/bench`).
 */
import { it } from 'vitest';

import { pdfExportMarkdown, runPdfExportCases } from '../src/bench/pdf';

it('prints the export table', async () => {
  const results = await runPdfExportCases({
    now: () => performance.now(),
    memory: () => process.memoryUsage().rss,
  });
  const jit = process.execArgv.includes('--jitless') ? ' --jitless' : '';
  console.log(`Node ${process.version}${jit}\n\n${pdfExportMarkdown(results)}`);
}, 600_000);
