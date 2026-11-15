// Exact version pins of gunicorn or uvicorn in the repository (maintainer decision 2026-11-11), read
// with a small line-oriented reader, no TOML or requirements library. Files read:
//   - `requirements*.txt`: `name==X.Y.Z` (extras, an environment marker and `--hash` options are
//     ignored; comments are ignored);
//   - `pyproject.toml`: PEP 621 `dependencies = [...]` of `[project]` with `==`, and the Poetry
//     `[tool.poetry.dependencies]` exact forms (`"26.2.0"`, `"==26.2.0"`, `{version = "26.2.0"}`);
//   - `poetry.lock` and `uv.lock`: the `version` of the `[[package]]` block named gunicorn or uvicorn.
// Only an EXACT pin is evidence. `>=`, `~=`, `^`, `~`, `*`, a range, a comma list or an unpinned name
// is NOT a pin (`none`). A pin in a form this reader does not understand (a pre-release, a direct
// URL, a VCS line, a version of four parts, an unterminated array, a Poetry git dependency) is
// `unreadable`: it is never skipped, because the version it names may differ from any other.
// Two different pins in one file are a `conflict`. Pure text: nothing is run, every loop is linear.

import { type InputFile, rawInputTextForParser, rawTextForParser } from '../intake/index.js';

export type PinPackage = 'gunicorn' | 'uvicorn';

/** Why a pin is not read: a form tripcurve does not understand, or an environment marker on it. */
export type UnreadableReason = 'form' | 'marker';

export type PinReading =
  /** The package is not named in this file. */
  | { readonly state: 'none' }
  /** The package is named, but not with an exact pin (`>=`, a range, no version): it is not evidence, and it still means the file speaks for the package. */
  | { readonly state: 'unpinned' }
  | { readonly state: 'pin'; readonly version: string; readonly line: number }
  | { readonly state: 'conflict' }
  | { readonly state: 'unreadable'; readonly reason: UnreadableReason };

const NONE: PinReading = { state: 'none' };

type One =
  | { kind: 'none' }
  | { kind: 'unpinned' }
  | { kind: 'unreadable'; reason: UnreadableReason }
  | { kind: 'pin'; version: string };

const PLAIN_VERSION = /^[0-9]{1,9}\.[0-9]{1,9}(?:\.[0-9]{1,9})?$/;
const REQUIREMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*/;

function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** `26.2` and `26.2.0` are the same release. */
function canonical(version: string): string {
  const [a, b, c] = version.split('.');
  return `${Number(a)}.${Number(b)}.${Number(c ?? '0')}`;
}

/** The version of `==<version>` text: a pin, not exact (a range, a wildcard) or unreadable. */
function equalsVersion(text: string): One {
  const v = text.trim();
  if (v.includes(',') || v.includes('*')) return UNPINNED_ONE;
  return PLAIN_VERSION.test(v) ? { kind: 'pin', version: canonical(v) } : UNREADABLE_ONE;
}

/** A requirement line that is a URL, a path or a file: it can install any package at any version. */
function isUrlOrPath(text: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) ||
    /^(?:\.{0,2}\/|~)/.test(text) ||
    /\.(?:whl|tar\.gz|tgz|zip)$/i.test(text)
  );
}

/** One requirement string (`gunicorn[gevent]==26.2.0 ; marker --hash=...`) for the package. */
function parseRequirement(raw: string, pkg: PinPackage): One {
  let text = raw;
  let marker = false;
  const at = text.indexOf(';');
  if (at >= 0) {
    marker = text.slice(at + 1).trim() !== '';
    text = text.slice(0, at);
  }
  const option = text.search(/\s--/);
  if (option >= 0) text = text.slice(0, option);
  text = text.trim();
  if (isUrlOrPath(text)) return UNREADABLE_ONE;
  const name = REQUIREMENT_NAME.exec(text);
  if (name === null) return UNREADABLE_ONE;
  // a VCS or URL line names the package only in its egg fragment
  if (normaliseName(name[0]) !== pkg) {
    return text.toLowerCase().includes(`egg=${pkg}`) ? UNREADABLE_ONE : NONE_ONE;
  }
  let rest = text.slice(name[0].length).trimStart();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return UNREADABLE_ONE;
    rest = rest.slice(close + 1).trimStart();
  }
  if (rest === '') return UNPINNED_ONE;
  if (rest.startsWith('@')) return UNREADABLE_ONE;
  if (rest.startsWith('===')) return UNREADABLE_ONE;
  let one: One;
  if (rest.startsWith('==')) one = equalsVersion(rest.slice(2));
  else if (/^(?:>=|<=|>|<|~=|!=)/.test(rest)) one = UNPINNED_ONE;
  else return UNREADABLE_ONE;
  // an exact pin under an environment marker applies only there: it is not read
  return marker && one.kind === 'pin' ? MARKER_ONE : one;
}
const NONE_ONE: One = { kind: 'none' };
const UNPINNED_ONE: One = { kind: 'unpinned' };
const UNREADABLE_ONE: One = { kind: 'unreadable', reason: 'form' };
const MARKER_ONE: One = { kind: 'unreadable', reason: 'marker' };

