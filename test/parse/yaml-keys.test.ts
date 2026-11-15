// Review finding M1: the yaml library's duplicate-key check is quadratic, so a
// map with very many keys froze the tool well under the 5 MB cap. Duplicate
// keys are now found by our own linear walk; what they are reported as must
// not change (a parse error at the line of the second key).
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/parse/intake/index.js';
import { parseYamlDocuments } from '../../src/parse/intake/yaml-documents.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

function parse(text: string) {
  return parseYamlDocuments(text, DEFAULT_LIMITS, (index, line) => ({
    type: 'stdin',
    document: index,
    line,
  }));
}

function bigMap(keys: number): string {
  const lines: string[] = [];
  for (let i = 0; i < keys; i += 1) lines.push(`k${i}: ${i}`);
  return `${lines.join('\n')}\n`;
}

describe('duplicate keys are still a parse error at the second key (behaviour unchanged)', () => {
  it('block map: line of the second occurrence', () => {
    const r = parse('a: 1\nb: 2\na: 3\n');
    expect(r.documents).toHaveLength(0);
    expect(r.issue).toEqual({ reasonCode: 'parse-error', line: 3 });
  });

  it('nested block map and a map inside a list', () => {
    expect(parse('x:\n  y: 1\n  z: 2\n  y: 3\n').issue).toEqual({
      reasonCode: 'parse-error',
      line: 4,
    });
    expect(parse('- a: 1\n  b: 2\n  a: 3\n').issue).toEqual({
      reasonCode: 'parse-error',
      line: 3,
    });
  });

  it('flow map', () => {
    expect(parse('m: {a: 1, b: 2, a: 3}\n').issue).toEqual({ reasonCode: 'parse-error', line: 1 });
  });

  it('the same key in different maps, or a number and a string, is not a duplicate', () => {
    const ok = parse('a: 1\nb:\n  a: 2\nc: [{a: 1}, {a: 2}]\n1: x\n"1": y\n');
    expect(ok.issue).toBeUndefined();
    expect(ok.documents).toHaveLength(1);
  });

  it('a duplicate in one document does not hide the next document', () => {
    const r = parse('a: 1\na: 2\n---\nb: 1\n');
    expect(r.issue).toEqual({ reasonCode: 'parse-error', line: 2 });
    expect(r.documents).toHaveLength(1);
  });
});

describe('a map with very many keys does not freeze the tool', () => {
  it('parses 60,000 keys without error', () => {
    const r = parse(bigMap(60_000));
    expect(r.issue).toBeUndefined();
    expect(r.documents).toHaveLength(1);
  });

  it(
    'work grows linearly with the number of keys',
    () => {
      expect(scalingRatio((n) => parse(bigMap(n)), 10_000)).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it('a duplicate at the very end of a large map is still found', () => {
    const r = parse(`${bigMap(5_000)}k0: again\n`);
    expect(r.issue).toEqual({ reasonCode: 'parse-error', line: 5_001 });
  });
});
