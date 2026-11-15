import { describe, expect, it } from 'vitest';
import {
  declaredSource,
  defaultSource,
  fileSource,
  formatDefaultSource,
  inputText,
  isSourcedValue,
  isUnresolved,
  makeSourcedValue,
  makeUnresolved,
  stdinSource,
} from '../../src/core/index.js';

const file = (p: string) => inputText(p);

describe('sources', () => {
  it('has exactly the four forms', () => {
    expect(fileSource(file('k8s/web.yaml'), 17).type).toBe('file');
    expect(stdinSource(2, 9).type).toBe('stdin');
    expect(defaultSource({ citation: 'ALB idle timeout', basisText: 'documented' }).type).toBe(
      'default',
    );
    expect(declaredSource(file('tripcurve.yaml'), 4).type).toBe('declared');
  });

  it('rejects a line or document below 1, a fraction, and a non-InputText path', () => {
    expect(() => fileSource(file('a'), 0)).toThrow(TypeError);
    expect(() => fileSource(file('a'), 1.5)).toThrow(TypeError);
    expect(() => fileSource('a' as never, 1)).toThrow(TypeError);
    expect(() => stdinSource(0, 1)).toThrow(TypeError);
    expect(() => declaredSource(file('a'), -1)).toThrow(TypeError);
  });

  it('prints a default source as default: <source> (<range>; <basis>)', () => {
    const s = defaultSource({
      citation: 'Node keepAliveTimeout 5 s + buffer 1 s',
      range: 'Node 22.x from 22.19',
      basisText: 'measured on 22.23.2',
    });
    if (s.type !== 'default') throw new Error('expected a default source');
    expect(formatDefaultSource(s)).toBe(
      'default: Node keepAliveTimeout 5 s + buffer 1 s (Node 22.x from 22.19; measured on 22.23.2)',
    );
    const noRange = defaultSource({
      citation: 'Kubernetes terminationGracePeriodSeconds',
      basisText: 'documented',
    });
    if (noRange.type !== 'default') throw new Error('expected a default source');
    expect(formatDefaultSource(noRange)).toBe(
      'default: Kubernetes terminationGracePeriodSeconds (documented)',
    );
  });
});

describe('sourced values', () => {
  it('builds a value read from a file with confidence read', () => {
    const v = makeSourcedValue({
      value: 60,
      unit: 's',
      source: fileSource(file('k8s/ingress.yaml'), 9),
      basis: 'declared',
    });
    expect(v.confidence).toBe('read');
    expect(isSourcedValue(v)).toBe(true);
  });

  it('gives a tripcurve.yaml declaration confidence declared', () => {
    const v = makeSourcedValue({
      value: 5,
      unit: 's',
      source: declaredSource(file('tripcurve.yaml'), 4),
      basis: 'declared',
    });
    expect(v.confidence).toBe('declared');
  });

  it('gives a cited default confidence cited, and an assumed default confidence assumed', () => {
    const source = defaultSource({
      citation: 'ALB idle timeout',
      range: 'AWS docs, ALB',
      basisText: 'documented',
    });
    expect(makeSourcedValue({ value: 60, unit: 's', source, basis: 'documented' }).confidence).toBe(
      'cited',
    );
    expect(makeSourcedValue({ value: 60, unit: 's', source, basis: 'assumed' }).confidence).toBe(
      'assumed',
    );
  });

  it('cannot be built without a source', () => {
    expect(() =>
      makeSourcedValue({ value: 1, unit: 's', source: undefined as never, basis: 'declared' }),
    ).toThrow(TypeError);
    expect(() =>
      makeSourcedValue({ value: 1, unit: 's', source: {} as never, basis: 'declared' }),
    ).toThrow(TypeError);
  });

  it('cannot be built with an unknown basis or a basis that does not fit the source', () => {
    const f = fileSource(file('a'), 1);
    const d = defaultSource({ citation: 'x', basisText: 'documented' });
    expect(() =>
      makeSourcedValue({ value: 1, unit: 's', source: f, basis: 'nonsense' as never }),
    ).toThrow(TypeError);
    // A file cannot claim to be a measured default, nor an assumed value.
    expect(() =>
      makeSourcedValue({ value: 1, unit: 's', source: f, basis: 'measured-on' }),
    ).toThrow(TypeError);
    expect(() => makeSourcedValue({ value: 1, unit: 's', source: f, basis: 'assumed' })).toThrow(
      TypeError,
    );
    // A cited default cannot claim to be declared.
    expect(() => makeSourcedValue({ value: 1, unit: 's', source: d, basis: 'declared' })).toThrow(
      TypeError,
    );
  });

  it('rejects a number that is not finite', () => {
    const f = fileSource(file('a'), 1);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        makeSourcedValue({ value: bad, unit: 's', source: f, basis: 'declared' }),
      ).toThrow(TypeError);
    }
  });

  it('holds text from a file only as InputText', () => {
    const f = fileSource(file('a'), 1);
    expect(
      makeSourcedValue({
        value: inputText('node:22.23'),
        unit: 'none',
        source: f,
        basis: 'declared',
      }).value,
    ).toBeDefined();
    expect(() =>
      makeSourcedValue({ value: {} as never, unit: 'none', source: f, basis: 'declared' }),
    ).toThrow(TypeError);
  });

  it('is frozen', () => {
    const v = makeSourcedValue({
      value: 1,
      unit: 's',
      source: fileSource(file('a'), 1),
      basis: 'declared',
    });
    expect(Object.isFrozen(v)).toBe(true);
  });
});

describe('unresolved values', () => {
  it('carry a reason and are not sourced values', () => {
    const u = makeUnresolved('ALB idle not set in any file', 'declare it in tripcurve.yaml');
    expect(isUnresolved(u)).toBe(true);
    expect(isSourcedValue(u)).toBe(false);
    expect(u.declareHint).toBe('declare it in tripcurve.yaml');
  });

  it('need a reason', () => {
    expect(() => makeUnresolved('  ')).toThrow(TypeError);
  });
});
