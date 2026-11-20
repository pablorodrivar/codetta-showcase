import { z } from 'zod';

import {
  ANNOTATION_TYPES,
  type AnnotationType,
  DATA_SCHEMAS,
  DATA_VERSION,
  DEFERRED_DATA_SCHEMAS,
  type HighlightData,
  isSupportedType,
  type ShapeData,
  type StampData,
  type StrokeData,
  type SupportedType,
  type TextData,
} from './data';
import { PenInkSchema } from './ink';

/**
 * Rows of `annotation_layers` and `annotations` as the app reads them: from the
 * local SQLite (PowerSync: booleans as 0/1, JSON as text) or from an exported file.
 */

const IdSchema = z.uuid();
/** SQLite gives 0 and 1; Postgres and JSON give booleans. */
const BooleanSchema = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean);
const TimestampSchema = z.string().min(1);

/** Code points, like Postgres `char_length` (not UTF-16 units, not graphemes). */
function codePointLength(text: string): number {
  // A string iterates by code point.
  return Array.from(text).length;
}

export const LAYER_KINDS = ['personal', 'group', 'teacher'] as const;
/** `annotation_layers.purpose`: the "Analysis" layer arrives in 1.1 with its migration. */
export const LAYER_PURPOSES = ['analysis'] as const;

export const LayerRowSchema = z.object({
  id: IdSchema,
  owner_id: IdSchema,
  score_id: IdSchema,
  /**
   * The migration's CHECK, exactly: `btrim` only strips spaces, and `char_length` counts code
   * points, not UTF-16 units, so a name with an emoji or a newline the database accepts is
   * accepted here too.
   */
  name: z
    .string()
    .refine(
      (name) =>
        name !== '' && name.replace(/^ +| +$/g, '') === name && codePointLength(name) <= 100,
      'Name must be 1–100 characters without surrounding spaces',
    ),
  /** An ink key (ADR-008 §2). Any other text, or none, means the default ink. */
  color: PenInkSchema.nullable().catch(null),
  visible: BooleanSchema,
  locked: BooleanSchema,
  kind: z.enum(LAYER_KINDS),
  /** The column does not exist yet (1.1): missing reads as null. */
  /** A purpose this version does not know (from a newer app) reads as none. */
  purpose: z.enum(LAYER_PURPOSES).nullable().default(null).catch(null),
  position: z
    .string()
    .regex(/^[0-9A-Za-z]+$/)
    .max(255),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  deleted_at: TimestampSchema.nullable(),
});

export type LayerRow = z.output<typeof LayerRowSchema>;

const AnnotationRowBaseSchema = z.object({
  id: IdSchema,
  owner_id: IdSchema,
  score_id: IdSchema,
  layer_id: IdSchema,
  page_index: z.int().min(0),
  type: z.enum(ANNOTATION_TYPES),
  z: z.int(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  deleted_at: TimestampSchema.nullable(),
});

export type AnnotationRowBase = z.output<typeof AnnotationRowBaseSchema>;

/**
 * Every column of an annotation row but `data` (the first phase of the reader's read, ADR-013
 * §5): what the history's guard, the page's draw order and the cache keys need, without reading
 * or parsing the JSON. Never throws; `data` is not looked at, so a row with a bad `data` is
 * still a valid head (it is reported when its `data` is read).
 */
export function parseAnnotationHead(
  raw: unknown,
):
  | { status: 'ok'; head: AnnotationRowBase }
  | { status: 'invalid'; id: string | null; issues: string[] } {
  const parsed = AnnotationRowBaseSchema.safeParse(raw);
  return parsed.success
    ? { status: 'ok', head: parsed.data }
    : { status: 'invalid', id: idOf(raw), issues: issuesOf(parsed.error) };
}

interface DataByType {
  stroke: StrokeData;
  highlight: HighlightData;
  text: TextData;
  stamp: StampData;
  shape: ShapeData;
}

/** A row this version understands, with its `data` decoded (points as a buffer). */
export type Annotation = {
  [T in SupportedType]: Omit<AnnotationRowBase, 'type'> & { type: T; data: DataByType[T] };
}[SupportedType];

export type UnsupportedReason = 'type' | 'version' | 'anchor';

export type ParsedAnnotation =
  | { readonly status: 'ok'; readonly annotation: Annotation }
  /** Valid row from a newer app (or a later phase): keep it, do not draw or erase it. */
  | {
      readonly status: 'unsupported';
      readonly row: AnnotationRowBase;
      readonly reason: UnsupportedReason;
    }
  | { readonly status: 'invalid'; readonly id: string | null; readonly issues: string[] };

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

function idOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string') {
    return raw.id;
  }
  return null;
}

