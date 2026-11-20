import { describe, expect, it } from 'vitest';

import {
  canRedo,
  canUndo,
  type Command,
  EMPTY_HISTORY,
  type GetCurrentRow,
  type History,
  type HistoryTable,
  type Mutation,
  nextRedoPage,
  nextUndoPage,
  record,
  redo,
  sameValue,
  undo,
} from './history';

/** An in-memory table that applies mutations, standing in for the local database. */
class FakeDb {
  rows = new Map<string, { deleted: boolean; values: Record<string, unknown> }>();

  get: GetCurrentRow = (table, id) => this.rows.get(`${table}:${id}`);

  insert(table: HistoryTable, id: string, values: Record<string, unknown> = {}): void {
    this.rows.set(`${table}:${id}`, { deleted: false, values: { ...values } });
  }

  apply(mutations: readonly Mutation[]): void {
    for (const mutation of mutations) {
      const row = this.rows.get(`${mutation.table}:${mutation.id}`);
      if (!row) throw new Error(`missing ${mutation.id}`);
      if (mutation.op === 'softDelete') row.deleted = true;
      if (mutation.op === 'restore') row.deleted = false;
      if (mutation.op === 'patch') Object.assign(row.values, mutation.values);
    }
  }
}

const annotation = (id: string, pageIndex = 0) => ({
  table: 'annotations' as const,
  id,
  pageIndex,
});
const layer = (id: string) => ({ table: 'annotation_layers' as const, id, pageIndex: null });

function undoAndApply(history: History, db: FakeDb): History {
  const step = undo(history, db.get);
  db.apply(step.mutations);
  return step.history;
}

function redoAndApply(history: History, db: FakeDb): History {
  const step = redo(history, db.get);
  db.apply(step.mutations);
  return step.history;
}

