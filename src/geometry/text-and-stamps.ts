/**
 * How big text and stamps are drawn, shared by every renderer (the app's Skia layer, the web
 * test reader) and the eraser, so they draw and erase the same thing (ADR-008, «Risks and
 * open questions»: the size of SMuFL stamps and text).
 */

/** Line height of text annotations, in font sizes (Inter). */
export const TEXT_LINE_HEIGHT = 1.3;

/**
 * Font size of a SMuFL stamp in stamp boxes. SMuFL glyphs are sized to the staff (one em is
 * four staff spaces), so a dynamic is about a third of an em high; at 2.5 boxes per em a forte
 * is about the box tall. The glyph's ink box is centred on the stamp's point.
 */
export const STAMP_EM_PER_BOX = 2.5;

/**
 * Where the first line's baseline sits below the top of a text annotation, in font sizes: the
 * top of Inter's em box (its ascent over ascent plus descent, `hhea`), which is what a canvas
 * puts at `y` with `textBaseline = 'top'`. The PDF export places each line with it.
 */
export const TEXT_BASELINE = 1984 / (1984 + 494);
