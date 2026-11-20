# Real strokes

Captures of real strokes for `pnpm size-report` (ADR-008 §3). Each `*.json` file is an array of:

```json
{
  "name": "fingering",
  "input": "pen",
  "points": [
    [0.4123, 0.2251, 0.31, 0],
    [0.4125, 0.2248, 0.34, 4]
  ]
}
```

- `input`: `pen`, `touch` or `mouse`.
- `points`: `[x, y, pressure, t]`, with `x` and `y` normalized 0–1 to the page frame, pressure 0–1 and `t` in ms since the stroke started, as the capture delivers them (`addSample`).

None are recorded yet: until the app's measuring screen records them, `size-report` and `perf-report` use synthetic strokes only (`src/test/synthetic-strokes.ts`).
