import { FULL_PAGE, type NormalizedRect } from './geometry/view';
import type { Anchor } from './schema/data';

/**
 * Where an anchored annotation lands in the rendered document (ADR-008 §2).
 *
 * In a PDF the page never reflows, so the anchor is the page itself and coordinates are
 * relative to it. ChordPro and MusicXML reflow with the font size, transposition or the
 * screen: there, an anchor will name a line or a bar and each reading engine
 * (`ChordProEngine`, `NotationEngine`) will implement this interface to place it. Nothing
 * implements those kinds yet; `AnchorSchema` only accepts `page`.
 */
export interface AnchorResolver {
  /**
   * The rendered page and the rectangle (normalized to that page) the annotation's
   * coordinates are relative to, or null when the anchor no longer exists (a deleted bar).
   */
  resolve(
    anchor: Anchor | undefined,
    pageIndex: number,
  ): { pageIndex: number; rect: NormalizedRect } | null;
}

/** The PDF engine's resolver: an annotation lives on its own page, coordinates unchanged. */
export const pageAnchorResolver: AnchorResolver = {
  resolve: (_anchor, pageIndex) => ({ pageIndex, rect: FULL_PAGE }),
};
