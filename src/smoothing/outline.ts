/**
 * Incremental stroke outline, compatible with worklets (ADR-008 §4).
 *
 * Derived from perfect-freehand 1.2.3 by Steve Ruiz (`getStrokePoints` and
 * `getStrokeOutlinePoints`), rewritten so that each new input point costs amortized O(1)
 * instead of recomputing the whole stroke, and so that it can run in a Reanimated worklet
 * on the UI thread, where the live stroke is drawn (ADR-008 §4). On the same input the
 * result is the same polygon as `getStroke` (checked by `outline.test.ts`).
 *
 * How it stays incremental: a point's place in the outline only depends on the points
 * before it, the next point, and how far it is from the end of the stroke (end noise and
 * end taper). Once a point is far enough from the end and its successor is final, its
 * outline points are final too and are "committed"; only the tail is recomputed.
 *
 * Everything works in outline units (`OUTLINE_SCALE`), where the algorithm's absolute
 * thresholds (3 units of end noise, the 1-unit offset of a single point) make sense.
 *
 * Original licence:
 *
 * MIT License
 *
 * Copyright (c) 2021 Stephen Ruiz Ltd
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export interface OutlineOptions {
  /** Diameter, in outline units. */
  readonly size: number;
  /** Effect of pressure on the width, −1 to 1 (0: constant width). */
  readonly thinning: number;
  /** Softens the edges, 0 to 1: drops outline points closer than `size · smoothing`. */
  readonly smoothing: number;
  /** Lag of the drawn line behind the input, 0 to 1. */
  readonly streamline: number;
  /** Derive pressure from speed (finger, mouse) instead of the input's. */
  readonly simulatePressure: boolean;
  /** Taper lengths in outline units, 0 for none. */
  readonly taperStart: number;
  readonly taperEnd: number;
  /** Round caps (true) or flat ones, where not tapered. */
  readonly capStart: boolean;
  readonly capEnd: boolean;
}

const RATE_OF_PRESSURE_CHANGE = 0.275;
const FIXED_PI = Math.PI + 0.0001;
const START_CAP_SEGMENTS = 13;
const END_CAP_SEGMENTS = 29;
const CORNER_CAP_SEGMENTS = 13;
const END_NOISE_THRESHOLD = 3;
const MIN_STREAMLINE_T = 0.15;
const STREAMLINE_T_RANGE = 0.85;
const MIN_RADIUS = 0.01;
const DEFAULT_FIRST_PRESSURE = 0.25;
const DEFAULT_PRESSURE = 0.5;
/** Points that set the starting pressure ("fat start" prevention). */
const INITIAL_PRESSURE_POINTS = 10;

/** Stroke points: the smoothed input, as parallel arrays. */
interface StrokePoints {
  x: number[];
  y: number[];
  pressure: number[];
  /** Unit vector from this point back to the previous one. */
  vx: number[];
  vy: number[];
  distance: number[];
  run: number[];
}

/** State of the outline walk after a given point. */
interface WalkState {
  prevPressure: number;
  prevVx: number;
  prevVy: number;
  prevLx: number;
  prevLy: number;
  prevRx: number;
  prevRy: number;
  prevCorner: boolean;
  /** NaN until the first point sets it. */
  firstRadius: number;
  radius: number;
}

export interface OutlineBuilder {
  readonly options: OutlineOptions;
  /**
   * Raw input, outline units: only the first two points (the special cases of one and two) and
   * the last two (the next stable point and the moving last one) are ever read, so only those
   * are kept (ADR-008 §7).
   */
  inputCount: number;
  firstX: number;
  firstY: number;
  firstPressure: number;
  secondX: number;
  secondY: number;
  previousX: number;
  previousY: number;
  previousPressure: number;
  lastX: number;
  lastY: number;
  lastPressure: number;
  /** Stroke points of every input point but the last (the last one moves until the end). */
  readonly stable: StrokePoints;
  reachedMinimumLength: boolean;
  /** perfect-freehand's running length, which also counts points it skipped. */
  runningLength: number;
  /** Committed outline points, `[x0, y0, x1, y1, …]`. */
  readonly left: number[];
  readonly right: number[];
  /** Stroke points whose outline is committed. */
  committed: number;
  walk: WalkState;
  /** Committed outline points already handed out by `takeCommittedChunks`. */
  takenLeft: number;
  takenRight: number;
  /** Stroke points processed by the outline walk: lets tests check the cost per point. */
  work: number;
}

