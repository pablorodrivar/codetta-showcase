// Generates frames.pdf: pages whose CropBox differs from the MediaBox and that carry /Rotate,
// with coloured squares at known PDF user-space positions, to check that a renderer draws
// the page in the annotation frame of ADR-008 §1 (CropBox ∩ MediaBox, then /Rotate).
// Plain Node, no dependencies; the output is byte-for-byte reproducible.
//
//   node fixtures/frames/generate.mjs
//
// The pages and their marks are in pages.mjs, which the tests import.

import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COLOURS, PAGES } from './pages.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function content(page) {
  const lines = [];
  for (const square of page.squares) {
    const [r, g, b] = COLOURS[square.colour];
    lines.push(`${r} ${g} ${b} rg ${square.x} ${square.y} ${square.side} ${square.side} re f`);
  }
  return `${lines.join('\n')}\n`;
}

const objects = [];
const add = (body) => {
  objects.push(body);
  return objects.length;
};

const catalog = add(null);
const pages = add(null);
const kids = [];
for (const page of PAGES) {
  const stream = content(page);
  const contents = add(
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
  );
  const crop = page.cropBox ? ` /CropBox [${page.cropBox.join(' ')}]` : '';
  const rotate = page.rotate ? ` /Rotate ${page.rotate}` : '';
  kids.push(
    add(
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [${page.mediaBox.join(' ')}]${crop}${rotate} /Contents ${contents} 0 R /Resources << >> >>`,
    ),
  );
}
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
objects[pages - 1] =
  `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`;

let pdf = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
const offsets = [];
objects.forEach((body, index) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

writeFileSync(join(here, 'frames.pdf'), Buffer.from(pdf, 'latin1'));
