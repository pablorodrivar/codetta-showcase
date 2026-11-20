import { z } from 'zod';

import { decodePoints, encodePoints, MAX_ENCODED_POINTS_LENGTH } from '../codec/points-codec';
import type { PointBuffer } from '../points';
import { SMUFL_GLYPH_NAMES, STAMP_SYMBOLS } from '../stamps/catalog';
import { HighlighterInkSchema, PenInkSchema } from './ink';

/**
 * `annotations.data` per `type` (ADR-008 §2). Every payload carries `v` (its
 * format version) and may carry an `anchor`. Evolution rules:
 * - a new **optional field** keeps `v`: objects are loose, so an older app reads the row and
 *   keeps the field when it writes `data` back (`encodeAnnotationData`);
 * - anything an older app could not draw or would draw wrong raises `v`: a new `kind`, ink,
 *   glyph, `input` or other enum value, or a changed meaning. An older app reads the row as
 *   "unsupported" and keeps it, never deletes or rewrites it (see `parseAnnotationRow`).
 *
 * Coordinates are normalized 0–1 to the page frame; widths, sizes and distances are in width
 * units (fractions of the frame's width), so they keep their look on any page shape.
 */

export const DATA_VERSION = 1;

/** 0–1 of the page frame. */
export const NormalizedSchema = z.number().min(0).max(1);
export const NormalizedPointSchema = z.tuple([NormalizedSchema, NormalizedSchema]);
export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;

/**
 * Where an annotation is anchored. Today only to its page (`page_index` and normalized
 * coordinates), which is also what a missing `anchor` means. Reflowable documents
 * (ChordPro, MusicXML) will add kinds that anchor to a line or a bar, resolved
 * by their reading engine (`AnchorResolver`); until then an unknown kind is unsupported.
 */
export const AnchorSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('page') })]);
export type Anchor = z.infer<typeof AnchorSchema>;

const base = {
  v: z.literal(DATA_VERSION),
  anchor: AnchorSchema.optional(),
};

/** Stroke width in width units: 0.05 to 30 pt on an A4 page. */
export const StrokeWidthSchema = z.number().min(0.0001).max(0.05);

/** Points as stored (base64url, `points-codec.ts`) ↔ a validated {@link PointBuffer}. */
export const PointsSchema = z.codec(
  z.string().min(1),
  z.custom<PointBuffer>((value) => value instanceof Float32Array, 'Expected a point buffer'),
  {
    decode: (text, context) => {
      const result = decodePoints(text);
      if (result.ok) return result.points;
      context.issues.push({ code: 'custom', message: result.error, input: text });
      return z.NEVER;
    },
    encode: (points) => encodePoints(points),
  },
);

/**
 * Freehand data shared by the pen (`stroke`) and the highlighter (`highlight`).
 *
 * `taperStart` and `taperEnd` say whether each end is an original end of the stroke (true,
 * the default) or a cut left by the partial eraser (false, 1.1): a cut end gets no taper
 * and a flat cap, so the two halves still meet cleanly.
 */
const freehand = {
  ...base,
  width: StrokeWidthSchema,
  /** How it was drawn: the pen has real pressure; finger and mouse simulate it. */
  input: z.enum(['pen', 'touch', 'mouse']),
  points: PointsSchema,
  taperStart: z.boolean().optional(),
  taperEnd: z.boolean().optional(),
};

export const StrokeDataSchema = z.looseObject({ ...freehand, ink: PenInkSchema });
export const HighlightDataSchema = z.looseObject({ ...freehand, ink: HighlighterInkSchema });

export const TextDataSchema = z.looseObject({
  ...base,
  text: z
    .string()
    .max(2000)
    .refine((text) => text.trim().length > 0, 'Text must not be blank'),
  /** Top-left corner of the text box. */
  x: NormalizedSchema,
  y: NormalizedSchema,
  fontSize: z.number().min(0.005).max(0.2),
  ink: PenInkSchema,
  /** Wrap width; without it the text is one line per paragraph. */
  maxWidth: z.number().gt(0).max(1).optional(),
});

const stampPlacement = {
  ...base,
  /** Centre of the stamp. */
  x: NormalizedSchema,
  y: NormalizedSchema,
  scale: z.number().min(0.25).max(8),
  ink: PenInkSchema,
};

export const StampDataSchema = z.discriminatedUnion('kind', [
  z.looseObject({ ...stampPlacement, kind: z.literal('smufl'), glyph: z.enum(SMUFL_GLYPH_NAMES) }),
  z.looseObject({ ...stampPlacement, kind: z.literal('symbol'), symbol: z.enum(STAMP_SYMBOLS) }),
]);

const shapeStyle = { ...base, ink: PenInkSchema, width: StrokeWidthSchema };

export const ShapeDataSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    ...shapeStyle,
    kind: z.literal('line'),
    from: NormalizedPointSchema,
    to: NormalizedPointSchema,
  }),
  /**
   * Slur (ligadura): a curve from `from` to `to`. `bulge` is the height of its apex as a
   * fraction of the chord, positive to the left of `from → to` (above for a slur drawn left
   * to right), negative to the right.
   */
  z.looseObject({
    ...shapeStyle,
    kind: z.literal('slur'),
    from: NormalizedPointSchema,
    to: NormalizedPointSchema,
    bulge: z.number().min(-1).max(1),
  }),
  /**
   * Hairpin (regulador): two lines from `apex` that open to `opening` (width units) at
   * `end`. Crescendo or diminuendo is only which end the apex is on.
   */
  z.looseObject({
    ...shapeStyle,
    kind: z.literal('hairpin'),
    apex: NormalizedPointSchema,
    end: NormalizedPointSchema,
    opening: z.number().gt(0).max(0.2),
  }),
  z.looseObject({
    ...shapeStyle,
    kind: z.literal('rect'),
    x: NormalizedSchema,
    y: NormalizedSchema,
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  }),
]);

export type StrokeData = z.output<typeof StrokeDataSchema>;
export type HighlightData = z.output<typeof HighlightDataSchema>;
export type FreehandData = StrokeData | HighlightData;
export type TextData = z.output<typeof TextDataSchema>;
export type StampData = z.output<typeof StampDataSchema>;
export type ShapeData = z.output<typeof ShapeDataSchema>;

/** The `annotations.type` values (CHECK in the migration). */
export const ANNOTATION_TYPES = [
  'stroke',
  'text',
  'stamp',
  'shape',
  'highlight',
  'link',
  'button',
  'marker',
] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

/** The types this version reads and draws; `link`, `button` and `marker` come later. */
export const DATA_SCHEMAS = {
  stroke: StrokeDataSchema,
  highlight: HighlightDataSchema,
  text: TextDataSchema,
  stamp: StampDataSchema,
  shape: ShapeDataSchema,
} as const;

export type SupportedType = keyof typeof DATA_SCHEMAS;

/** The points as stored, checked only for length: `PointsDecoder` validates them as it goes. */
export const EncodedPointsSchema = z.string().min(1).max(MAX_ENCODED_POINTS_LENGTH);

/**
 * The same schemas with the freehand points left encoded, for preparing a page a few points at
 * a time (ADR-013 §4): everything else is validated here, and the points by `PointsDecoder`.
 */
export const DEFERRED_DATA_SCHEMAS = {
  ...DATA_SCHEMAS,
  stroke: StrokeDataSchema.extend({ points: EncodedPointsSchema }),
  highlight: HighlightDataSchema.extend({ points: EncodedPointsSchema }),
} as const;

export function isSupportedType(type: string): type is SupportedType {
  return Object.hasOwn(DATA_SCHEMAS, type);
}
