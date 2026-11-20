/**
 * Text for Helvetica with WinAnsiEncoding, the standard font the annotated-PDF export uses
 * without embedding one (ADR-014): it covers Spanish, English, Dutch and German. A character
 * outside it is drawn as "?" and counted, so the export can say so.
 */

/** WinAnsi bytes 0x80–0x9F that are not Latin-1 (PDF 32000-1, Annex D). */
const HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

const QUESTION_MARK = 0x3f;

/** The WinAnsi byte of a code point, or -1. A tab is a space. */
export function winAnsiByte(codePoint: number): number {
  if (codePoint === 0x09) return 0x20;
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) {
    return codePoint;
  }
  return HIGH[codePoint] ?? -1;
}

/** `text` as the hex digits of a PDF string (`<…>`), and how many characters became "?". */
export function winAnsiHex(text: string): { readonly hex: string; readonly replaced: number } {
  let hex = '';
  let replaced = 0;
  // By code point, so a character outside the BMP (an emoji) is one "?".
  for (const character of text) {
    let byte = winAnsiByte(character.codePointAt(0) ?? 0);
    if (byte < 0) {
      byte = QUESTION_MARK;
      replaced++;
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return { hex, replaced };
}
