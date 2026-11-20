import { z } from 'zod';

import { annotationInks, highlighterInks, highlighterOpacity } from '../tokens';

/**
 * Annotations store an ink *key*, never a hex value (ADR-008 §2.1): the
 * page aspects (Normal, Paper, Night) can remap every ink to stay distinguishable, and a
 * palette change reaches old annotations too.
 *
 * Pen and highlighter inks are separate sets (both have a `green` and a `blue`), so the
 * type of the annotation says which one a key belongs to.
 */
export const PEN_INKS = Object.keys(annotationInks) as (keyof typeof annotationInks)[];
export const HIGHLIGHTER_INKS = Object.keys(highlighterInks) as (keyof typeof highlighterInks)[];

export const PenInkSchema = z.enum(PEN_INKS);
export const HighlighterInkSchema = z.enum(HIGHLIGHTER_INKS);

export type PenInk = z.infer<typeof PenInkSchema>;
export type HighlighterInk = z.infer<typeof HighlighterInkSchema>;

/** Colour of a pen ink on the Normal aspect; Paper and Night are pending. */
export function penInkColor(ink: PenInk): string {
  return annotationInks[ink];
}

/** Colour and opacity of a highlighter ink on the Normal aspect. */
export function highlighterInkColor(ink: HighlighterInk): { color: string; opacity: number } {
  return { color: highlighterInks[ink], opacity: highlighterOpacity };
}
