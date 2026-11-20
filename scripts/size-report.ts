/// <reference types="node" />
/**
 * `pnpm size-report`: bytes per point of each candidate encoding
 * on the synthetic strokes (and on any real capture in `fixtures/strokes/*.json`, an array
 * of `{ name, input, points: Point[] }`). The table goes into ADR-008 §3.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { encodeBase64url } from '../src/codec/base64url';
import { encodePoints } from '../src/codec/points-codec';
import {
  COORDINATE_STEPS,
  type Point,
  POINT_STRIDE,
  PRESSURE_STEPS,
  toPointBuffer,
} from '../src/points';
import { type SyntheticStroke, syntheticStrokes } from '../src/test/synthetic-strokes';

const FIXTURES = join(import.meta.dirname, '../fixtures/strokes');

function realCaptures(): SyntheticStroke[] {
  let files: string[];
  try {
    files = readdirSync(FIXTURES).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  return files.flatMap(
    (file) => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as SyntheticStroke[],
  );
}

function quantizedInts(points: Point[]): number[][] {
  const buffer = toPointBuffer(points);
  const rows: number[][] = [];
  for (let offset = 0; offset < buffer.length; offset += POINT_STRIDE) {
    rows.push([
      Math.round((buffer[offset] ?? 0) * COORDINATE_STEPS),
      Math.round((buffer[offset + 1] ?? 0) * COORDINATE_STEPS),
      Math.round((buffer[offset + 2] ?? 0) * PRESSURE_STEPS),
      Math.round(buffer[offset + 3] ?? 0),
    ]);
  }
  return rows;
}

function varintLength(value: number): number {
  let length = 1;
  let rest = value;
  while (rest >= 0x80) {
    rest = Math.floor(rest / 0x80);
    length++;
  }
  return length;
}

const zigzag = (value: number) => (value >= 0 ? value * 2 : -value * 2 - 1);

/** Second-order deltas for x and y (first-order for pressure and t), varints, base64url. */
function secondOrderLength(rows: number[][]): number {
  let bytes = 2 + varintLength(rows.length);
  let previous = [0, 0, 0, 0];
  let previousDelta = [0, 0];
  for (const row of rows) {
    const delta = [(row[0] ?? 0) - (previous[0] ?? 0), (row[1] ?? 0) - (previous[1] ?? 0)];
    bytes += varintLength(zigzag((delta[0] ?? 0) - (previousDelta[0] ?? 0)));
    bytes += varintLength(zigzag((delta[1] ?? 0) - (previousDelta[1] ?? 0)));
    bytes += varintLength(zigzag((row[2] ?? 0) - (previous[2] ?? 0)));
    bytes += varintLength((row[3] ?? 0) - (previous[3] ?? 0));
    previous = row;
    previousDelta = delta;
  }
  return Math.ceil((bytes * 4) / 3);
}

function jsonIntDeltas(rows: number[][]): number {
  let previous = [0, 0, 0, 0];
  const flat: number[] = [];
  for (const row of rows) {
    row.forEach((value, index) => flat.push(value - (previous[index] ?? 0)));
    previous = row;
  }
  return JSON.stringify(flat).length;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

it('prints the size table', () => {
  const strokes = [...syntheticStrokes(1), ...syntheticStrokes(2), ...realCaptures()];
  const variants: Record<string, (points: Point[]) => number> = {
    'JSON, float64 as captured': (points) => JSON.stringify(points).length,
    'JSON, decimals on the grid': (points) =>
      JSON.stringify(
        toPointBuffer(points).reduce<number[]>((all, value) => {
          all.push(Number(value.toPrecision(6)));
          return all;
        }, []),
      ).length,
    'JSON, integer deltas': (points) => jsonIntDeltas(quantizedInts(points)),
    'varint + base64url, deltas (v1)': (points) => encodePoints(toPointBuffer(points)).length,
    'varint + base64url, 2nd-order x/y': (points) => secondOrderLength(quantizedInts(points)),
  };

  const totalPoints = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  const lines = [
    `${strokes.length} strokes, ${totalPoints} points (median ${percentile(
      strokes.map((s) => s.points.length),
      0.5,
    )} per stroke)`,
    '| Encoding | chars/point | median chars/stroke | p95 chars/stroke | 50-pt stroke |',
    '|---|---|---|---|---|',
  ];
  for (const [name, measure] of Object.entries(variants)) {
    const sizes = strokes.map((stroke) => measure(stroke.points));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const perPoint = total / totalPoints;
    lines.push(
      `| ${name} | ${perPoint.toFixed(1)} | ${percentile(sizes, 0.5)} | ${percentile(sizes, 0.95)} | ${Math.round(perPoint * 50)} |`,
    );
  }
  // Also check base64url of nothing is what we expect, so the table is not silently off.
  if (encodeBase64url(new Uint8Array(3)).length !== 4) throw new Error('base64url');
  console.log(lines.join('\n'));
});
