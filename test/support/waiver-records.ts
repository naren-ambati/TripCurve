// Raw waiver records as the readers hand them to WaiverApplier, built directly so a test can
// choose exactly what is written.
import {
  declaredSource,
  fileSource,
  type InputText,
  inputText,
  type SourceRef,
} from '../../src/core/index.js';
import type { RawFieldValue, RawWaiverRecord } from '../../src/parse/index.js';

export function inline(text: string, file = 'k8s/api.yaml', line = 5): RawWaiverRecord {
  return {
    rawFields: [],
    rawText: inputText(text),
    source: fileSource(inputText(file), line),
    mechanism: 'inline',
  };
}

export type EntryFields = Readonly<Record<string, string | number | boolean | null | object>>;

function raw(value: EntryFields[string]): RawFieldValue {
  if (typeof value === 'string') return inputText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return { nested: true };
}

/** A `waive:` entry with exactly these fields, in this order. */
export function entry(fields: EntryFields, line = 3, file = 'tripcurve.yaml'): RawWaiverRecord {
  const source: SourceRef = declaredSource(inputText(file), line);
  const text: InputText = inputText(
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
      .join('\n'),
  );
  return {
    rawFields: Object.entries(fields).map(([key, value]) => ({
      key: inputText(key),
      value: raw(value),
    })),
    rawText: text,
    source,
    mechanism: 'config',
  };
}

/** The full valid fields of an entry, to override one at a time. */
export const VALID_ENTRY = {
  rule: 'T2',
  workload: 'api',
  reason: 'drains in sidecar',
  until: '2027-01-31',
} as const;
