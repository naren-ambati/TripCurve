// A hand-written, literal-only reader for `gunicorn.conf.py`. The file is Python and is
// NEVER run, imported or evaluated (ALWAYS: input files are untrusted data).
//
// What is read: top-level lines of the exact form `name = <literal>`, where the literal is a
// decimal integer, a float, a plain quoted string (no escapes, no prefix, one line),
// True, False or None, optionally followed by a comment. Blank lines, comment lines and a
// bare one-line string (a docstring) are ignored. EVERYTHING else is a statement that could
// change a setting: an import, a call, an `if`, a `def`, a computed value, an augmented
// assignment, `exec`, a star import, a continuation line, a second statement after `;`, an
// indented line. The first such line makes every setting of the file UNRESOLVED, because
// code that is not read could set or reset any of them, whatever came before it. When unsure,
// the whole file is unresolved. A setting assigned a non-literal value says so with its own
// line.
//
// gunicorn takes a config variable only when its name is exactly the lower-case setting name
// (an upper-case name is ignored), so only those five names are looked for, and the last
// literal assignment wins, as in Python.

import { fileSource, makeUnresolved } from '../../core/index.js';
import { type InputFile, rawTextForParser } from '../intake/index.js';
import { settingValue } from './flags.js';
import {
  GUNICORN_SETTING_NAMES,
  type GunicornConfigReading,
  type GunicornSettingName,
  type PyValue,
  REASON_CONF_CODING,
  REASON_CONF_NOT_LITERAL,
  REASON_CONF_OPAQUE,
} from './model.js';

const NAME_BY_CONFIG_VARIABLE: Readonly<Record<string, GunicornSettingName>> = {
  worker_class: 'workerClass',
  threads: 'threads',
  keepalive: 'keepalive',
  graceful_timeout: 'gracefulTimeout',
  workers: 'workers',
};

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)[ \t]*(.*)$/;
const INTEGER = /^[0-9](?:_?[0-9])*$/;
const FLOAT =
  /^(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9]+)?$/;
