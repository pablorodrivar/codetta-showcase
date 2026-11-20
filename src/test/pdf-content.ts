import { applyToPoint, type Matrix, multiply } from '../geometry/matrix';

/**
 * A small interpreter of the content streams the annotated-PDF export writes (ADR-014), for
 * tests: it follows `q`/`Q`/`cm` and gives every path and text run in PDF user space, so a test
 * checks where things land without rendering. Only the operators the export uses.
 */

export interface DrawnPath {
  /** `f` (filled) or `S` (stroked). */
  readonly paint: 'f' | 'S';
  /** End points of every segment (and the ends of curves), in PDF user space. */
  readonly points: readonly (readonly [number, number])[];
  readonly fill: string;
  readonly stroke: string;
  /** Line width in PDF units (under the CTM), for stroked paths. */
  readonly lineWidth: number;
  /** The ExtGState in force, if any. */
  readonly graphicsState: string | null;
}

export interface DrawnText {
  /** Where the run starts, on its baseline, in PDF user space. */
  readonly origin: readonly [number, number];
  /** Font size in PDF units, and whether the text stands upright in the frame. */
  readonly size: number;
  /** The direction of the glyphs' up, in PDF user space (unit vector). */
  readonly up: readonly [number, number];
  readonly hex: string;
  readonly font: string;
  readonly fill: string;
}

interface State {
  ctm: Matrix;
  fill: string;
  stroke: string;
  lineWidth: number;
  graphicsState: string | null;
}

export function interpretContent(content: string): {
  readonly paths: DrawnPath[];
  readonly texts: DrawnText[];
} {
  const tokens = content.match(/<[0-9a-f]*>|\/[^\s/<>[\]()]+|[^\s<>/]+/g) ?? [];
  const paths: DrawnPath[] = [];
  const texts: DrawnText[] = [];
  const stack: State[] = [];
  let state: State = {
    ctm: [1, 0, 0, 1, 0, 0],
    fill: '0',
    stroke: '0',
    lineWidth: 1,
    graphicsState: null,
  };
  let operands: string[] = [];
  let points: [number, number][] = [];
  let font = '';
  const number = (index: number) => Number(operands[index]);
  const point = (x: number, y: number) => {
    points.push(applyToPoint(state.ctm, x, y));
  };
  for (const token of tokens) {
    if (/^[-\d.]/.test(token) || token.startsWith('/') || token.startsWith('<')) {
      operands.push(token);
      continue;
    }
    switch (token) {
      case 'q':
        stack.push({ ...state });
        break;
      case 'Q':
        state = stack.pop() ?? state;
        break;
      case 'cm':
        state.ctm = multiply(state.ctm, [0, 1, 2, 3, 4, 5].map(number) as unknown as Matrix);
        break;
      case 'm':
      case 'l':
        point(number(0), number(1));
        break;
      case 'c':
        point(number(4), number(5));
        break;
      case 'h':
        break;
      case 'f':
      case 'S': {
        const scale = Math.hypot(state.ctm[0], state.ctm[1]);
        paths.push({
          paint: token,
          points,
          fill: state.fill,
          stroke: state.stroke,
          lineWidth: state.lineWidth * scale,
          graphicsState: state.graphicsState,
        });
        points = [];
        break;
      }
      case 'rg':
        state.fill = operands.join(' ');
        break;
      case 'RG':
        state.stroke = operands.join(' ');
        break;
      case 'w':
        state.lineWidth = number(0);
        break;
      case 'gs':
        state.graphicsState = operands[0] ?? null;
        break;
      case 'Tf':
        font = operands[0] ?? '';
        break;
      case 'Tm': {
        const tm = [0, 1, 2, 3, 4, 5].map(number) as unknown as Matrix;
        const full = multiply(state.ctm, tm);
        const origin = applyToPoint(full, 0, 0);
        const size = Math.hypot(full[2], full[3]);
        texts.push({
          origin: [origin[0], origin[1]],
          size,
          up: [full[2] / size, full[3] / size],
          hex: '',
          font,
          fill: state.fill,
        });
        break;
      }
      case 'Tj': {
        const last = texts.pop();
        if (last) texts.push({ ...last, hex: (operands[0] ?? '').slice(1, -1) });
        break;
      }
      default:
        // J, j, BT, ET: nothing to track.
        break;
    }
    operands = [];
  }
  return { paths, texts };
}

/** The centre of the points' bounding box. */
export function centre(points: readonly (readonly [number, number])[]): [number, number] {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}
