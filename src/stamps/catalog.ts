/**
 * Stamp catalog : SMuFL glyphs drawn with Bravura,
 * plus the app's own symbols that SMuFL lacks (the "glasses" attention mark).
 *
 * A stamp stores the SMuFL *name* (`dynamicForte`), not the codepoint (ADR-008 §2): names
 * are the standard's stable identifiers, independent of the font. The codepoints below were
 * checked against SMuFL's `glyphnames.json` (w3c/smufl, 10/11/2026), and a test checks that
 * Bravura has every one.
 *
 * The UI labels each stamp through the app's translations with the key `annotation.stamp.<name>`
 * (added with the annotation UI); nothing here is user-visible text.
 */
export const SMUFL_GLYPHS = {
  // Dynamics
  dynamicPPP: 0xe52a,
  dynamicPP: 0xe52b,
  dynamicPiano: 0xe520,
  dynamicMP: 0xe52c,
  dynamicMF: 0xe52d,
  dynamicForte: 0xe522,
  dynamicFF: 0xe52f,
  dynamicFFF: 0xe530,
  dynamicFortePiano: 0xe534,
  dynamicSforzando1: 0xe536,
  dynamicSforzato: 0xe539,
  dynamicRinforzando2: 0xe53d,
  // Articulation and bowing
  articAccentAbove: 0xe4a0,
  articStaccatoAbove: 0xe4a2,
  articTenutoAbove: 0xe4a4,
  articStaccatissimoAbove: 0xe4a6,
  articMarcatoAbove: 0xe4ac,
  articTenutoStaccatoAbove: 0xe4b2,
  stringsDownBow: 0xe610,
  stringsUpBow: 0xe612,
  // Fingering
  fingering0: 0xed10,
  fingering1: 0xed11,
  fingering2: 0xed12,
  fingering3: 0xed13,
  fingering4: 0xed14,
  fingering5: 0xed15,
  // Breath and fermata
  breathMarkComma: 0xe4ce,
  caesura: 0xe4d1,
  fermataAbove: 0xe4c0,
  fermataBelow: 0xe4c1,
  // Accidentals
  accidentalFlat: 0xe260,
  accidentalNatural: 0xe261,
  accidentalSharp: 0xe262,
  accidentalDoubleSharp: 0xe263,
  accidentalDoubleFlat: 0xe264,
} as const;

export type SmuflGlyph = keyof typeof SMUFL_GLYPHS;
export const SMUFL_GLYPH_NAMES = Object.keys(SMUFL_GLYPHS) as SmuflGlyph[];

/** The app's own stamps, drawn as vector icons (`stampSymbolDrawing`). */
export const STAMP_SYMBOLS = ['glasses'] as const;
export type StampSymbol = (typeof STAMP_SYMBOLS)[number];

export type StampRef =
  | { readonly kind: 'smufl'; readonly glyph: SmuflGlyph }
  | { readonly kind: 'symbol'; readonly symbol: StampSymbol };

/** Categories in the order of the palette (recent first, which the app tracks). */
export const STAMP_CATEGORIES: readonly {
  readonly id: 'dynamics' | 'articulation' | 'fingering' | 'attention' | 'breath' | 'accidentals';
  readonly stamps: readonly StampRef[];
}[] = [
  {
    id: 'dynamics',
    stamps: smufl(
      'dynamicPPP',
      'dynamicPP',
      'dynamicPiano',
      'dynamicMP',
      'dynamicMF',
      'dynamicForte',
      'dynamicFF',
      'dynamicFFF',
      'dynamicFortePiano',
      'dynamicSforzando1',
      'dynamicSforzato',
      'dynamicRinforzando2',
    ),
  },
  {
    id: 'articulation',
    stamps: smufl(
      'articAccentAbove',
      'articStaccatoAbove',
      'articTenutoAbove',
      'articStaccatissimoAbove',
      'articMarcatoAbove',
      'articTenutoStaccatoAbove',
      'stringsDownBow',
      'stringsUpBow',
    ),
  },
  {
    id: 'fingering',
    stamps: smufl(
      'fingering0',
      'fingering1',
      'fingering2',
      'fingering3',
      'fingering4',
      'fingering5',
    ),
  },
  { id: 'attention', stamps: [{ kind: 'symbol', symbol: 'glasses' }] },
  {
    id: 'breath',
    stamps: smufl('breathMarkComma', 'caesura', 'fermataAbove', 'fermataBelow'),
  },
  {
    id: 'accidentals',
    stamps: smufl(
      'accidentalFlat',
      'accidentalNatural',
      'accidentalSharp',
      'accidentalDoubleSharp',
      'accidentalDoubleFlat',
    ),
  },
];

function smufl(...glyphs: SmuflGlyph[]): StampRef[] {
  return glyphs.map((glyph) => ({ kind: 'smufl', glyph }));
}

/** The character to draw a SMuFL stamp with Bravura. */
export function smuflCharacter(glyph: SmuflGlyph): string {
  return String.fromCodePoint(SMUFL_GLYPHS[glyph]);
}

/**
 * Side of a stamp's hit box at scale 1, in width units: about the height of a dynamic on
 * a printed A4 part. The renderer measures the real glyph; the eraser uses this box.
 */
export const STAMP_BASE_SIZE = 0.03;

/**
 * How to draw one of the app's own stamps, so the app and the web draw the same icon.
 *
 * `polylines` are centre lines in *stamp units*: the stamp's box at scale 1 is the square
 * from -0.5 to 0.5 on each axis, `y` down, centred on the stamp's `x`, `y`. One stamp unit
 * is {@link STAMP_BASE_SIZE} × `scale` width units, the same box the eraser tests. They are
 * stroked with `strokeWidth` (stamp units), round caps and joins, in the stamp's ink.
 */
export interface StampSymbolDrawing {
  readonly strokeWidth: number;
  readonly polylines: readonly (readonly (readonly [x: number, y: number])[])[];
}

/** Segments of each lens circle: smooth at the largest stamp scale on a 2.732 px screen. */
const LENS_SEGMENTS = 32;

function circle(cx: number, cy: number, r: number): [number, number][] {
  return Array.from({ length: LENS_SEGMENTS + 1 }, (_, index) => {
    const angle = (index / LENS_SEGMENTS) * 2 * Math.PI;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
}

function arc(cx: number, cy: number, r: number, from: number, to: number, segments: number) {
  return Array.from({ length: segments + 1 }, (_, index): [number, number] => {
    const angle = from + ((to - from) * index) / segments;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
}

/**
 * The "glasses" attention mark (forScore's 👓, not in SMuFL): two round lenses, an arched
 * bridge and short temples, inside the stamp box with room for the stroke.
 */
const GLASSES: StampSymbolDrawing = {
  strokeWidth: 0.07,
  polylines: [
    circle(-0.24, 0.06, 0.19),
    circle(0.24, 0.06, 0.19),
    // Bridge: the top of a small circle between the lenses.
    arc(0, 0.06, 0.05, Math.PI, 2 * Math.PI, 8),
    // Temples, from the outer edge of each lens, slightly up and out.
    [
      [-0.43, 0.04],
      [-0.46, -0.12],
    ],
    [
      [0.43, 0.04],
      [0.46, -0.12],
    ],
  ],
};

const SYMBOL_DRAWINGS: Readonly<Record<StampSymbol, StampSymbolDrawing>> = { glasses: GLASSES };

/** The vector drawing of one of the app's own stamps. */
export function stampSymbolDrawing(symbol: StampSymbol): StampSymbolDrawing {
  return SYMBOL_DRAWINGS[symbol];
}
