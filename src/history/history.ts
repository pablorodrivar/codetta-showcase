/**
 * Pure undo/redo for one open score (ADR-008 §6): unlimited within the session, across all
 * its pages, and lost when the score is closed.
 *
 * The app writes a change, then records the command that describes it. Undo and redo
 * return the mutations for the repository to apply, never touching the database
 * themselves. Rows are never deleted: undoing an addition soft-deletes the row and redoing
 * it restores the same row (same id), which keeps sync to plain updates (ADR-003).
 *
 * Before each step a guard checks the row: that it exists and is live or soft-deleted as the
 * command left it, and, for an update, that the changed columns still hold the values it
 * wrote. If another device (once there is sync) or another path changed that, the step is
 * skipped and reported instead of overwriting the newer change. Edits to other columns do
 * not block it.
 *
 * Layer visibility, locking and order are view state, not history.
 */

export type HistoryTable = 'annotations' | 'annotation_layers';

/** A row as the history keeps it: enough to restore it and to tell where it is. */
export interface HistoryRow {
  readonly table: HistoryTable;
  readonly id: string;
  /** Page of an annotation, to show it before undoing; null for a layer. */
  readonly pageIndex: number | null;
}

export type Command =
  /** A row was created (an annotation drawn, a layer added). */
  | { readonly kind: 'add'; readonly row: HistoryRow }
  /** A row was soft-deleted (erased, layer removed). */
  | { readonly kind: 'remove'; readonly row: HistoryRow }
  /** Columns of a row changed: `before` and `after` hold the same keys. */
  | {
      readonly kind: 'update';
      readonly row: HistoryRow;
      readonly before: Readonly<Record<string, unknown>>;
      readonly after: Readonly<Record<string, unknown>>;
    }
  /** One user action that touched several rows (an eraser swipe): one undo step. */
  | { readonly kind: 'group'; readonly commands: readonly Command[] };

export type Mutation =
  | { readonly op: 'softDelete'; readonly table: HistoryTable; readonly id: string }
  | { readonly op: 'restore'; readonly table: HistoryTable; readonly id: string }
  | {
      readonly op: 'patch';
      readonly table: HistoryTable;
      readonly id: string;
      readonly values: Readonly<Record<string, unknown>>;
    };