function emptyStrokePoints(): StrokePoints {
  'worklet';
  return { x: [], y: [], pressure: [], vx: [], vy: [], distance: [], run: [] };
}

function emptyWalk(): WalkState {
  'worklet';
  return {
    prevPressure: 0,
    prevVx: 0,
    prevVy: 0,
    prevLx: 0,
    prevLy: 0,
    prevRx: 0,
    prevRy: 0,
    prevCorner: false,
    firstRadius: Number.NaN,
    radius: 0,
  };
}

export function createOutlineBuilder(options: OutlineOptions): OutlineBuilder {
  'worklet';
  return {
    options,
    inputCount: 0,
    firstX: 0,
    firstY: 0,
    firstPressure: 0,
    secondX: 0,
    secondY: 0,
    previousX: 0,
    previousY: 0,
    previousPressure: 0,
    lastX: 0,
    lastY: 0,
    lastPressure: 0,
    stable: emptyStrokePoints(),
    reachedMinimumLength: false,
    runningLength: 0,
    left: [],
    right: [],
    committed: 0,
    walk: emptyWalk(),
    takenLeft: 0,
    takenRight: 0,
    work: 0,
  };
}

function copyWalk(walk: WalkState): WalkState {
  'worklet';
  return {
    prevPressure: walk.prevPressure,
    prevVx: walk.prevVx,
    prevVy: walk.prevVy,
    prevLx: walk.prevLx,
    prevLy: walk.prevLy,
    prevRx: walk.prevRx,
    prevRy: walk.prevRy,
    prevCorner: walk.prevCorner,
    firstRadius: walk.firstRadius,
    radius: walk.radius,
  };
}

function streamlineFactor(options: OutlineOptions): number {
  'worklet';
  return MIN_STREAMLINE_T + (1 - options.streamline) * STREAMLINE_T_RANGE;
}

function validPressure(pressure: number): boolean {
  'worklet';
  return pressure >= 0;
}

function pushStrokePoint(
  points: StrokePoints,
  x: number,
  y: number,
  pressure: number,
  vx: number,
  vy: number,
  distance: number,
  run: number,
): void {
  'worklet';
  points.x.push(x);
  points.y.push(y);
  points.pressure.push(pressure);
  points.vx.push(vx);
  points.vy.push(vy);
  points.distance.push(distance);
  points.run.push(run);
}

/** perfect-freehand's step for the input point before the last one. */
function appendStablePoint(builder: OutlineBuilder): void {
  'worklet';
  const stable = builder.stable;
  const last = stable.x.length - 1;
  const prevX = stable.x[last] ?? 0;
  const prevY = stable.y[last] ?? 0;
  const t = streamlineFactor(builder.options);
  const inputX = builder.previousX;
  const inputY = builder.previousY;
  const x = prevX + (inputX - prevX) * t;
  const y = prevY + (inputY - prevY) * t;
  if (x === prevX && y === prevY) return;
  const distance = Math.hypot(y - prevY, x - prevX);
  builder.runningLength += distance;
  if (!builder.reachedMinimumLength) {
    if (builder.runningLength < builder.options.size) return;
    builder.reachedMinimumLength = true;
  }
  const dx = prevX - x;
  const dy = prevY - y;
  const length = Math.hypot(dx, dy);
  const pressure = builder.previousPressure;
  pushStrokePoint(
    stable,
    x,
    y,
    validPressure(pressure) ? pressure : DEFAULT_PRESSURE,
    dx / length,
    dy / length,
    distance,
    builder.runningLength,
  );
}

function popStrokePoint(points: StrokePoints): void {
  'worklet';
  points.x.pop();
  points.y.pop();
  points.pressure.pop();
  points.vx.pop();
  points.vy.pop();
  points.distance.pop();
  points.run.pop();
}

