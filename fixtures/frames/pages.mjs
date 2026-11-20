// The pages of frames.pdf (generate.mjs) and their marks, shared with the tests that probe
// the rendered pixels.

/** Colours as PDF RGB fill operators and as 0–255 for pixel probes. */
export const COLOURS = {
  red: [1, 0, 0],
  blue: [0, 0, 1],
  green: [0, 0.6, 0],
  magenta: [1, 0, 1],
};

/**
 * Each page: its boxes, /Rotate, and squares (x, y, side in PDF user space, origin at the
 * bottom left). `visible: false` squares lie inside the MediaBox but outside the CropBox:
 * a renderer that draws the MediaBox shows them, one that draws the frame does not.
 */
export const PAGES = [
  {
    mediaBox: [0, 0, 600, 800],
    cropBox: [50, 100, 550, 700],
    rotate: 90,
    squares: [
      { colour: 'red', x: 80, y: 640, side: 40, visible: true },
      { colour: 'blue', x: 470, y: 130, side: 40, visible: true },
      { colour: 'magenta', x: 5, y: 5, side: 30, visible: false },
    ],
  },
  {
    mediaBox: [0, 0, 595, 842],
    cropBox: null,
    rotate: 0,
    squares: [{ colour: 'green', x: 277, y: 401, side: 40, visible: true }],
  },
  {
    mediaBox: [0, 0, 595, 842],
    cropBox: [0, 0, 595, 421],
    rotate: 180,
    squares: [
      { colour: 'blue', x: 40, y: 40, side: 50, visible: true },
      { colour: 'magenta', x: 270, y: 700, side: 50, visible: false },
    ],
  },
];
