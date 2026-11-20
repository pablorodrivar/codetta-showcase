# Test fixtures

The PDFs that `src/pdf/annotate-pdf.test.ts` reads. They are public-domain or CC0 files, kept exactly as they were downloaded or generated.

| File                              | What it is                                                                                                                                                     | Size      | SHA-256                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `frames/frames.pdf`               | Three pages whose CropBox differs from the MediaBox, with `/Rotate` 90, 0 and 180, and coloured squares at known PDF user-space positions (`frames/pages.mjs`) | 1,070 B   | `f6586bab28dc0bfdf61b303fb709e2badd0d1c4616ae194294b69153db35efd7` |
| `scores/bach-bwv1011-mutopia.pdf` | J. S. Bach, Cello Suite No. 5, BWV 1011: a 9-page vector score (LilyPond), A4                                                                                  | 331,161 B | `be90162da838f114718bfc2dbcc94ad564f2cea0e9d0a87890ef216ca3c3db2b` |
| `import/bach-user-password.pdf`   | The Bach with an open password (AES-256): the export refuses it as `encrypted`                                                                                 | 333,087 B | `0e4bf36ac93b6549572e737afa2d9bfe9a00750277a8f57d76de75ac728245b9` |
| `import/bach-owner-password.pdf`  | The Bach with a permissions-only password (AES-256): also `encrypted`, since pdf-lib cannot write encrypted files                                              | 333,090 B | `3b1c4369f6e350cda609579937705091699d44ad5645e27a5c95e7a6f6e3b72a` |
| `import/corrupt.pdf`              | A `%PDF-1.7` header followed by garbage: `unreadable`                                                                                                          | 4,105 B   | `eceb67069e5a4b3ca81e7a28d5126884766eb73bd73b53f224ee44c67503704e` |
| `import/not-a-pdf.pdf`            | A 1×1 PNG with a `.pdf` extension: `unreadable`                                                                                                                | 70 B      | `c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77` |

## Sources and licenses

- **`scores/bach-bwv1011-mutopia.pdf`:** Mutopia Project edition `Mutopia-2018/05/15-2219`, typeset with LilyPond 2.18.2 by Hajo Dezelski from the edition by Werner Icking. Every page's footer reads "Placed in the Public Domain by the typesetter — free to distribute, modify, and perform", and the piece's Mutopia page lists it as Public Domain. Downloaded from the Mutopia Project (piece 2219, A4 PDF).
- **`import/*.pdf`:** derived from that public-domain Bach with [qpdf](https://qpdf.sourceforge.io/), or made from scratch. CC0. The two encrypted files are not reproducible byte for byte (qpdf uses a random salt and IV): the bytes and their SHA-256 are the reference.
- **`frames/`:** written by `frames/generate.mjs` (plain Node, byte-for-byte reproducible: `node fixtures/frames/generate.mjs`). CC0.

The export bench (`pnpm pdf-report`) needs none of these: it builds its synthetic scanned books in memory.