function appendLastPoint(
  points: StrokePoints,
  inputX: number,
  inputY: number,
  inputPressure: number,
  runningLength: number,
  t: number,
  complete: boolean,
): void {
  'worklet';
  const last = points.x.length - 1;
  const prevX = points.x[last] ?? 0;
  const prevY = points.y[last] ?? 0;
  const x = complete ? inputX : prevX + (inputX - prevX) * t;
  const y = complete ? inputY : prevY + (inputY - prevY) * t;
  if (x === prevX && y === prevY) return;
  const distance = Math.hypot(y - prevY, x - prevX);
  const dx = prevX - x;
  const dy = prevY - y;
  const length = Math.hypot(dx, dy);
  pushStrokePoint(
    points,
    x,
    y,
    validPressure(inputPressure) ? inputPressure : DEFAULT_PRESSURE,
    dx / length,
    dy / length,
    distance,
    runningLength + distance,
  );
}

/**
 * Appends the last input point to the stable stroke points, in place, and returns whether it
 * was added: pop it with {@link popStrokePoint} after use. The last point follows `complete`
 * (the exact input point when the stroke is done, the streamlined one while drawing).
 * Appending in place keeps every update O(tail) instead of copying the stroke.
 */
function pushLastPoint(builder: OutlineBuilder, complete: boolean): boolean {
  'worklet';
  const stable = builder.stable;
  const before = stable.x.length;
  appendLastPoint(
    stable,
    builder.lastX,
    builder.lastY,
    builder.lastPressure,
    builder.runningLength,
    streamlineFactor(builder.options),
    complete,
  );
  return stable.x.length > before;
}

/** The first point takes the second one's vector, or none for a single point. */
function fixFirstVector(points: StrokePoints): void {
  'worklet';
  if (points.x.length > 1) {
    points.vx[0] = points.vx[1] ?? 0;
    points.vy[0] = points.vy[1] ?? 0;
  } else {
    points.vx[0] = 0;
    points.vy[0] = 0;
  }
}

/** perfect-freehand's `getStrokePoints` for one or two input points. */
function shortStrokePoints(builder: OutlineBuilder, complete: boolean): StrokePoints {
  'worklet';
  const points = emptyStrokePoints();
  const count = builder.inputCount;
  if (count === 0) return points;
  const x0 = builder.firstX;
  const y0 = builder.firstY;
  const p0 = builder.firstPressure;
  // Input after its special cases: two points get three in between (without pressure), one
  // point gets a twin one unit away.
  const xs: number[] = [x0];
  const ys: number[] = [y0];
  const ps: number[] = [p0];
  if (count === 2) {
    const x1 = builder.secondX;
    const y1 = builder.secondY;
    for (let step = 1; step < 5; step++) {
      xs.push(x0 + (x1 - x0) * (step / 4));
      ys.push(y0 + (y1 - y0) * (step / 4));
      ps.push(-1);
    }
  } else {
    xs.push(x0 + 1);
    ys.push(y0 + 1);
    ps.push(p0);
  }
  pushStrokePoint(points, x0, y0, validPressure(p0) ? p0 : DEFAULT_FIRST_PRESSURE, 1, 1, 0, 0);
  const t = streamlineFactor(builder.options);
  const max = xs.length - 1;
  let runningLength = 0;
  let reachedMinimumLength = false;
  for (let index = 1; index <= max; index++) {
    const last = points.x.length - 1;
    const prevX = points.x[last] ?? 0;
    const prevY = points.y[last] ?? 0;
    const inputX = xs[index] ?? 0;
    const inputY = ys[index] ?? 0;
    const isLast = index === max;
    const x = complete && isLast ? inputX : prevX + (inputX - prevX) * t;
    const y = complete && isLast ? inputY : prevY + (inputY - prevY) * t;
    if (x === prevX && y === prevY) continue;
    const distance = Math.hypot(y - prevY, x - prevX);
    runningLength += distance;
    if (!isLast && !reachedMinimumLength) {
      if (runningLength < builder.options.size) continue;
      reachedMinimumLength = true;
    }
    const dx = prevX - x;
    const dy = prevY - y;
    const length = Math.hypot(dx, dy);
    const pressure = ps[index] ?? -1;
    pushStrokePoint(
      points,
      x,
      y,
      validPressure(pressure) ? pressure : DEFAULT_PRESSURE,
      dx / length,
      dy / length,
      distance,
      runningLength,
    );
  }
  fixFirstVector(points);
  return points;
}

function strokeRadius(size: number, thinning: number, pressure: number): number {
  'worklet';
  return size * (0.5 - thinning * (0.5 - pressure));
}

