// opentype.js 2.0 ships no types; this declares the little the SMuFL outline generator uses
// (src/stamps/smufl-outlines.test.ts). A devDependency: never imported by shipped code.
declare module 'opentype.js' {
  export interface PathCommand {
    readonly type: 'M' | 'L' | 'C' | 'Q' | 'Z';
    readonly x?: number;
    readonly y?: number;
    readonly x1?: number;
    readonly y1?: number;
    readonly x2?: number;
    readonly y2?: number;
  }
  export interface Glyph {
    readonly index: number;
    /** The outline in font units, `y` up. */
    readonly path: { readonly commands: readonly PathCommand[] };
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
  }
  export interface Font {
    readonly unitsPerEm: number;
    charToGlyph(character: string): Glyph;
    readonly tables: {
      readonly hhea: { readonly ascender: number; readonly descender: number };
    };
  }
  export function parse(buffer: ArrayBuffer): Font;
}
