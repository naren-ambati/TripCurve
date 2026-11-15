// Reading one raw waiver record into what it says, and the one shared check of it (this is
// the only place a waiver is judged; the config reader and the comment scanners only extract).
//
// Two forms, one result:
//   - an inline comment, exactly `tripcurve: ignore <RULE> reason="<text>" until=<YYYY-MM-DD>` after
//     the comment mark (`#`, or `//` in Terraform); the reason follows YAML double-quote escapes;
//   - a `waive:` entry of tripcurve.yaml with the keys rule, workload, reason and until, and the
//     optional namespace and kind.
// A text that does not fit is not dropped and not guessed at: it is read as far as it goes and the
// first thing wrong is named, so the waiver is listed. The text is only ever read here as
// data and is never run.

import {
  type InputText,
  inputText,
  isInputText,
  type K8sWorkloadKind,
  k8sWorkloadKindFromInput,
} from '../core/index.js';
import { type RawFieldValue, type RawWaiverRecord, rawInputTextForParser } from '../parse/index.js';
import { isIsoDate } from './dates.js';
import { MAX_REASON_CHARS, type WaiverProblemCode } from './model.js';

export interface WaiverTarget {
  readonly name: InputText;
  readonly namespace?: InputText;
  /** A kind from the fixed list; absent when the waiver names none. */
  readonly kind?: K8sWorkloadKind;
}

/** What a waiver says, with the first problem found in its form (not yet whether it matches anything). */
export interface ReadWaiver {
  readonly record: RawWaiverRecord;
  /** The waiver as written; an inline comment without its comment mark. */
  readonly text: InputText;
  /** The rule as written (`T2`, or any text), absent when none was given. */
  readonly ruleText?: string;
  readonly reason: InputText;
  /** The date as written, absent when none was given. */
  readonly untilText?: string;
  /** For a `waive:` entry: the workload it names. Inline waivers name none (the block they sit in does). */
  readonly target?: WaiverTarget;
  readonly problem?: WaiverProblemCode;
}

const RULE_RE = /^T[1-4]$/;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** The number of characters (code points) of a text, counting no further than `limit + 1`. */
function charCount(text: string, limit: number): number {
  let n = 0;
  for (const _ of text) {
    n += 1;
    if (n > limit) break;
  }
  return n;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\u0000',
  a: '\u0007',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\u001b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\u0085',
  _: ' ',
  L: ' ',
  P: ' ',
};

const HEX_ESCAPE_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

/** The reason between double quotes, with YAML's escapes; undefined when it is not closed or an escape is not one. */
function quotedValue(text: string): { value: string; rest: string } | undefined {
  if (text[0] !== '"') return undefined;
  let out = '';
  let i = 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') return { value: out, rest: text.slice(i + 1) };
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    const e = text[i + 1];
    if (e === undefined) return undefined;
    const digits = HEX_ESCAPE_DIGITS[e];
    if (digits !== undefined) {
      const hex = text.slice(i + 2, i + 2 + digits);
      if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) return undefined;
      const code = Number.parseInt(hex, 16);
      if (code > 0x10ffff) return undefined;
      out += String.fromCodePoint(code);
      i += 2 + digits;
      continue;
    }
    const simple = SIMPLE_ESCAPES[e];
    if (simple === undefined) return undefined;
    out += simple;
    i += 2;
  }
  return undefined;
}

interface Parts {
  rule?: string;
  reason?: string;
  until?: string;
  problem?: WaiverProblemCode;
}

/** `tripcurve: ignore <RULE> reason="<text>" until=<date>` after the comment mark. */
function parseDirective(directive: string): Parts {
  const head = /^tripcurve:[ \t]*(.*)$/s.exec(directive);
  const afterMarker = head?.[1];
  const ignore = afterMarker === undefined ? null : /^ignore(?:[ \t]+(.*))?$/s.exec(afterMarker);
  if (ignore === null) return { problem: 'not-in-form' };
  const rest = (ignore[1] ?? '').trim();
  if (rest === '') return { problem: 'no-rule' };
  const ruleToken = /^(\S+)(?:[ \t]+(.*))?$/s.exec(rest);
  const rule = ruleToken?.[1] as string;
  let tail = (ruleToken?.[2] ?? '').trim();
  const parts: Parts = { rule };
  if (tail.startsWith('reason=')) {
    const after = tail.slice('reason='.length);
    if (after === '' || /^[ \t]/.test(after)) {
      parts.reason = '';
      tail = after.trim();
    } else {
      const quoted = quotedValue(after);
      if (quoted === undefined || (quoted.rest !== '' && !/^[ \t]/.test(quoted.rest))) {
        return { ...parts, problem: 'not-in-form' };
      }
      parts.reason = quoted.value;
      tail = quoted.rest.trim();
    }
  }
  if (tail.startsWith('until=')) {
    const token = /^until=(\S*)(?:[ \t]+(.*))?$/s.exec(tail);
    parts.until = token?.[1] ?? '';
    tail = (token?.[2] ?? '').trim();
  }
  if (tail !== '') return { ...parts, problem: 'not-in-form' };
  return parts;
}

function textOf(value: RawFieldValue | undefined): string | undefined {
  return value !== undefined && isInputText(value) ? rawInputTextForParser(value) : undefined;
}