function simulatedPressure(prevPressure: number, distance: number, size: number): number {
  'worklet';
  const sp = Math.min(1, distance / size);
  const rp = Math.min(1, 1 - sp);
  return Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
}

function rotateAround(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angle: number,
  out: number[],
): void {
  'worklet';
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const px = x - cx;
  const py = y - cy;
  out.push(px * c - py * s + cx, px * s + py * c + cy);
}

/** Starting walk state for `points` (needs at least one point). */
function initialWalk(points: StrokePoints, options: OutlineOptions): WalkState {
  'worklet';
  const walk = emptyWalk();
  let pressure = points.pressure[0] ?? 0;
  const initialCount = Math.min(INITIAL_PRESSURE_POINTS, points.x.length);
  for (let index = 0; index < initialCount; index++) {
    const current = options.simulatePressure
      ? simulatedPressure(pressure, points.distance[index] ?? 0, options.size)
      : (points.pressure[index] ?? 0);
    pressure = (pressure + current) / 2;
  }
  walk.prevPressure = pressure;
  walk.radius = strokeRadius(
    options.size,
    options.thinning,
    points.pressure[points.x.length - 1] ?? 0,
  );
  walk.prevVx = points.vx[0] ?? 0;
  walk.prevVy = points.vy[0] ?? 0;
  walk.prevLx = points.x[0] ?? 0;
  walk.prevLy = points.y[0] ?? 0;
  walk.prevRx = walk.prevLx;
  walk.prevRy = walk.prevLy;
  return walk;
}

function easeTaperStart(t: number): number {
  'worklet';
  return t * (2 - t);
}

function easeTaperEnd(t: number): number {
  'worklet';
  const u = t - 1;
  return u * u * u + 1;
}

/** One step of `getStrokeOutlinePoints`' main loop, for the point at `index`. */
function walkPoint(
  points: StrokePoints,
  index: number,
  total: number,
  options: OutlineOptions,
  walk: WalkState,
  left: number[],
  right: number[],
): void {
  'worklet';
  const count = points.x.length;
  const isLast = index === count - 1;
  const run = points.run[index] ?? 0;
  if (!isLast && total - run < END_NOISE_THRESHOLD) return;

  const x = points.x[index] ?? 0;
  const y = points.y[index] ?? 0;
  const vx = points.vx[index] ?? 0;
  const vy = points.vy[index] ?? 0;
  const { size, thinning } = options;
  let pressure = points.pressure[index] ?? 0;
  let radius: number;
  if (thinning) {
    if (options.simulatePressure) {
      pressure = simulatedPressure(walk.prevPressure, points.distance[index] ?? 0, size);
    }
    radius = strokeRadius(size, thinning, pressure);
  } else {
    radius = size / 2;
  }
  if (Number.isNaN(walk.firstRadius)) walk.firstRadius = radius;

  const taperStartStrength =
    run < options.taperStart ? easeTaperStart(run / options.taperStart) : 1;
  const taperEndStrength =
    total - run < options.taperEnd ? easeTaperEnd((total - run) / options.taperEnd) : 1;
  radius = Math.max(MIN_RADIUS, radius * Math.min(taperStartStrength, taperEndStrength));
  walk.radius = radius;

  const nextVx = isLast ? vx : (points.vx[index + 1] ?? 0);
  const nextVy = isLast ? vy : (points.vy[index + 1] ?? 0);
  const nextDpr = isLast ? 1 : vx * nextVx + vy * nextVy;
  const prevDpr = vx * walk.prevVx + vy * walk.prevVy;
  const isCorner = prevDpr < 0 && !walk.prevCorner;
  const isNextCorner = nextDpr < 0;

  if (isCorner || isNextCorner) {
    // Sharp corner: a round cap at this point.
    const ox = walk.prevVy * radius;
    const oy = -walk.prevVx * radius;
    const step = 1 / CORNER_CAP_SEGMENTS;
    for (let t = 0; t <= 1; t += step) {
      rotateAround(x - ox, y - oy, x, y, FIXED_PI * t, left);
      rotateAround(x + ox, y + oy, x, y, FIXED_PI * -t, right);
    }
    walk.prevLx = left[left.length - 2] ?? 0;
    walk.prevLy = left[left.length - 1] ?? 0;
    walk.prevRx = right[right.length - 2] ?? 0;
    walk.prevRy = right[right.length - 1] ?? 0;
    if (isNextCorner) walk.prevCorner = true;
    return;
  }
  walk.prevCorner = false;

  if (isLast) {
    const ox = vy * radius;
    const oy = -vx * radius;
    left.push(x - ox, y - oy);
    right.push(x + ox, y + oy);
    return;
  }

  // Offset along the average of this and the next direction.
  const ax = nextVx + (vx - nextVx) * nextDpr;
  const ay = nextVy + (vy - nextVy) * nextDpr;
  const ox = ay * radius;
  const oy = -ax * radius;
  const minDistance = Math.pow(size * options.smoothing, 2);

  const lx = x - ox;
  const ly = y - oy;
  if (
    index <= 1 ||
    (walk.prevLx - lx) * (walk.prevLx - lx) + (walk.prevLy - ly) * (walk.prevLy - ly) > minDistance
  ) {
    left.push(lx, ly);
    walk.prevLx = lx;
    walk.prevLy = ly;
  }
  const rx = x + ox;
  const ry = y + oy;
  if (
    index <= 1 ||
    (walk.prevRx - rx) * (walk.prevRx - rx) + (walk.prevRy - ry) * (walk.prevRy - ry) > minDistance
  ) {
    right.push(rx, ry);
    walk.prevRx = rx;
    walk.prevRy = ry;
  }
  walk.prevPressure = pressure;
  walk.prevVx = vx;
  walk.prevVy = vy;
}

