import { describe, expect, it } from 'vitest';
import { inputText } from '../../src/core/index.js';
import { quote, t, wrap, wrapText } from '../../src/report/layout.js';

describe('wrap', () => {
  it('fills a line greedily up to the width and continues under the continuation prefix', () => {
    expect(wrapText('aaa bbb ccc ddd', '> ', '  ', 9)).toEqual(['> aaa bbb', '  ccc ddd']);
  });

  it('puts a first word that is too wide on its own line and goes on', () => {
    expect(wrapText('abcdefghijkl x', '', '', 5)).toEqual(['abcdefghijkl', 'x']);
  });

  it('never splits a quoted word, even one holding spaces', () => {
    const lines = wrap([t('see '), quote(inputText('a b c'), 20), t(' end')], '', '', 10);
    expect(lines).toEqual(['see', '"a b c"', 'end']);
  });

  it('keeps the word before a quoted word with it: a continuation never starts with quotes', () => {
    const lines = wrap(
      [t('aaaa bbbb reason '), quote(inputText('xyz'), 20), t(' from')],
      '',
      '  ',
      16,
    );
    expect(lines).toEqual(['aaaa bbbb', '  reason "xyz"', '  from']);
    for (const l of lines.slice(1)) expect(l.trimStart().startsWith('"')).toBe(false);
  });

  it('carries back through several quoted words to a word of its own', () => {
    const q = (s: string) => quote(inputText(s), 20);
    const lines = wrap(
      [t('files ('), q('a'), t(', '), q('b'), t(', '), q('c'), t(')')],
      '',
      '  ',
      17,
    );
    expect(lines).toEqual(['files', '  ("a", "b", "c")']);
  });

  it('width wins when the carried words would not fit', () => {
    const q = (s: string) => quote(inputText(s), 40);
    const lines = wrap(
      [t('x ('), q('aaaaaaaaaa'), t(', '), q('bbbbbbbbbb'), t(', '), q('cccccccccc')],
      '',
      '',
      24,
    );
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
  });

  it('glues a quote to the text next to it with no space between', () => {
    const lines = wrap([t('at '), quote(inputText('f'), 10), t(':17')], '', '', 80);
    expect(lines).toEqual(['at "f":17']);
  });

  it('a quoted piece is cut by SafeText to the room it is given', () => {
    const seg = quote(inputText('x'.repeat(100)), 12);
    expect('quoted' in seg && seg.quoted).toBe(`"${'x'.repeat(7)}..."`);
  });

  it('no segments gives just the prefix', () => {
    expect(wrap([], '  ', '  ')).toEqual(['  ']);
  });
});