const KEYWORD = /^(?:True|False|None)$/;
const DOUBLE = /^"[^"\\\n]*"/;
const SINGLE = /^'[^'\\\n]*'/;
const COMMENT_TAIL = /^[ \t]*(?:#.*)?$/;
const TRIPLE_ONE_LINE = /^(?:"""(?:(?!""")[^\\\n])*"""|'''(?:(?!''')[^\\\n])*''')[ \t]*(?:#.*)?$/;

type Literal =
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'integer'; readonly text: string }
  | { readonly kind: 'other' };

/** The literal at the start of `rhs` (with only a comment after it), or undefined when it is not one. */
function literalOf(rhs: string): Literal | undefined {
  const string = DOUBLE.exec(rhs) ?? SINGLE.exec(rhs);
  if (string !== null) {
    if (!COMMENT_TAIL.test(rhs.slice(string[0].length))) return undefined;
    return { kind: 'string', text: string[0].slice(1, -1) };
  }
  const hash = rhs.indexOf('#');
  const body = (hash < 0 ? rhs : rhs.slice(0, hash)).trim();
  if (INTEGER.test(body)) return { kind: 'integer', text: body.replaceAll('_', '') };
  if (FLOAT.test(body) || KEYWORD.test(body)) return { kind: 'other' };
  return undefined;
}

/** A line that is only a one-line string (a docstring) or a comment or blank. */
function isIgnorable(line: string): boolean {
  if (line.trim() === '' || /^[ \t]*#/.test(line)) return true;
  if (TRIPLE_ONE_LINE.test(line)) return true;
  const string = DOUBLE.exec(line) ?? SINGLE.exec(line);
  return string !== null && COMMENT_TAIL.test(line.slice(string[0].length));
}

// PEP 263: a `coding[:=]name` in a comment on line 1 or 2 changes how Python decodes the file. A
// codec such as unicode_escape or utf-7 turns `\\n` or `+AAo-` inside a comment into a real newline,
// so a hidden statement can set any setting. Only encodings that decode ASCII text as itself are
// accepted: utf-8, ascii and the latin-1 family (names compared case-insensitively, `_` as `-`).
const CODING_COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*([-\w.]+)/;
const PLAIN_ENCODINGS = new Set([
  'utf-8',
  'utf8',
  'ascii',
  'latin-1',
  'latin1',
  'iso-8859-1',
  'iso8859-1',
]);

/** The line (1 or 2) holding a coding cookie that is not a plain encoding, or a file that cannot be plain text. */
function codingProblemLine(text: string, all: readonly string[]): number | undefined {
  // UTF-16 and UTF-32 text shows NUL characters (or a byte order mark that is not UTF-8's).
  if (text.includes('\u0000') || text.startsWith('\uFFFE')) return 1;
  for (const [index, line] of all.slice(0, 2).entries()) {
    const m = CODING_COOKIE.exec(line);
    if (m === null) continue;
    const name = (m[1] as string).toLowerCase().replaceAll('_', '-');
    if (!PLAIN_ENCODINGS.has(name)) return index + 1;
  }
  return undefined;
}

export function readGunicornConfig(file: InputFile): GunicornConfigReading {
  const text = rawTextForParser(file).replace(/^﻿/, '');
  const lines = text.split(/\r\n|\r|\n/);
  const literals = new Map<GunicornSettingName, { value: Literal; line: number }>();
  const badAssignments = new Map<GunicornSettingName, number>();
  let opaqueAtLine: number | undefined;
  const codingAt = codingProblemLine(text, lines);
  if (codingAt !== undefined) opaqueAtLine = codingAt;

  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1;
    if (opaqueAtLine !== undefined) break;
    if (isIgnorable(line)) continue;
    const match = ASSIGNMENT.exec(line);
    if (match === null) {
      opaqueAtLine = lineNo;
      break;
    }
    const variable = match[1] as string;
    const literal = literalOf(match[2] as string);
    const setting = Object.hasOwn(NAME_BY_CONFIG_VARIABLE, variable)
      ? NAME_BY_CONFIG_VARIABLE[variable]
      : undefined;
    if (literal === undefined) {
      // A computed value: the code on that line is not read, so nothing is trusted from here.
      if (setting !== undefined) badAssignments.set(setting, lineNo);
      opaqueAtLine = lineNo;
      break;
    }
    if (setting !== undefined) literals.set(setting, { value: literal, line: lineNo });
  }

  const settings = {} as Record<GunicornSettingName, PyValue | undefined>;
  for (const name of GUNICORN_SETTING_NAMES) {
    if (codingAt !== undefined) {
      settings[name] = makeUnresolved(REASON_CONF_CODING);
      continue;
    }
    if (opaqueAtLine !== undefined) {
      const bad = badAssignments.get(name);
      settings[name] = makeUnresolved(
        bad === undefined ? REASON_CONF_OPAQUE(opaqueAtLine) : REASON_CONF_NOT_LITERAL(bad),
      );
      continue;
    }
    const found = literals.get(name);
    if (found === undefined) {
      settings[name] = undefined;
      continue;
    }
    const source = fileSource(file.canonicalPath, found.line);
    // A string for a number, a number for a class and a float for a count are not read as the setting.
    const asText =
      name === 'workerClass'
        ? found.value.kind === 'string'
          ? found.value.text
          : undefined
        : found.value.kind === 'integer'
          ? found.value.text
          : undefined;
    settings[name] =
      asText === undefined
        ? settingValue(name, '\u0000', source)
        : settingValue(name, asText, source);
  }
  if (opaqueAtLine === undefined) return { settings };
  return codingAt === undefined
    ? { settings, opaqueAtLine }
    : { settings, opaqueAtLine, opaqueBy: 'coding' };
}