/**
 * Commits stroke points whose outline can no longer change: their successor is stable, the
 * initial pressure is settled, and every future end of the stroke is far enough away.
 */
function commitFinalPoints(builder: OutlineBuilder): void {
  'worklet';
  const stable = builder.stable;
  const count = stable.x.length;
  if (count < INITIAL_PRESSURE_POINTS) return;
  const options = builder.options;
  // The run of the last stable point bounds every future total length from below.
  const minimumTotal = stable.run[count - 1] ?? 0;
  const margin = Math.max(END_NOISE_THRESHOLD, options.taperEnd);
  if (builder.committed === 0) {
    fixFirstVector(stable);
    builder.walk = initialWalk(stable, options);
  }
  while (
    builder.committed + 1 < count &&
    minimumTotal - (stable.run[builder.committed] ?? 0) >= margin
  ) {
    walkPoint(
      stable,
      builder.committed,
      minimumTotal,
      options,
      builder.walk,
      builder.left,
      builder.right,
    );
    builder.committed++;
    builder.work++;
  }
}

/**
 * Adds an input point (outline units; pressure 0–1, or negative for none). Updates the
 * stable stroke points and commits what became final.
 */
export function addInputPoint(
  builder: OutlineBuilder,
  x: number,
  y: number,
  pressure: number,
): void {
  'worklet';
  const count = builder.inputCount + 1;
  builder.inputCount = count;
  builder.previousX = builder.lastX;
  builder.previousY = builder.lastY;
  builder.previousPressure = builder.lastPressure;
  builder.lastX = x;
  builder.lastY = y;
  builder.lastPressure = pressure;
  if (count === 2) {
    builder.secondX = x;
    builder.secondY = y;
  }
  if (count === 1) {
    builder.firstX = x;
    builder.firstY = y;
    builder.firstPressure = pressure;
    const stable = builder.stable;
    pushStrokePoint(
      stable,
      x,
      y,
      validPressure(pressure) ? pressure : DEFAULT_FIRST_PRESSURE,
      1,
      1,
      0,
      0,
    );
    return;
  }
  // The previous input point is no longer the last one: it becomes a stable point.
  if (count >= 3) {
    appendStablePoint(builder);
    commitFinalPoints(builder);
  }
}

/**
 * The outline's parts. The committed sides are the builder's own arrays (read-only); the tail
 * sides hold what follows them.
 */
export interface OutlineParts {
  readonly committedLeft: readonly number[];
  readonly committedRight: readonly number[];
  readonly tailLeft: readonly number[];
  readonly tailRight: readonly number[];
  readonly startCap: readonly number[];
  readonly endCap: readonly number[];
  /** A dot for a single point (the whole outline), or null. */
  readonly dot: readonly number[] | null;
}

