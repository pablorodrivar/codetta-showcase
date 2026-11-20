/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Modules that run on the UI thread (live stroke, touch conversion): every function in them
 * must be a worklet, or Reanimated fails at run time when the gesture calls it (ADR-008 §4).
 * In plain JS (web, tests) the directive is an inert string.
 */
const WORKLET_MODULES = [
  // The bench's live-event and outline loops also run on the UI runtime (ADR-008 §7).
  'bench/live.ts',
  'geometry/matrix.ts',
  'geometry/view.ts',
  'points.ts',
  'smoothing/outline.ts',
  'smoothing/stroke.ts',
];

/** Functions of the modules that need not be worklets: never called from the UI thread. */
const JS_ONLY = new Set(['toPointBuffer', 'toPoints']);

function functionsWithoutDirective(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const missing: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const name = node.name?.text ?? '(anonymous)';
      const first = node.body.statements[0];
      const isWorklet =
        first !== undefined &&
        ts.isExpressionStatement(first) &&
        ts.isStringLiteral(first.expression) &&
        first.expression.text === 'worklet';
      if (!isWorklet && !JS_ONLY.has(name)) missing.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return missing;
}

/**
 * Module functions and constants used before they are declared. The worklets plugin turns
 * each worklet into a `var` built by a factory that runs when the module loads and receives the worklets it
 * calls as arguments: a function declared further down is still `undefined` then, on the JS
 * thread too (hoisting is lost). Found on Hermes with the measuring screen (ADR-008 §7).
 */
function usedBeforeDeclared(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  // Functions and module constants: the factory captures both when the module loads.
  const order = new Map<string, number>();
  source.statements.forEach((statement, index) => {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      order.set(statement.name.text, index);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) order.set(declaration.name.text, index);
      }
    }
  });
  const problems: string[] = [];
  source.statements.forEach((statement, index) => {
    if (!ts.isFunctionDeclaration(statement) || !statement.name) return;
    const name = statement.name.text;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text !== name) {
        const declared = order.get(node.text);
        if (declared !== undefined && declared > index) {
          problems.push(`${name} uses ${node.text} before it is declared`);
        }
      }
      ts.forEachChild(node, visit);
    };
    if (statement.body) visit(statement.body);
  });
  return [...new Set(problems)];
}

describe('worklet modules', () => {
  it.each(WORKLET_MODULES)('%s marks every function as a worklet', (module) => {
    expect(functionsWithoutDirective(join(import.meta.dirname, module))).toEqual([]);
  });

  it.each(WORKLET_MODULES)('%s declares each function before the functions using it', (module) => {
    expect(usedBeforeDeclared(join(import.meta.dirname, module))).toEqual([]);
  });
});