describe('history', () => {
  it('starts empty', () => {
    expect(canUndo(EMPTY_HISTORY)).toBe(false);
    expect(canRedo(EMPTY_HISTORY)).toBe(false);
    expect(undo(EMPTY_HISTORY, () => undefined)).toEqual({
      history: EMPTY_HISTORY,
      mutations: [],
      skipped: [],
      pageIndex: null,
    });
    expect(redo(EMPTY_HISTORY, () => undefined).mutations).toEqual([]);
  });

  it('undoes an addition with a soft delete and redoes it with a restore', () => {
    const db = new FakeDb();
    db.insert('annotations', 'a');
    let history = record(EMPTY_HISTORY, { kind: 'add', row: annotation('a', 3) });
    const step = undo(history, db.get);
    expect(step.mutations).toEqual([{ op: 'softDelete', table: 'annotations', id: 'a' }]);
    expect(step.pageIndex).toBe(3);
    db.apply(step.mutations);
    history = step.history;
    expect(canRedo(history)).toBe(true);
    const again = redo(history, db.get);
    expect(again.mutations).toEqual([{ op: 'restore', table: 'annotations', id: 'a' }]);
    db.apply(again.mutations);
    expect(db.get('annotations', 'a')?.deleted).toBe(false);
  });

  it('undoes a removal with a restore', () => {
    const db = new FakeDb();
    db.insert('annotations', 'a');
    db.apply([{ op: 'softDelete', table: 'annotations', id: 'a' }]);
    const history = record(EMPTY_HISTORY, { kind: 'remove', row: annotation('a') });
    expect(undo(history, db.get).mutations).toEqual([
      { op: 'restore', table: 'annotations', id: 'a' },
    ]);
  });

  it('undoes and redoes an update with its before and after values', () => {
    const db = new FakeDb();
    db.insert('annotation_layers', 'l', { name: 'Digitaciones', color: 'red' });
    db.apply([{ op: 'patch', table: 'annotation_layers', id: 'l', values: { name: 'Arcos' } }]);
    let history = record(EMPTY_HISTORY, {
      kind: 'update',
      row: layer('l'),
      before: { name: 'Digitaciones' },
      after: { name: 'Arcos' },
    });
    history = undoAndApply(history, db);
    expect(db.get('annotation_layers', 'l')?.values).toEqual({
      name: 'Digitaciones',
      color: 'red',
    });
    history = redoAndApply(history, db);
    expect(db.get('annotation_layers', 'l')?.values.name).toBe('Arcos');
    expect(canUndo(history)).toBe(true);
  });

  it('treats a group as one step, undone backwards and redone forwards', () => {
    const db = new FakeDb();
    for (const id of ['a', 'b', 'c']) {
      db.insert('annotations', id);
      db.apply([{ op: 'softDelete', table: 'annotations', id }]);
    }
    const swipe: Command = {
      kind: 'group',
      commands: [
        { kind: 'remove', row: annotation('a', 2) },
        { kind: 'remove', row: annotation('b', 2) },
        { kind: 'remove', row: annotation('c', 2) },
      ],
    };
    let history = record(EMPTY_HISTORY, swipe);
    const step = undo(history, db.get);
    expect(step.mutations.map((mutation) => mutation.id)).toEqual(['c', 'b', 'a']);
    expect(step.pageIndex).toBe(2);
    db.apply(step.mutations);
    history = step.history;
    const again = redo(history, db.get);
    expect(again.mutations.map((mutation) => mutation.id)).toEqual(['a', 'b', 'c']);
    expect(again.history.undo).toEqual([swipe]);
  });

  it('ignores an empty group', () => {
    expect(record(EMPTY_HISTORY, { kind: 'group', commands: [] })).toBe(EMPTY_HISTORY);
  });

  it('clears redo on a new change', () => {
    const db = new FakeDb();
    db.insert('annotations', 'a');
    db.insert('annotations', 'b');
    let history = record(EMPTY_HISTORY, { kind: 'add', row: annotation('a') });
    history = undoAndApply(history, db);
    history = record(history, { kind: 'add', row: annotation('b') });
    expect(canRedo(history)).toBe(false);
    expect(history.undo).toHaveLength(1);
  });

  it('is unlimited and survives long undo/redo sequences', () => {
    const db = new FakeDb();
    let history = EMPTY_HISTORY;
    for (let index = 0; index < 2000; index++) {
      db.insert('annotations', `s${index}`);
      history = record(history, { kind: 'add', row: annotation(`s${index}`, index % 7) });
    }
    for (let index = 0; index < 2000; index++) history = undoAndApply(history, db);
    expect([...db.rows.values()].every((row) => row.deleted)).toBe(true);
    for (let index = 0; index < 1500; index++) history = redoAndApply(history, db);
    expect([...db.rows.values()].filter((row) => !row.deleted)).toHaveLength(1500);
    expect(history.undo).toHaveLength(1500);
    expect(history.redo).toHaveLength(500);
  });

  it('does not mutate the history it is given', () => {
    const db = new FakeDb();
    db.insert('annotations', 'a');
    const history = record(EMPTY_HISTORY, { kind: 'add', row: annotation('a') });
    const frozen = structuredClone(history);
    undo(history, db.get);
    expect(history).toEqual(frozen);
  });

  it('tells which page the next step changes', () => {
    let history = record(EMPTY_HISTORY, { kind: 'add', row: layer('l') });
    expect(nextUndoPage(history)).toBeNull();
    history = record(history, {
      kind: 'group',
      commands: [
        { kind: 'add', row: layer('m') },
        { kind: 'add', row: annotation('a', 5) },
      ],
    });
    expect(nextUndoPage(history)).toBe(5);
    expect(nextRedoPage(history)).toBeNull();
  });

  it('lets a group touch the same row twice (a stroke cut, then one of its pieces)', () => {
    const db = new FakeDb();
    // The partial eraser cuts A into A1 and A2, then cuts A1 into A11 and A12, in one swipe.
    for (const id of ['a', 'a1', 'a2', 'a11', 'a12']) db.insert('annotations', id);
    db.apply([
      { op: 'softDelete', table: 'annotations', id: 'a' },
      { op: 'softDelete', table: 'annotations', id: 'a1' },
    ]);
    const swipe: Command = {
      kind: 'group',
      commands: [
        { kind: 'add', row: annotation('a1') },
        { kind: 'add', row: annotation('a2') },
        { kind: 'remove', row: annotation('a') },
        { kind: 'add', row: annotation('a11') },
        { kind: 'add', row: annotation('a12') },
        { kind: 'remove', row: annotation('a1') },
      ],
    };
    const live = () =>
      [...db.rows.entries()]
        .filter(([, row]) => !row.deleted)
        .map(([key]) => key.replace('annotations:', ''))
        .sort();
    expect(live()).toEqual(['a11', 'a12', 'a2']);
    let history = record(EMPTY_HISTORY, swipe);
    const step = undo(history, db.get);
    expect(step.skipped).toEqual([]);
    db.apply(step.mutations);
    history = step.history;
    // Back to the original stroke only: no duplicated ink.
    expect(live()).toEqual(['a']);
    const again = redo(history, db.get);
    expect(again.skipped).toEqual([]);
    db.apply(again.mutations);
    expect(live()).toEqual(['a11', 'a12', 'a2']);
  });

  it('refuses an update whose before and after hold different columns', () => {
    expect(() =>
      record(EMPTY_HISTORY, {
        kind: 'group',
        commands: [
          { kind: 'update', row: layer('l'), before: { name: 'A' }, after: { color: 'red' } },
        ],
      }),
    ).toThrow(RangeError);
  });

  describe('guard', () => {
    it('skips an undo whose row changed since', () => {
      const db = new FakeDb();
      db.insert('annotation_layers', 'l', { name: 'Arcos' });
      let history = record(EMPTY_HISTORY, {
        kind: 'update',
        row: layer('l'),
        before: { name: 'Digitaciones' },
        after: { name: 'Arcos' },
      });
      // Another device renamed it again.
      db.apply([{ op: 'patch', table: 'annotation_layers', id: 'l', values: { name: 'Pedal' } }]);
      const step = undo(history, db.get);
      expect(step.mutations).toEqual([]);
      expect(step.skipped).toHaveLength(1);
      expect(step.pageIndex).toBeNull();
      history = step.history;
      // Dropped, not moved to redo.
      expect(history).toEqual(EMPTY_HISTORY);
    });

    it('skips an addition that is already gone and a removal already restored', () => {
      const db = new FakeDb();
      db.insert('annotations', 'a');
      db.apply([{ op: 'softDelete', table: 'annotations', id: 'a' }]);
      expect(
        undo(record(EMPTY_HISTORY, { kind: 'add', row: annotation('a') }), db.get).skipped,
      ).toHaveLength(1);
      db.insert('annotations', 'b');
      expect(
        undo(record(EMPTY_HISTORY, { kind: 'remove', row: annotation('b') }), db.get).skipped,
      ).toHaveLength(1);
      expect(
        undo(record(EMPTY_HISTORY, { kind: 'add', row: annotation('missing') }), db.get).skipped,
      ).toHaveLength(1);
    });

    it('applies the rest of a group and keeps only that part for redo', () => {
      const db = new FakeDb();
      db.insert('annotations', 'a');
      db.insert('annotations', 'b');
      const history = record(EMPTY_HISTORY, {
        kind: 'group',
        commands: [
          { kind: 'add', row: annotation('a') },
          { kind: 'add', row: annotation('b') },
        ],
      });
      db.apply([{ op: 'softDelete', table: 'annotations', id: 'b' }]);
      const step = undo(history, db.get);
      expect(step.mutations).toEqual([{ op: 'softDelete', table: 'annotations', id: 'a' }]);
      expect(step.skipped).toEqual([{ kind: 'add', row: annotation('b') }]);
      expect(step.history.redo).toEqual([
        { kind: 'group', commands: [{ kind: 'add', row: annotation('a') }] },
      ]);
    });

    it('compares JSON-like values structurally', () => {
      const db = new FakeDb();
      db.insert('annotations', 'a', { data: { v: 1, from: [0.1, 0.2] } });
      const history = record(EMPTY_HISTORY, {
        kind: 'update',
        row: annotation('a'),
        before: { data: { v: 1, from: [0.3, 0.4] } },
        after: { data: { from: [0.1, 0.2], v: 1 } },
      });
      expect(undo(history, db.get).skipped).toEqual([]);
    });
  });
});

describe('sameValue', () => {
  it.each([
    [1, 1, true],
    [Number.NaN, Number.NaN, true],
    ['a', 'a', true],
    [null, null, true],
    [null, undefined, false],
    [0, '0', false],
    [[1, 2], [1, 2], true],
    [[1, 2], [2, 1], false],
    [{ a: 1, b: [1] }, { b: [1], a: 1 }, true],
    [{ a: 1 }, { a: 1, b: undefined }, false],
    [[], {}, false],
    [Float32Array.from([1, 2]), Float32Array.from([1, 2]), true],
    [Float32Array.from([1, 2]), Float32Array.from([1, 3]), false],
    [Float32Array.from([1]), [1], false],
  ])('%j vs %j → %s', (a, b, expected) => {
    expect(sameValue(a, b)).toBe(expected);
  });
});