const NO_POINTS: readonly number[] = [];

function startCapOf(
  firstX: number,
  firstY: number,
  leftX: number,
  leftY: number,
  rightX: number,
  rightY: number,
  options: OutlineOptions,
): number[] {
  'worklet';
  const startCap: number[] = [];
  if (options.taperStart) return startCap;
  if (options.capStart) {
    const step = 1 / START_CAP_SEGMENTS;
    for (let t = step; t <= 1; t += step) {
      rotateAround(rightX, rightY, firstX, firstY, FIXED_PI * t, startCap);
    }
  } else {
    const cx = leftX - rightX;
    const cy = leftY - rightY;
    startCap.push(
      firstX - cx * 0.5,
      firstY - cy * 0.5,
      firstX - cx * 0.51,
      firstY - cy * 0.51,
      firstX + cx * 0.51,
      firstY + cy * 0.51,
      firstX + cx * 0.5,
      firstY + cy * 0.5,
    );
  }
  return startCap;
}

function drawDot(cx: number, cy: number, radius: number): number[] {
  'worklet';
  // perfect-freehand starts the circle from a fixed direction: (−1, 1) normalized.
  const length = Math.hypot(-1, 1);
  const startX = cx + (-1 / length) * -radius;
  const startY = cy + (1 / length) * -radius;
  const dot: number[] = [];
  const step = 1 / START_CAP_SEGMENTS;
  for (let t = step; t <= 1; t += step) {
    rotateAround(startX, startY, cx, cy, FIXED_PI * 2 * t, dot);
  }
  return dot;
}

function walkOutline(
  points: StrokePoints,
  options: OutlineOptions,
  walk: WalkState,
  from: number,
  committedLeft: readonly number[],
  committedRight: readonly number[],
  complete: boolean,
  builder: OutlineBuilder,
): OutlineParts {
  'worklet';
  const count = points.x.length;
  const total = points.run[count - 1] ?? 0;
  const tailLeft: number[] = [];
  const tailRight: number[] = [];
  for (let index = from; index < count; index++) {
    walkPoint(points, index, total, options, walk, tailLeft, tailRight);
    builder.work++;
  }
  const firstLeftX = committedLeft.length > 0 ? (committedLeft[0] ?? 0) : (tailLeft[0] ?? 0);
  const firstLeftY = committedLeft.length > 0 ? (committedLeft[1] ?? 0) : (tailLeft[1] ?? 0);
  const firstRightX = committedRight.length > 0 ? (committedRight[0] ?? 0) : (tailRight[0] ?? 0);
  const firstRightY = committedRight.length > 0 ? (committedRight[1] ?? 0) : (tailRight[1] ?? 0);

  if (count === 1) {
    if (!(options.taperStart || options.taperEnd) || complete) {
      const radius =
        Number.isNaN(walk.firstRadius) || walk.firstRadius === 0 ? walk.radius : walk.firstRadius;
      return {
        committedLeft: NO_POINTS,
        committedRight: NO_POINTS,
        tailLeft: [],
        tailRight: [],
        startCap: [],
        endCap: [],
        dot: drawDot(points.x[0] ?? 0, points.y[0] ?? 0, radius),
      };
    }
    return {
      committedLeft,
      committedRight,
      tailLeft,
      tailRight,
      startCap: [],
      endCap: [],
      dot: null,
    };
  }

  const startCap = startCapOf(
    points.x[0] ?? 0,
    points.y[0] ?? 0,
    firstLeftX,
    firstLeftY,
    firstRightX,
    firstRightY,
    options,
  );
  const lastX = points.x[count - 1] ?? 0;
  const lastY = points.y[count - 1] ?? 0;
  // Direction: perpendicular of the reversed last vector.
  const dirX = -(points.vy[count - 1] ?? 0);
  const dirY = points.vx[count - 1] ?? 0;
  const radius = walk.radius;
  const endCap: number[] = [];
  if (options.taperEnd) {
    endCap.push(lastX, lastY);
  } else if (options.capEnd) {
    const startX = lastX + dirX * radius;
    const startY = lastY + dirY * radius;
    const step = 1 / END_CAP_SEGMENTS;
    for (let t = step; t < 1; t += step) {
      rotateAround(startX, startY, lastX, lastY, FIXED_PI * 3 * t, endCap);
    }
  } else {
    endCap.push(
      lastX + dirX * radius,
      lastY + dirY * radius,
      lastX + dirX * radius * 0.99,
      lastY + dirY * radius * 0.99,
      lastX - dirX * radius * 0.99,
      lastY - dirY * radius * 0.99,
      lastX - dirX * radius,
      lastY - dirY * radius,
    );
  }
  return { committedLeft, committedRight, tailLeft, tailRight, startCap, endCap, dot: null };
}