/** Collects what a file says: the first line of each distinct pin, and whether anything was unreadable. */
class Collector {
  private readonly pins = new Map<string, number>();
  private unreadable: UnreadableReason | undefined;
  private unpinned = false;

  add(one: One, line: number): void {
    if (one.kind === 'unreadable') {
      // a form that is not read outranks a marker as the reason given
      if (this.unreadable !== 'form') this.unreadable = one.reason;
    } else if (one.kind === 'unpinned') this.unpinned = true;
    else if (one.kind === 'pin' && !this.pins.has(one.version)) this.pins.set(one.version, line);
  }

  result(): PinReading {
    if (this.unreadable !== undefined) return { state: 'unreadable', reason: this.unreadable };
    if (this.pins.size > 1) return { state: 'conflict' };
    const first = this.pins.entries().next();
    if (first.done !== true) return { state: 'pin', version: first.value[0], line: first.value[1] };
    return this.unpinned ? { state: 'unpinned' } : NONE;
  }
}

const lines = (text: string): string[] => text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

// ---- requirements*.txt -------------------------------------------------------------------

/** `-r`, `-c`, `-e` (glued or spaced) and their long forms. */
const BRINGS_IN_REQUIREMENTS = /^(?:-[rce]|--(?:requirement|constraint|editable)(?![A-Za-z0-9_-]))/;

function readRequirements(text: string, pkg: PinPackage): PinReading {
  const out = new Collector();
  let pending: { line: number; text: string } | undefined;
  const flush = (): void => {
    if (pending === undefined) return;
    const t = pending.text.trim();
    if (t.startsWith('-')) {
      // -r, -c and -e bring in requirements or constraints that are not these lines: not read
      if (BRINGS_IN_REQUIREMENTS.test(t)) out.add(UNREADABLE_ONE, pending.line);
    } else if (t !== '') out.add(parseRequirement(t, pkg), pending.line);
    pending = undefined;
  };
  for (const [index, raw] of lines(text).entries()) {
    if (/^\s*#/.test(raw)) continue;
    const comment = raw.search(/\s#/);
    const body = (comment >= 0 ? raw.slice(0, comment) : raw).trimEnd();
    const continues = body.endsWith('\\');
    const piece = continues ? body.slice(0, -1) : body;
    pending =
      pending === undefined
        ? { line: index + 1, text: piece }
        : { line: pending.line, text: `${pending.text} ${piece}` };
    if (!continues) flush();
  }
  flush();
  return out.result();
}

// ---- TOML pieces -------------------------------------------------------------------------

/** The line without a trailing `#` comment (a `#` inside a string is kept). */
function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote !== undefined) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

/**
 * The strings of the array that starts at `rest` of line `start`, reading on across lines until
 * its bracket closes. undefined when it never closes or holds a multi-line string.
 */
function collectArray(
  all: readonly string[],
  start: number,
  rest: string,
): Array<{ text: string; line: number }> | undefined {
  const strings: Array<{ text: string; line: number }> = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';
  let currentLine = 0;
  for (let l = start; l < all.length; l += 1) {
    const text = l === start ? rest : (all[l] as string);
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] as string;
      if (quote !== undefined) {
        if (ch === '\\' && quote === '"') {
          current += text[i + 1] ?? '';
          i += 1;
        } else if (ch === quote) {
          strings.push({ text: current, line: currentLine });
          quote = undefined;
        } else current += ch;
        continue;
      }
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        if (text[i + 1] === ch && text[i + 2] === ch) return undefined; // a multi-line string
        quote = ch;
        current = '';
        currentLine = l + 1;
      } else if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) return strings;
      }
    }
    if (quote !== undefined) return undefined; // a string does not span lines
  }
  return undefined;
}

