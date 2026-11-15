import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  MAX_FILE_BYTES,
  REASON_TOO_DEEPLY_NESTED,
  YAML_MAX_ALIAS_COUNT,
} from '../../src/core/index.js';

describe('input limits', () => {
  it('the file limit is 5 MB, decimal', () => {
    expect(MAX_FILE_BYTES).toBe(5_000_000);
  });

  it('the alias limit is the yaml 2.9.1 default of 100, and the library still agrees', () => {
    expect(YAML_MAX_ALIAS_COUNT).toBe(100);
    // An alias bomb: each level aliases the previous one ten times. With the
    // library default (no option) and with our explicit value it must refuse.
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 0; i < 6; i += 1) {
      const prev = String.fromCharCode(97 + i);
      const next = String.fromCharCode(98 + i);
      lines.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(', ')}]`);
    }
    const text = lines.join('\n');
    expect(() => parseDocument(text).toJS({ maxAliasCount: YAML_MAX_ALIAS_COUNT })).toThrow();
    expect(() => parseDocument(text).toJS()).toThrow(); // the library default is the same limit
  });

  it('a harmless alias is within the limit', () => {
    expect(parseDocument('a: &a 1\nb: *a\n').toJS({ maxAliasCount: YAML_MAX_ALIAS_COUNT })).toEqual(
      { a: 1, b: 1 },
    );
  });

  it('has a fixed reason for nesting', () => {
    expect(REASON_TOO_DEEPLY_NESTED).toBe('too deeply nested');
  });
});