/**
 * The full outline of the current input. `complete` means the stroke is finished (the pen
 * lifted): its last point is the exact input point. Costs O(points after the committed
 * ones), not O(stroke).
 */
export function outlineParts(builder: OutlineBuilder, complete: boolean): OutlineParts {
  'worklet';
  const options = builder.options;
  const inputCount = builder.inputCount;
  if (inputCount === 0 || options.size <= 0) {
    return {
      committedLeft: NO_POINTS,
      committedRight: NO_POINTS,
      tailLeft: [],
      tailRight: [],
      startCap: [],
      endCap: [],
      dot: null,
    };
  }
  if (inputCount <= 2) {
    // perfect-freehand's special cases: tiny, rebuilt from scratch.
    const points = shortStrokePoints(builder, complete);
    return walkOutline(
      points,
      options,
      initialWalk(points, options),
      0,
      NO_POINTS,
      NO_POINTS,
      complete,
      builder,
    );
  }
  const stable = builder.stable;
  const pushed = pushLastPoint(builder, complete);
  const savedVx = stable.vx[0] ?? 0;
  const savedVy = stable.vy[0] ?? 0;
  fixFirstVector(stable);
  const reuse = builder.committed > 0;
  const parts = walkOutline(
    stable,
    options,
    reuse ? copyWalk(builder.walk) : initialWalk(stable, options),
    reuse ? builder.committed : 0,
    reuse ? builder.left : NO_POINTS,
    reuse ? builder.right : NO_POINTS,
    complete,
    builder,
  );
  if (pushed) popStrokePoint(stable);
  stable.vx[0] = savedVx;
  stable.vy[0] = savedVy;
  return parts;
}

/** Appends the points of `side` from `from` (a value index) backwards to `out`. */
function pushReversed(out: number[], side: readonly number[], from: number): void {
  'worklet';
  for (let index = side.length - 2; index >= from; index -= 2) {
    out.push(side[index] ?? 0, side[index + 1] ?? 0);
  }
}

/**
 * An outline polygon being assembled a few points at a time, so a long stroke is never copied in
 * one step (ADR-008 §7, 15/11/2026): `startOutlinePolygon`, then `continueOutlinePolygon` until
 * it returns true; then the polygon is `polygon`. `outlinePolygon` does the same in one go.
 *
 * Only the right side has to be walked, to reverse it, and that goes by parts; the forward parts
 * join it in one native `concat` at the end, which in Hermes costs far less than copying them
 * value by value.
 */
export interface OutlinePolygonAssembly {
  readonly parts: OutlineParts;
  readonly reversedTail: number[];
  readonly reversedCommitted: number[];
  /** Points of the right side reversed so far (tail first, then committed). */
  reversed: number;
  polygon: number[] | null;
}

export function startOutlinePolygon(parts: OutlineParts): OutlinePolygonAssembly {
  'worklet';
  return {
    parts,
    reversedTail: [],
    reversedCommitted: [],
    reversed: 0,
    polygon: parts.dot ? parts.dot.slice() : null,
  };
}

/**
 * Reverses up to `maxPoints` more points of the right side; once it is all reversed, the next
 * call joins the polygon (one native `concat` of the whole outline, so a step of its own) and
 * returns true.
 */