function readPyproject(text: string, pkg: PinPackage): PinReading {
  const all = lines(text);
  const out = new Collector();
  let table = '';
  for (let i = 0; i < all.length; i += 1) {
    const line = stripTomlComment(all[i] as string).trim();
    if (line === '') continue;
    if (line.startsWith('[')) {
      table = line.replace(/^\[+\s*/, '').replace(/\s*\]+$/, '');
      // `[tool.poetry.dependencies.gunicorn]`: a form of the dependency that is not read
      const sub = /^tool\.poetry\.dependencies\.["']?([A-Za-z0-9._-]+)["']?$/.exec(table);
      if (sub !== null && normaliseName(sub[1] as string) === pkg) out.add(UNREADABLE_ONE, i + 1);
      continue;
    }
    if (table === 'project') {
      const m = /^dependencies\s*=\s*(.*)$/.exec(line);
      if (m === null) continue;
      if (!(m[1] as string).startsWith('[')) {
        out.add(UNREADABLE_ONE, i + 1);
        continue;
      }
      const strings = collectArray(all, i, m[1] as string);
      if (strings === undefined) {
        out.add(UNREADABLE_ONE, i + 1);
        break;
      }
      for (const s of strings) out.add(parseRequirement(s.text, pkg), s.line);
    } else if (table === 'tool.poetry.dependencies') {
      const m = /^([A-Za-z0-9._-]+)\s*=\s*(.*)$/.exec(line);
      if (m === null || normaliseName(m[1] as string) !== pkg) continue;
      out.add(poetryValue(m[2] as string), i + 1);
    }
  }
  return out.result();
}

/** A Poetry dependency value: `"26.2.0"`, `"==26.2.0"`, `{version = "26.2.0", ...}`. */
function poetryValue(value: string): One {
  const v = value.trim();
  let spec: string | undefined;
  if (v.startsWith('{')) {
    const m = /\bversion\s*=\s*"([^"]*)"/.exec(v);
    spec = m?.[1];
  } else {
    const m = /^"([^"]*)"$/.exec(v);
    spec = m?.[1];
  }
  if (spec === undefined) return UNREADABLE_ONE;
  const s = spec.trim();
  if (s.startsWith('==')) return equalsVersion(s.slice(2));
  if (/^[\^~><!*]/.test(s) || s.includes(',') || s.includes('*')) return UNPINNED_ONE;
  return PLAIN_VERSION.test(s) ? { kind: 'pin', version: canonical(s) } : UNREADABLE_ONE;
}

// ---- poetry.lock and uv.lock ---------------------------------------------------------------

function readLock(text: string, pkg: PinPackage): PinReading {
  const out = new Collector();
  let open = false;
  let sub = false;
  let name: string | undefined;
  let version: string | undefined;
  let versionLine = 0;
  const close = (): void => {
    if (open && name !== undefined && normaliseName(name) === pkg) {
      if (version === undefined) out.add(UNREADABLE_ONE, versionLine || 1);
      else {
        out.add(
          PLAIN_VERSION.test(version)
            ? { kind: 'pin', version: canonical(version) }
            : UNREADABLE_ONE,
          versionLine,
        );
      }
    }
    name = undefined;
    version = undefined;
    versionLine = 0;
    sub = false;
  };
  for (const [index, raw] of lines(text).entries()) {
    const line = raw.trimEnd();
    if (line === '[[package]]') {
      close();
      open = true;
      continue;
    }
    if (line.startsWith('[')) {
      sub = true;
      continue;
    }
    if (!open || sub) continue;
    const n = /^name\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (n !== null && name === undefined) name = n[1];
    const v = /^version\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
    if (v !== null && version === undefined) {
      version = v[1];
      versionLine = index + 1;
    }
  }
  close();
  return out.result();
}

// ---- entry ---------------------------------------------------------------------------------

/** Whether the file name is one of the pin files (intake classifies by this). */
export function isPinFileName(name: string): boolean {
  return (
    /^requirements[^/]*\.txt$/.test(name) ||
    name === 'pyproject.toml' ||
    name === 'poetry.lock' ||
    name === 'uv.lock'
  );
}

export function readPythonPins(file: InputFile, pkg: PinPackage): PinReading {
  const path = rawInputTextForParser(file.canonicalPath);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const text = rawTextForParser(file);
  if (/^requirements[^/]*\.txt$/.test(name)) return readRequirements(text, pkg);
  if (name === 'pyproject.toml') return readPyproject(text, pkg);
  if (name === 'poetry.lock' || name === 'uv.lock') return readLock(text, pkg);
  return NONE;
}