/**
 * Validates a row at the boundary (Zod at every boundary) and never throws, so a
 * bad row can be logged and skipped while the rest of the page draws.
 */
export function parseAnnotationRow(raw: unknown): ParsedAnnotation {
  const parsed = parseRow(raw, DATA_SCHEMAS);
  return parsed.status === 'ok'
    ? { status: 'ok', annotation: parsed.annotation as Annotation }
    : parsed;
}

/**
 * A freehand annotation whose points are still encoded (`EncodedPointsSchema`): its data type
 * comes from the deferred schemas, so it keeps every field of the real one.
 */
export type DeferredFreehand = {
  [T in 'stroke' | 'highlight']: Omit<AnnotationRowBase, 'type'> & {
    type: T;
    data: z.output<(typeof DEFERRED_DATA_SCHEMAS)[T]>;
  };
}['stroke' | 'highlight'];

export type DeferredAnnotation =
  | { readonly status: 'ok'; readonly annotation: Annotation }
  /** Valid except for the points, which the caller decodes with `PointsDecoder`. */
  | { readonly status: 'points'; readonly annotation: DeferredFreehand }
  | Exclude<ParsedAnnotation, { status: 'ok' }>;

/**
 * Like {@link parseAnnotationRow}, with the same checks, but leaves the points of strokes and
 * highlights encoded, so a long stroke can be decoded over several frames (ADR-013 §4).
 */
export function parseAnnotationRowDeferred(raw: unknown): DeferredAnnotation {
  const parsed = parseRow(raw, DEFERRED_DATA_SCHEMAS);
  if (parsed.status !== 'ok') return parsed;
  const { annotation } = parsed;
  return annotation.type === 'stroke' || annotation.type === 'highlight'
    ? { status: 'points', annotation: annotation as DeferredFreehand }
    : { status: 'ok', annotation: annotation as Annotation };
}

function parseRow(
  raw: unknown,
  schemas: typeof DATA_SCHEMAS | typeof DEFERRED_DATA_SCHEMAS,
):
  | { readonly status: 'ok'; readonly annotation: Annotation | DeferredFreehand }
  | Exclude<ParsedAnnotation, { status: 'ok' }> {
  const base = AnnotationRowBaseSchema.safeParse(raw);
  if (!base.success) {
    return { status: 'invalid', id: idOf(raw), issues: issuesOf(base.error) };
  }
  const row = base.data;
  let data: unknown = (raw as { data?: unknown }).data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { status: 'invalid', id: row.id, issues: ['data: not JSON'] };
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { status: 'invalid', id: row.id, issues: ['data: expected an object'] };
  }

  if (!isSupportedType(row.type)) return { status: 'unsupported', row, reason: 'type' };
  const version = (data as { v?: unknown }).v;
  if (typeof version === 'number' && Number.isInteger(version) && version > DATA_VERSION) {
    return { status: 'unsupported', row, reason: 'version' };
  }
  const anchor = (data as { anchor?: unknown }).anchor;
  if (
    typeof anchor === 'object' &&
    anchor !== null &&
    'kind' in anchor &&
    typeof anchor.kind === 'string' &&
    anchor.kind !== 'page'
  ) {
    return { status: 'unsupported', row, reason: 'anchor' };
  }

  // The schema is picked by `row.type`, so its input type is one member of the union; `data`
  // is still unknown here, which is exactly what `safeDecode` validates.
  const parsed = schemas[row.type].safeDecode(data as never);
  if (!parsed.success) {
    return {
      status: 'invalid',
      id: row.id,
      issues: issuesOf(parsed.error).map((issue) => `data.${issue}`),
    };
  }
  return {
    status: 'ok',
    annotation: { ...row, type: row.type, data: parsed.data } as Annotation | DeferredFreehand,
  };
}

/** The `data` object to write for an annotation (points encoded), ready for `JSON.stringify`. */
export function encodeAnnotationData(annotation: Pick<Annotation, 'type' | 'data'>): object {
  // Each schema encodes its own type's data; the union cannot express that pairing.
  const schema = DATA_SCHEMAS[annotation.type] as unknown as z.ZodType<unknown, object>;
  return schema.encode(annotation.data);
}

export function parseLayerRow(
  raw: unknown,
): { status: 'ok'; layer: LayerRow } | { status: 'invalid'; id: string | null; issues: string[] } {
  const parsed = LayerRowSchema.safeParse(raw);
  return parsed.success
    ? { status: 'ok', layer: parsed.data }
    : { status: 'invalid', id: idOf(raw), issues: issuesOf(parsed.error) };
}

export type { AnnotationType };
