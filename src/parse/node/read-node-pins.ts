// The exact version of one npm package (lightship, bolt B4) a Node project uses, read from the
// files that say so, with a small hand-written reader and no new dependency. Files read:
//   - `package.json`: `dependencies`, `devDependencies`, `optionalDependencies` and
//     `peerDependencies` (an exact `X.Y.Z` is a pin; a range, a tag or `*` is not evidence);
//   - `package-lock.json` and `npm-shrinkwrap.json` (lockfile 1, 2 and 3): the `version` of the
//     package, in `packages["node_modules/<name>"]` or in `dependencies.<name>`;
//   - `yarn.lock` (classic and berry): the `version` of the block whose header names the package;
//   - `pnpm-lock.yaml`: the version in a `packages:` or `snapshots:` key.
// Only an EXACT version is evidence. A form this reader does not understand (a pre-release, an alias,
// a git or file or link spec, an override that names the package, a lock file that does not parse) is
// `unreadable`: it is never skipped, because the version it names may differ from any other. Two
// different versions in one file are a `conflict`. Pure text; nothing is run; every loop is linear.
// The folder rules (nearest folder wins, an unreadable form is UNRESOLVED, an Assumption names the
// file) are the resolver's, as for the Python pins (src/resolve/python-version.ts).

import { type InputFile, rawInputTextForParser, rawTextForParser } from '../intake/index.js';

export type NodePinReading =
  /** The package is not named in this file. */
  | { readonly state: 'none' }
  /** Named, but not with an exact version (a range or a tag): not evidence, and the file still speaks for the package. */
  | { readonly state: 'unpinned' }
  | { readonly state: 'pin'; readonly version: string; readonly line: number }
  | { readonly state: 'conflict' }
  | { readonly state: 'unreadable' };

const NONE: NodePinReading = { state: 'none' };
const UNREADABLE: NodePinReading = { state: 'unreadable' };