export function continueOutlinePolygon(
  assembly: OutlinePolygonAssembly,
  maxPoints: number,
): boolean {
  'worklet';
  if (assembly.polygon) return true;
  const { parts } = assembly;
  const tailPoints = parts.tailRight.length / 2;
  const total = tailPoints + parts.committedRight.length / 2;
  if (assembly.reversed >= total) {
    assembly.polygon = parts.committedLeft.concat(
      parts.tailLeft,
      parts.endCap,
      assembly.reversedTail,
      assembly.reversedCommitted,
      parts.startCap,
    );
    return true;
  }
  const end = Math.min(total, assembly.reversed + (maxPoints >= 1 ? Math.floor(maxPoints) : 1));
  // Like `pushReversed`: the pairs from the last one back, tail first.
  for (let point = assembly.reversed; point < end; point++) {
    if (point < tailPoints) {
      const index = parts.tailRight.length - 2 - point * 2;
      assembly.reversedTail.push(parts.tailRight[index] ?? 0, parts.tailRight[index + 1] ?? 0);
    } else {
      const index = parts.committedRight.length - 2 - (point - tailPoints) * 2;
      assembly.reversedCommitted.push(
        parts.committedRight[index] ?? 0,
        parts.committedRight[index + 1] ?? 0,
      );
    }
  }
  assembly.reversed = end;
  return false;
}

/** Points of the right side still to reverse, and of the whole polygon. */
export function outlinePolygonProgress(assembly: OutlinePolygonAssembly): {
  readonly toReverse: number;
  readonly total: number;
} {
  'worklet';
  const { parts } = assembly;
  const right = (parts.tailRight.length + parts.committedRight.length) / 2;
  const total =
    (parts.committedLeft.length +
      parts.tailLeft.length +
      parts.endCap.length +
      parts.tailRight.length +
      parts.committedRight.length +
      parts.startCap.length) /
    2;
  return { toReverse: assembly.polygon ? 0 : right - assembly.reversed, total };
}

/**
 * The outline as one polygon, `[x0, y0, …]`, in perfect-freehand's order. Fill it nonzero.
 * In one go, as before the parts (the live stroke and `finishStroke` run it on the UI runtime);
 * a test checks it against {@link continueOutlinePolygon}.
 */
export function outlinePolygon(parts: OutlineParts): number[] {
  'worklet';
  if (parts.dot) return parts.dot.slice();
  const polygon = parts.committedLeft.concat(parts.tailLeft, parts.endCap);
  pushReversed(polygon, parts.tailRight, 0);
  pushReversed(polygon, parts.committedRight, 0);
  for (const value of parts.startCap) polygon.push(value);
  return polygon;
}

/**
 * Polygons for the outline committed since the last call, to append to the live stroke's
 * path instead of rebuilding it: the path grows by small pieces, and each frame only
 * redraws the tail ({@link tailPolygon}). With nonzero fill the pieces add up to the same
 * shape as {@link outlinePolygon}: the edges they share run in opposite directions.
 */
export function takeCommittedChunks(builder: OutlineBuilder): number[][] {
  'worklet';
  const left = builder.left;
  const right = builder.right;
  if (left.length === 0 || right.length === 0) return [];
  if (left.length === builder.takenLeft && right.length === builder.takenRight) return [];
  const first = builder.takenLeft === 0;
  // Each piece starts at the last point of the previous one on each side.
  const chunk = left.slice(first ? 0 : builder.takenLeft - 2);
  pushReversed(chunk, right, first ? 0 : builder.takenRight - 2);
  if (first) {
    // Committed points imply ten stable points or more: the start cap is final.
    const stable = builder.stable;
    const startCap = startCapOf(
      stable.x[0] ?? 0,
      stable.y[0] ?? 0,
      left[0] ?? 0,
      left[1] ?? 0,
      right[0] ?? 0,
      right[1] ?? 0,
      builder.options,
    );
    for (const value of startCap) chunk.push(value);
  }
  builder.takenLeft = left.length;
  builder.takenRight = right.length;
  return [chunk];
}

/**
 * What {@link takeCommittedChunks} has not handed out: from the last taken point of each side,
 * around the end cap and back (or the whole outline while nothing has been taken).
 */
export function tailPolygon(builder: OutlineBuilder, complete: boolean): number[] {
  'worklet';
  const parts = outlineParts(builder, complete);
  if (parts.dot || builder.takenLeft === 0) return outlinePolygon(parts);
  const polygon = parts.committedLeft.slice(builder.takenLeft - 2);
  for (const value of parts.tailLeft) polygon.push(value);
  for (const value of parts.endCap) polygon.push(value);
  pushReversed(polygon, parts.tailRight, 0);
  pushReversed(polygon, parts.committedRight, builder.takenRight - 2);
  return polygon;
}
