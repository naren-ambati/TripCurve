// Small syntax-tree helpers shared by the Node source readers (settings and drains). Pure.
// Recursion depth is the input's, so a RangeError is expected on hostile input and is caught at
// the file boundary (`readNodeSourceFile`).

import { Node, ts } from 'ts-morph';

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const PREFIXED = /^0[xXoObB][0-9a-fA-F]+$/;

function numericLiteralValue(text: string): number | undefined {
  const t = text.replaceAll('_', '');
  if (!(DECIMAL.test(t) || PREFIXED.test(t))) return undefined; // also rejects a BigInt (`5n`)
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** The literal number, or a product of literals; undefined for anything else. Recursion depth is the input's, so a RangeError is expected on hostile input and caught by the caller. */
export function evalLiteral(node: Node): number | undefined {
  if (Node.isNumericLiteral(node)) return numericLiteralValue(node.getText());
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === ts.SyntaxKind.MinusToken) {
    const inner = evalLiteral(node.getOperand());
    return inner === undefined ? undefined : -inner;
  }
  if (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isSatisfiesExpression(node)
  ) {
    return evalLiteral(node.getExpression());
  }
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === ts.SyntaxKind.AsteriskToken
  ) {
    const left = evalLiteral(node.getLeft());
    if (left === undefined) return undefined;
    const right = evalLiteral(node.getRight());
    if (right === undefined) return undefined;
    const product = left * right;
    return Number.isFinite(product) ? product : undefined;
  }
  return undefined;
}

/** The statement of a block or file that holds `node`: the first ancestor-or-self whose parent is a block or the file. */
export function statementOf(node: Node): Node | undefined {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return undefined;
    if (Node.isSourceFile(parent) || Node.isBlock(parent)) return current;
    current = parent;
  }
}

/** Looks through parentheses, type assertions, non-null marks and `await`. */
export function unwrap(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current !== undefined &&
    (Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isTypeAssertion(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isAwaitExpression(current))
  ) {
    current = current.getExpression();
  }
  return current;
}