/** `X.Y.Z`, no leading zeros (`9.1.01` is not a version npm writes). */
const NUMBER = '(?:0|[1-9][0-9]{0,8})';
const PLAIN_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}$`);
const DOTTED_DIGITS = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/** Whether the file name is a lock file this reader knows (intake classifies by this). */
export function isNodeLockFileName(name: string): boolean {
  return (
    name === 'package-lock.json' ||
    name === 'npm-shrinkwrap.json' ||
    name === 'yarn.lock' ||
    name === 'pnpm-lock.yaml'
  );
}

class Collector {
  private readonly pins = new Map<string, number>();
  private unreadable = false;
  private unpinned = false;

  pin(version: string, line: number): void {
    if (!this.pins.has(version)) this.pins.set(version, line);
  }
  unpin(): void {
    this.unpinned = true;
  }
  bad(): void {
    this.unreadable = true;
  }
  /** A version text of an installed package: a plain `X.Y.Z` is a pin, anything else is not read. */
  installed(version: unknown, line: number): void {
    if (typeof version === 'string' && PLAIN_VERSION.test(version)) this.pin(version, line);
    else this.bad();
  }
  result(): NodePinReading {
    if (this.unreadable) return UNREADABLE;
    if (this.pins.size > 1) return { state: 'conflict' };
    const first = this.pins.entries().next();
    if (first.done !== true) return { state: 'pin', version: first.value[0], line: first.value[1] };
    return this.unpinned ? { state: 'unpinned' } : NONE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const lines = (text: string): string[] => text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

/** The 1-based line of the first line that mentions `"<name>"` (as a JSON key), or 1. */
function lineOfKey(text: string, name: string): number {
  const at = lines(text).findIndex((l) => l.includes(`"${name}"`));
  return at < 0 ? 1 : at + 1;
}

// ---- package.json ----------------------------------------------------------------------------

const DEPENDENCY_TABLES = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** True when `value` (any depth, iterative) has an object key that is, or ends with `>`/`/`, the package name. */
function namesPackage(value: unknown, name: string, budget = 100_000): boolean {
  const stack: unknown[] = [value];
  let steps = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    steps += 1;
    if (steps > budget) return true; // too large to search: not read
    if (Array.isArray(item)) {
      for (const x of item) stack.push(x);
    } else if (isRecord(item)) {
      for (const key of Object.keys(item)) {
        if (key === name || key.endsWith(`>${name}`) || key.endsWith(`/${name}`)) return true;
        stack.push(item[key]);
      }
    }
  }
  return false;
}

function specOf(spec: unknown, out: Collector, line: number): void {
  if (typeof spec !== 'string') {
    out.bad();
    return;
  }
  const s = spec.trim();
  if (PLAIN_VERSION.test(s)) out.pin(s, line);
  else if (DOTTED_DIGITS.test(s))
    out.bad(); // a padded or very long number: not read
  else if (
    /^[\^~><=*xX]/.test(s) ||
    /^[0-9]+(?:\.[0-9xX*]+)?(?:\.[xX*])?$/.test(s) ||
    /^(?:latest|next|beta|alpha|rc)$/.test(s) ||
    s.includes('||') ||
    / - /.test(s) ||
    s === ''
  ) {
    out.unpin();
  } else out.bad(); // an alias, a URL, a path, a workspace or link protocol, a pre-release, `v9.1.0`
}

function readPackageJson(text: string, name: string): NodePinReading {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // a package.json that does not parse cannot be told not to name the package
    return text.includes(`"${name}"`) ? UNREADABLE : NONE;
  }
  if (!isRecord(doc)) return NONE;
  const out = new Collector();
  const line = lineOfKey(text, name);
  for (const table of DEPENDENCY_TABLES) {
    const t = own(doc, table);
    if (t === undefined) continue;
    if (!isRecord(t)) {
      out.bad();
      continue;
    }
    if (Object.hasOwn(t, name)) specOf(t[name], out, line);
  }
  // overrides and resolutions can change which version is installed
  const pnpm = own(doc, 'pnpm');
  for (const field of [own(doc, 'overrides'), own(doc, 'resolutions'), pnpm]) {
    if (field !== undefined && namesPackage(field, name)) out.bad();
  }
  // a package that is a bundled or workspace-provided dependency under another table name
  const bundled = own(doc, 'bundledDependencies') ?? own(doc, 'bundleDependencies');
  if (Array.isArray(bundled) && bundled.includes(name)) out.bad();
  return out.result();
}

// ---- package-lock.json and npm-shrinkwrap.json --------------------------------------------------

function readNpmLock(text: string, name: string): NodePinReading {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  if (!isRecord(doc)) return UNREADABLE;
  const out = new Collector();
  const line = lineOfKey(text, `node_modules/${name}`);
  const packages = own(doc, 'packages');
  if (isRecord(packages)) {
    for (const key of Object.keys(packages)) {
      if (key !== `node_modules/${name}` && !key.endsWith(`/node_modules/${name}`)) continue;
      const entry = packages[key];
      if (
        !isRecord(entry) ||
        own(entry, 'link') === true ||
        own(entry, 'inBundle') === true ||
        // an npm alias installs another package under this name
        (own(entry, 'name') !== undefined && own(entry, 'name') !== name)
      ) {
        out.bad();
      } else out.installed(own(entry, 'version'), line);
    }
  }
  // lockfileVersion 1 (and the `dependencies` view of 2): nested `dependencies` objects
  const stack: unknown[] = [own(doc, 'dependencies')];
  const depLine = lineOfKey(text, name);
  let steps = 0;
  while (stack.length > 0) {
    const deps = stack.pop();
    steps += 1;
    if (steps > 200_000) {
      out.bad();
      break;
    }
    if (!isRecord(deps)) continue;
    for (const key of Object.keys(deps)) {
      const entry = deps[key];
      if (!isRecord(entry)) continue;
      if (key === name) out.installed(own(entry, 'version'), depLine);
      stack.push(own(entry, 'dependencies'));
    }
  }
  return out.result();
}

// ---- yarn.lock -------------------------------------------------------------------------------------

function stripQuotes(s: string): string {
  const t = s.trim();
  return t.length >= 2 && (t.startsWith('"') || t.startsWith("'")) && t.endsWith(t[0] as string)
    ? t.slice(1, -1)
    : t;
}

/** `lightship@^9.1.0` or `lightship@npm:^9.1.0`: the package name and the range. */
function splitSpec(spec: string): { name: string; range: string } | undefined {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  if (at <= 0) return undefined;
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

function readYarnLock(text: string, name: string): NodePinReading {
  const out = new Collector();
  const all = lines(text);
  for (let i = 0; i < all.length; i += 1) {
    const header = all[i] as string;
    if (header === '' || header.startsWith(' ') || header.startsWith('#')) continue;
    if (!header.trimEnd().endsWith(':')) continue;
    const specs = header
      .trimEnd()
      .slice(0, -1)
      .split(',')
      .map((s) => splitSpec(stripQuotes(s)));
    const mine = specs.filter((s) => s?.name === name);
    if (mine.length === 0) continue;
    // an alias (`lightship@npm:other@1.0.0`) installs a different package under this name
    if (mine.some((s) => s?.range.startsWith('npm:') && s.range.includes('@'))) {
      out.bad();
      continue;
    }
    let version: string | undefined;
    for (let j = i + 1; j < all.length; j += 1) {
      const body = all[j] as string;
      if (body !== '' && !body.startsWith(' ')) break;
      const m = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/.exec(body);
      if (m !== null) {
        version = m[1];
        break;
      }
    }
    if (version === undefined) out.bad();
    else out.installed(version, i + 1);
  }
  return out.result();
}

// ---- pnpm-lock.yaml --------------------------------------------------------------------------------

function readPnpmLock(text: string, name: string): NodePinReading {
  const out = new Collector();
  let section = '';
  const key = new RegExp(
    `^ {2}['"]?/?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@([^\\s'"():]+)`,
  );
  const all = lines(text);
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i] as string;
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('#')) {
      section = line.replace(/:.*$/, '').trim();
      if (section === 'overrides' || section === 'patchedDependencies') {
        // an override or a patch can change the version that is installed
        let j = i + 1;
        while (
          j < all.length &&
          ((all[j] as string) === '' || (all[j] as string).startsWith(' '))
        ) {
          if ((all[j] as string).includes(name)) out.bad();
          j += 1;
        }
      }
      continue;
    }
    if (section !== 'packages' && section !== 'snapshots') continue;
    const m = key.exec(line);
    if (m !== null) out.installed(m[1], i + 1);
  }
  return out.result();
}

// ---- entry -----------------------------------------------------------------------------------------

/** What one file says about the package. */
export function readNodePackagePin(file: InputFile, name: string): NodePinReading {
  const path = rawInputTextForParser(file.canonicalPath);
  const base = path.slice(path.lastIndexOf('/') + 1);
  const text = rawTextForParser(file);
  if (base === 'package.json') return readPackageJson(text, name);
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json')
    return readNpmLock(text, name);
  if (base === 'yarn.lock') return readYarnLock(text, name);
  if (base === 'pnpm-lock.yaml') return readPnpmLock(text, name);
  return NONE;
}