/** A field that is not text, as a word that can never be a rule or a date (it is only ever shown quoted). */
function scalarText(value: RawFieldValue): string {
  const text = textOf(value);
  if (text !== undefined) return text;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '(not a value)';
}

const CONFIG_KEYS = ['rule', 'workload', 'namespace', 'kind', 'reason', 'until'] as const;

interface EntryParts extends Parts {
  target?: WaiverTarget;
  /** The workload fields are present but are not a name (and optional namespace and kind) tripcurve can use. */
  targetProblem?: WaiverProblemCode;
  /** The reason is given, but is not text. */
  reasonNotText?: boolean;
}

function parseEntry(record: RawWaiverRecord): EntryParts {
  const fields = new Map<string, RawFieldValue>();
  for (const f of record.rawFields) fields.set(rawInputTextForParser(f.key), f.value);
  if (fields.size === 0) return { problem: 'not-an-entry' };
  for (const key of fields.keys()) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) return { problem: 'unknown-field' };
  }
  const given = (key: string): RawFieldValue | undefined => {
    const v = fields.get(key);
    return v === null ? undefined : v;
  };
  const parts: EntryParts = {};
  const rule = given('rule');
  if (rule !== undefined) parts.rule = scalarText(rule);
  const reason = given('reason');
  if (reason !== undefined) {
    const text = textOf(reason);
    if (text === undefined) parts.reasonNotText = true;
    else parts.reason = text;
  }
  const until = given('until');
  if (until !== undefined) parts.until = scalarText(until);

  const workload = given('workload');
  if (workload === undefined) {
    parts.targetProblem = 'no-workload';
    return parts;
  }
  const name = textOf(workload);
  if (name === undefined || name === '') {
    parts.targetProblem = 'unknown-workload';
    return parts;
  }
  const namespaceValue = given('namespace');
  const kindValue = given('kind');
  const namespace = namespaceValue === undefined ? undefined : textOf(namespaceValue);
  const kindText = kindValue === undefined ? undefined : textOf(kindValue);
  const kind = kindText === undefined ? undefined : k8sWorkloadKindFromInput(kindText);
  if (
    (namespaceValue !== undefined && (namespace === undefined || namespace === '')) ||
    (kindValue !== undefined && kind === undefined)
  ) {
    parts.targetProblem = 'unknown-workload';
    return parts;
  }
  parts.target = {
    name: inputText(name),
    ...(namespace === undefined ? {} : { namespace: inputText(namespace) }),
    ...(kind === undefined ? {} : { kind }),
  };
  return parts;
}

/** The first problem of the rule, reason and date of a waiver, in that order; a problem of its form comes first. */
function checkFields(parts: Parts & { reasonNotText?: boolean }): WaiverProblemCode | undefined {
  if (parts.problem !== undefined) return parts.problem;
  if (parts.rule === undefined) return 'no-rule';
  if (!RULE_RE.test(parts.rule)) return 'unknown-rule';
  if (parts.reasonNotText === true) return 'bad-reason';
  if (parts.reason === undefined) return 'no-reason';
  // at least one visible character: a reason of blanks, zero-width characters or controls is empty
  if (!VISIBLE.test(parts.reason)) return 'empty-reason';
  if (charCount(parts.reason, MAX_REASON_CHARS) > MAX_REASON_CHARS) return 'long-reason';
  if (parts.until === undefined || parts.until === '') return 'no-date';
  if (!isIsoDate(parts.until)) return 'bad-date';
  return undefined;
}

/** Reads one raw record. Never throws, for any text. */
export function readWaiver(record: RawWaiverRecord): ReadWaiver {
  if (record.mechanism === 'inline') {
    const raw = rawInputTextForParser(record.rawText);
    const directive = raw.replace(/^(?:#|\/\/)[ \t]*/, '');
    const parts = parseDirective(directive);
    const problem = checkFields(parts);
    return {
      record,
      text: inputText(directive),
      ...(parts.rule === undefined ? {} : { ruleText: parts.rule }),
      reason: inputText(parts.reason ?? ''),
      ...(parts.until === undefined ? {} : { untilText: parts.until }),
      ...(problem === undefined ? {} : { problem }),
    };
  }
  const parts: EntryParts =
    record.notAList === true ? { problem: 'waive-not-a-list' } : parseEntry(record);
  const problem = checkFields(parts) ?? parts.targetProblem;
  // An entry is quoted on one line: its line breaks and indentation are read as single spaces.
  // Split on the line ends and trim each line: linear, where a regular expression over blanks is not.
  const oneLine = inputText(
    rawInputTextForParser(record.rawText)
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' '),
  );
  return {
    record,
    text: oneLine,
    ...(parts.rule === undefined ? {} : { ruleText: parts.rule }),
    reason: inputText(parts.reason ?? ''),
    ...(parts.until === undefined ? {} : { untilText: parts.until }),
    ...(parts.target === undefined ? {} : { target: parts.target }),
    ...(problem === undefined ? {} : { problem }),
  };
}

/** Whether the rule a waiver names is one of T1 to T4. */
export function isRuleText(text: string | undefined): text is 'T1' | 'T2' | 'T3' | 'T4' {
  return text !== undefined && RULE_RE.test(text);
}