/** What the guard needs: whether the row is soft-deleted and its current column values. */
export interface CurrentRow {
  readonly deleted: boolean;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Looks a row up in the local database; undefined if it does not exist. */
export type GetCurrentRow = (table: HistoryTable, id: string) => CurrentRow | undefined;

export interface History {
  readonly undo: readonly Command[];
  readonly redo: readonly Command[];
}

export const EMPTY_HISTORY: History = { undo: [], redo: [] };

export interface StepResult {
  readonly history: History;
  /** Apply in order, in one transaction. */
  readonly mutations: readonly Mutation[];
  /** Commands whose rows changed since: not applied, dropped from the history. */
  readonly skipped: readonly Command[];
  /** Page of the first changed annotation, to show it; null if none. */
  readonly pageIndex: number | null;
}

/**
 * Records a change the app has just written. Clears redo, like every editor. Throws a
 * RangeError for an `update` whose `before` and `after` do not hold the same columns: a bug
 * in the caller, which would make undo and redo touch different columns.
 */
export function record(history: History, command: Command): History {
  if (command.kind === 'group' && command.commands.length === 0) return history;
  assertSameColumns(command);
  return { undo: [...history.undo, command], redo: [] };
}

function assertSameColumns(command: Command): void {
  if (command.kind === 'group') {
    command.commands.forEach(assertSameColumns);
    return;
  }
  if (command.kind !== 'update') return;
  const before = Object.keys(command.before).sort();
  const after = Object.keys(command.after).sort();
  if (before.length !== after.length || before.some((key, index) => key !== after[index])) {
    throw new RangeError(`Update of ${command.row.id} changes different columns before and after`);
  }
}

export function canUndo(history: History): boolean {
  return history.undo.length > 0;
}

export function canRedo(history: History): boolean {
  return history.redo.length > 0;
}

/** Page the next undo would change, so the reader can go there first. */
export function nextUndoPage(history: History): number | null {
  const command = history.undo.at(-1);
  return command ? firstPage(command) : null;
}

export function nextRedoPage(history: History): number | null {
  const command = history.redo.at(-1);
  return command ? firstPage(command) : null;
}

function firstPage(command: Command): number | null {
  if (command.kind !== 'group') return command.row.pageIndex;
  for (const child of command.commands) {
    const page = firstPage(child);
    if (page !== null) return page;
  }
  return null;
}

export function undo(history: History, getCurrent: GetCurrentRow): StepResult {
  const command = history.undo.at(-1);
  if (!command) return { history, mutations: [], skipped: [], pageIndex: null };
  const step = apply(command, 'undo', withPendingMutations(getCurrent));
  return {
    history: {
      undo: history.undo.slice(0, -1),
      redo: step.applied ? [...history.redo, step.applied] : history.redo,
    },
    mutations: step.mutations,
    skipped: step.skipped,
    pageIndex: step.applied ? firstPage(step.applied) : null,
  };
}

export function redo(history: History, getCurrent: GetCurrentRow): StepResult {
  const command = history.redo.at(-1);
  if (!command) return { history, mutations: [], skipped: [], pageIndex: null };
  const step = apply(command, 'redo', withPendingMutations(getCurrent));
  return {
    history: {
      undo: step.applied ? [...history.undo, step.applied] : history.undo,
      redo: history.redo.slice(0, -1),
    },
    mutations: step.mutations,
    skipped: step.skipped,
    pageIndex: step.applied ? firstPage(step.applied) : null,
  };
}

interface Lookup {
  readonly get: GetCurrentRow;
  /** Records a mutation this step emits, so later commands of the same step see it. */
  readonly emit: (mutation: Mutation) => void;
}

/**
 * The database as it will be once this step's mutations are applied. A group can touch the
 * same row twice (the 1.1 partial eraser cuts a stroke and then one of its pieces), and the
 * guard of the second command must see the first one's change, not the stale row.
 */
function withPendingMutations(getCurrent: GetCurrentRow): Lookup {
  const pending = new Map<string, CurrentRow | undefined>();
  const key = (table: HistoryTable, id: string) => `${table}:${id}`;
  const get: GetCurrentRow = (table, id) =>
    pending.has(key(table, id)) ? pending.get(key(table, id)) : getCurrent(table, id);
  return {
    get,
    emit: (mutation) => {
      const current = get(mutation.table, mutation.id);
      if (!current) return;
      pending.set(key(mutation.table, mutation.id), {
        deleted:
          mutation.op === 'softDelete' ? true : mutation.op === 'restore' ? false : current.deleted,
        values:
          mutation.op === 'patch' ? { ...current.values, ...mutation.values } : current.values,
      });
    },
  };
}

interface Applied {
  /** The part of the command that was applied (a group may lose children), or null. */
  readonly applied: Command | null;
  readonly mutations: Mutation[];
  readonly skipped: Command[];
}

function apply(command: Command, direction: 'undo' | 'redo', lookup: Lookup): Applied {
  if (command.kind === 'group') {
    // Undo walks the group backwards, redo forwards, so dependent changes stay in order.
    const children = direction === 'undo' ? [...command.commands].reverse() : command.commands;
    const applied: Command[] = [];
    const mutations: Mutation[] = [];
    const skipped: Command[] = [];
    for (const child of children) {
      const step = apply(child, direction, lookup);
      if (step.applied) applied.push(step.applied);
      mutations.push(...step.mutations);
      skipped.push(...step.skipped);
    }
    if (direction === 'undo') applied.reverse();
    return {
      applied: applied.length > 0 ? { kind: 'group', commands: applied } : null,
      mutations,
      skipped,
    };
  }

  const { table, id } = command.row;
  const current = lookup.get(table, id);
  // State the row must be in for this step: the one the command left (undo) or found (redo).
  const expectsLive =
    (command.kind === 'add' && direction === 'undo') ||
    (command.kind === 'remove' && direction === 'redo') ||
    command.kind === 'update';
  const expectedValues =
    command.kind === 'update' ? (direction === 'undo' ? command.after : command.before) : null;
  const matches =
    current?.deleted === !expectsLive &&
    (expectedValues === null ||
      Object.entries(expectedValues).every(([key, value]) =>
        sameValue(current.values[key], value),
      ));
  if (!matches) return { applied: null, mutations: [], skipped: [command] };

  const mutation: Mutation =
    command.kind === 'update'
      ? { op: 'patch', table, id, values: direction === 'undo' ? command.before : command.after }
      : {
          op: (command.kind === 'add') === (direction === 'undo') ? 'softDelete' : 'restore',
          table,
          id,
        };
  lookup.emit(mutation);
  return { applied: command, mutations: [mutation], skipped: [] };
}

/** Structural equality for column values (JSON-like: primitives, arrays, plain objects). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return x.length === y.length && x.every((byte, index) => byte === y[index]);
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
