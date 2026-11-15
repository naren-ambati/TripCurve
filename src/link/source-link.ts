// Ties application source to a workload by explicit evidence only, in this order:
//   1. a declared `source:` in tripcurve.yaml;
//   2. the container command's literal file (`command: ["node", "src/server.ts"]`);
//   3. an npm script (`npm start`, `npm run x`) whose script is `node <literal file>`,
//      read from the package.json nearest to the manifest;
//   4. otherwise unlinked, and everything that lives in source is unresolved.
// A declared source that cannot be used does NOT fall through to the command:
// the declaration is the user's statement, so a failure of it is reported as it is.
// Every linked path is confined to the root. Nothing is executed.
//
// Where a command's relative file is looked for: a relative path
// means "relative to the container's working directory", which the files do not give.
//   - a container that sets `workingDir` cannot be mapped to a repository folder:
//     unresolved, unless a `source:` is declared;
//   - otherwise the path is tried against every folder from the manifest's own folder up
//     to the root; exactly one file is used and the folder is recorded as an assumption,
//     more than one is unresolved, none is unlinked.
// The npm route resolves against the package.json folder, as npm does.
//
// Code Node runs before the entry file: preload flags in the command,
// the args or the npm script, and `NODE_OPTIONS` in the container env. A literal local file
// is read as part of the search; anything else is a gap that makes the search incomplete.
// An npm `pre<script>` entry for the script being run (`prestart` for `npm start`) runs
// code before the server, and it can generate or alter files the server then loads, so it
// is a gap (second review pass, N2). A `post<script>` runs after the server stops and
// cannot change the server's runtime settings, so it is NOT a gap and is never read.
//
// `--env-file` and `--env-file-if-exists` (command, args, npm script or NODE_OPTIONS) load
// environment variables from a file, and those include NODE_OPTIONS. Lookup 2026-11-11,
// https://nodejs.org/docs/latest-v22.x/api/cli.html (and the v24 and v26 pages), the
// `--env-file` entry (added v20.6.0, `--env-file-if-exists` v22.9.0, no longer experimental
// from v22.21.0 and v24.10.0): "The environment variables which configure Node.js, such as
// NODE_OPTIONS, are parsed and applied." tripcurve reads no `.env` file (intake does not
// classify one), so every such flag is always a gap: "environment file not read".
//
// NODE_OPTIONS spellings. The v24 page (read 2026-11-11) says: "Options are separated by
// whitespace. Prefixes in options are stripped, allowing options to be passed as environment
// variables without leading dashes. Underscores instead of dashes are allowed for Node.js
// options as well." Run against Node 22.23.2, 22.23.5, 24.22.3 and 26.13.1 on 2026-11-11 (table in
// docs/limits.md), the code-loading options accepted are `-r`, `--require`, `--import`,
// `--loader` and `--experimental-loader` (also with `_` for `-`), with a space or `=`, and with
// double quotes around the option. A name with no dashes, an upper-case name, a single-quoted name
// and `-r=x` did not load. `--env-file` is refused by Node in NODE_OPTIONS. The guard is a superset:
// names are matched after stripping leading dashes, turning `_` into `-` and lower-casing, against
// exactly r, require, import, loader, experimental-loader, env-file and env-file-if-exists; a
// value with a quote or a backslash is a gap.

import { posix } from 'node:path';
import {
  declaredSource,
  type InputText,
  inputText,
  inputTextEquals,
  isInputText,
  isSourcedValue,
  isUnresolved,
  type SourceRef,
} from '../core/index.js';
import {
  type ConfigLink,
  confineToRoot,
  type InputClass,
  type InputFile,
  type IntakeResult,
  type K8sContainer,
  type K8sStringList,
  type NodePreloads,
  type NodeSearchGap,
  rawInputTextForParser,
  rawTextForParser,
} from '../parse/index.js';
import type { SourceLink, SourceUnlinkedReason } from './model.js';

/** Node options whose value is code that runs before the entry file. */
const NODE_PRELOAD_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
]);
/** Node options whose value is a string of code to run: the entry is not a file, and the code is not read. */
const NODE_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
/** Node options that take the next word as their value, so it is not the entry file. */
const NODE_OTHER_VALUE_FLAGS = new Set(['--inspect-port', '--title', '--conditions', '-C']);
/** Node options after which the next word is code, not a file: nothing to link. */
const NODE_CODE_FLAGS = new Set(['-c', '--check', '-i']);

/**
 * Characters that make an npm script more than `node <file>`: quoting, chaining,
 * expansion. `=` is allowed in a word that starts with `-` (`--require=./x.js`) and
 * checked per word below, because `NAME=value node x.js` sets the environment.
 */
const SHELL_SPECIAL = /[;&|<>`$(){}\\'"*?!#\n\r]/;

export function basenameOf(word: string): string {
  const slash = word.lastIndexOf('/');
  return slash < 0 ? word : word.slice(slash + 1);
}

/** The literal words of the container's command followed by its args, or undefined. */
export function literalArgv(container: K8sContainer): string[] | undefined {
  const words = (list: K8sStringList | undefined): string[] | undefined => {
    if (list === undefined || isUnresolved(list)) return undefined;
    const out: string[] = [];
    for (const item of list.items) {
      if (!isInputText(item.value)) return undefined;
      out.push(rawInputTextForParser(item.value));
    }
    return out;
  };
  const command = words(container.command);
  if (command === undefined) return undefined; // args alone do not say what runs
  if (container.args === undefined) return command;
  const args = words(container.args);
  return args === undefined ? undefined : [...command, ...args];
}

export type EntryWord =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly reasonCode: 'not-a-node-command' | 'command-names-no-file' };

/** One piece of code Node runs before the entry file: a literal local path, or something not read. */
export type PreloadFlag =
  | { readonly kind: 'file'; readonly specifier: string }
  | { readonly kind: 'opaque' }
  /** `--env-file` or `--env-file-if-exists`: variables, `NODE_OPTIONS` among them, come from a file not read. */
  | { readonly kind: 'env-file' };

/** A path that starts with `./` or `../` names a file in the repository; a bare name is a package. */
function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function preloadOf(value: string): PreloadFlag {
  return isLocalSpecifier(value) ? { kind: 'file', specifier: value } : { kind: 'opaque' };
}

interface NodeScan {
  readonly entry: EntryWord;
  readonly flags: PreloadFlag[];
}

/**
 * Walks `node [options] <file>`: the entry file, and every option that runs code
 * before it. With `entryStops` false (NODE_OPTIONS) a word that is not an option is
 * skipped, not taken as the entry.
 */
function scanNode(words: readonly string[], entryStops: boolean): NodeScan {
  const flags: PreloadFlag[] = [];
  const noFile = { ok: false, reasonCode: 'command-names-no-file' } as const;
  let i = entryStops ? 1 : 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (entryStops && word === '--') {
      const next = words[i + 1];
      return { entry: next === undefined ? noFile : { ok: true, file: next }, flags };
    }
    if (!word.startsWith('-')) {
      if (entryStops) return { entry: { ok: true, file: word }, flags };
      i += 1;
      continue;
    }
    const eq = word.indexOf('=');
    const name = eq > 0 ? word.slice(0, eq) : word;
    if (name === '--env-file' || name === '--env-file-if-exists') {
      flags.push({ kind: 'env-file' });
      i += eq > 0 ? 1 : 2;
    } else if (eq > 0) {
      if (NODE_PRELOAD_FLAGS.has(name)) flags.push(preloadOf(word.slice(eq + 1)));
      else if (NODE_EVAL_FLAGS.has(name)) {
        flags.push({ kind: 'opaque' });
        if (entryStops) return { entry: noFile, flags };
      }
      i += 1;
    } else if (NODE_PRELOAD_FLAGS.has(word)) {
      const value = words[i + 1];
      if (value !== undefined) flags.push(preloadOf(value));
      i += 2;
    } else if (NODE_EVAL_FLAGS.has(word)) {
      flags.push({ kind: 'opaque' }); // the string is code; it is not read
      if (entryStops) return { entry: noFile, flags };
      i += 2;
    } else if (NODE_CODE_FLAGS.has(word) && entryStops) {
      return { entry: noFile, flags };
    } else {
      i += NODE_OTHER_VALUE_FLAGS.has(word) ? 2 : 1;
    }
  }
  return { entry: noFile, flags };
}

/** `node [options] <file> ...`: the literal file, or why there is none. */
export function nodeEntryFile(words: readonly string[]): EntryWord {
  const first = words[0];
  if (first === undefined) return { ok: false, reasonCode: 'not-a-node-command' };
  const program = basenameOf(first);
  if (program !== 'node' && program !== 'nodejs') {
    return { ok: false, reasonCode: 'not-a-node-command' };
  }
  return scanNode(words, true).entry;
}

/** The options of a node command line that run code before the entry file. */
function nodeCommandFlags(words: readonly string[] | undefined): PreloadFlag[] {
  const first = words?.[0];
  if (words === undefined || first === undefined) return [];
  const program = basenameOf(first);
  return program === 'node' || program === 'nodejs' ? scanNode(words, true).flags : [];
}

/** `npm start`, `npm run <name>`, `npm run-script <name>`: the script name, or undefined. */
export function npmScriptName(words: readonly string[]): string | undefined {
  const first = words[0];
  if (first === undefined || basenameOf(first) !== 'npm') return undefined;
  const verb = words[1];
  if (verb === 'start') return 'start';
  if (verb === 'run' || verb === 'run-script') {
    const name = words[2];
    return name === undefined || name.startsWith('-') ? undefined : name;
  }
  return undefined;
}

/** The script text of a package.json, when it is a plain string; never throws. */
export function packageScript(packageJson: InputFile, name: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTextForParser(packageJson));
  } catch {
    return undefined; // a file that is not JSON, or nested past the stack, has no usable script
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (!Object.hasOwn(parsed, 'scripts')) return undefined;
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return undefined;
  if (!Object.hasOwn(scripts, name)) return undefined;
  const text = (scripts as Record<string, unknown>)[name];
  return typeof text === 'string' ? text : undefined;
}

/** Whether the package.json has a `scripts` entry of this name (any value: it still runs). */
export function packageHasScript(packageJson: InputFile, name: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTextForParser(packageJson));
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  if (!Object.hasOwn(parsed, 'scripts')) return false;
  const scripts = (parsed as Record<string, unknown>).scripts;
  return typeof scripts === 'object' && scripts !== null && Object.hasOwn(scripts, name);
}

export interface SourceLinkInput {
  readonly intake: IntakeResult;
  readonly container?: K8sContainer;
  readonly sourceLinks: readonly ConfigLink[];
  readonly configFile?: InputText;
  /** The package.json nearest to the manifest, if any. */
  readonly packageJson?: InputFile;
  /** The folder of the manifest, root-relative (`''` is the root). */
  readonly manifestDir?: string;
}

function unlinked(reasonCode: SourceUnlinkedReason, evidence?: SourceRef): SourceLink {
  return { state: 'unlinked', reasonCode, ...(evidence === undefined ? {} : { evidence }) };
}

function findSourceFile(
  intake: IntakeResult,
  canonicalPath: InputText,
  cls: InputClass = 'node-source',
): InputFile | undefined {
  return intake.files.find(
    (f) => f.class === cls && inputTextEquals(f.canonicalPath, canonicalPath),
  );
}

// ---------------------------------------------------------------- code before the entry

const NODE_OPTIONS = inputText('NODE_OPTIONS');

/** Every piece of code Node runs before the entry file that the container's configuration shows. */
interface PreloadEvidence {
  readonly flags: readonly PreloadFlag[];
  readonly gaps: readonly NodeSearchGap[];
}

/**
 * The tokens of a NODE_OPTIONS value. The name of each is read with its leading dashes
 * stripped and underscores as dashes (see the header). Anything that could be a preload,
 * an env file or an eval, or that starts with `r` and is not understood, is not read.
 */
function scanNodeOptions(tokens: readonly string[]): PreloadFlag[] {
  const flags: PreloadFlag[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    const eq = token.indexOf('=');
    const name = (eq >= 0 ? token.slice(0, eq) : token)
      .replace(/^-+/, '')
      .replaceAll('_', '-')
      .toLowerCase();
    if (
      name === 'r' ||
      name === 'require' ||
      name === 'import' ||
      name === 'loader' ||
      name === 'experimental-loader'
    ) {
      const value = eq >= 0 ? token.slice(eq + 1) : tokens[i + 1];
      flags.push(value === undefined ? { kind: 'opaque' } : preloadOf(value));
      i += eq >= 0 ? 1 : 2;
      continue;
    }
    // `--env-file` is refused in NODE_OPTIONS by the Node versions tried (docs/limits.md); kept as a superset.
    if (name === 'env-file' || name === 'env-file-if-exists') flags.push({ kind: 'env-file' });
    else if (name === 'e' || name === 'eval' || name === 'p' || name === 'print') {
      flags.push({ kind: 'opaque' });
    }
    i += 1;
  }
  return flags;
}

function nodeOptionsEvidence(container: K8sContainer | undefined): PreloadEvidence {
  if (container === undefined) return { flags: [], gaps: [] };
  const flags: PreloadFlag[] = [];
  const gaps: NodeSearchGap[] = [];
  // Any envFrom could inject NODE_OPTIONS from a config map or secret that is not read.
  if (container.envFromSource !== undefined) gaps.push('node-options-not-read');
  for (const v of container.env) {
    if (!inputTextEquals(v.name, NODE_OPTIONS)) continue;
    if (isSourcedValue(v.value) && isInputText(v.value.value)) {
      const text = rawInputTextForParser(v.value.value);
      // How Node reads a quote or a backslash in NODE_OPTIONS is not established: not read.
      if (/["'\\]/.test(text)) flags.push({ kind: 'opaque' });
      else {
        // not push(...list): a hostile value of very many options would overflow the stack
        for (const flag of scanNodeOptions(text.split(/\s+/).filter((w) => w !== ''))) {
          flags.push(flag);
        }
      }
    } else {
      gaps.push('node-options-not-read'); // valueFrom, or a value that is not text
    }
  }
  return { flags, gaps };
}

/** The script of `npm start` / `npm run x`, as words, or undefined when it is not a plain command. */
function npmScriptWords(
  words: readonly string[] | undefined,
  packageJson: InputFile | undefined,
): readonly string[] | undefined {
  if (words === undefined || packageJson === undefined) return undefined;
  const name = npmScriptName(words);
  if (name === undefined) return undefined;
  const script = packageScript(packageJson, name);
  if (script === undefined || SHELL_SPECIAL.test(script)) return undefined;
  const scriptWords = script.split(/\s+/).filter((w) => w !== '');
  if (scriptWords.some((w) => w.includes('=') && !w.startsWith('-'))) return undefined;
  return scriptWords;
}

/**
 * What runs before the entry file, as the input for the source reader. `base` is the
 * root-relative folder local preload paths are relative to; without one (a declared source
 * names a file, not a working directory) a local path cannot be located, so it is a gap.
 */
function preloadsFor(
  input: SourceLinkInput,
  argv: readonly string[] | undefined,
  scriptWords: readonly string[] | undefined,
  base: string | undefined,
): NodePreloads {
  const env = nodeOptionsEvidence(input.container);
  const flags: PreloadFlag[] = [
    ...nodeCommandFlags(argv),
    ...nodeCommandFlags(scriptWords),
    ...env.flags,
  ];
  const files: { base: InputText; specifier: InputText }[] = [];
  const gaps = new Set<NodeSearchGap>(env.gaps);
  for (const flag of flags) {
    if (flag.kind === 'file' && base !== undefined) {
      files.push({ base: inputText(base), specifier: inputText(flag.specifier) });
    } else if (flag.kind === 'env-file') gaps.add('env-file-not-read');
    else gaps.add('preload-not-read');
  }
  // `npm start` / `npm run x` run `prestart` / `prex` first when the package.json has one.
  const all = input.container === undefined ? undefined : literalArgv(input.container);
  const name = all === undefined ? undefined : npmScriptName(all);
  if (
    name !== undefined &&
    input.packageJson !== undefined &&
    packageHasScript(input.packageJson, `pre${name}`)
  ) {
    gaps.add('npm-pre-script');
  }
  return { files, gaps: [...gaps] };
}

/** A command that runs `npm start` or `npm run x` whose script is not understood could preload anything. */
function declaredRoutePreloads(
  input: SourceLinkInput,
  argv: readonly string[] | undefined,
): NodePreloads {
  const name = argv === undefined ? undefined : npmScriptName(argv);
  const script = npmScriptWords(argv, input.packageJson);
  const base = preloadsFor(input, argv, script, undefined);
  if (name === undefined || script !== undefined) return base;
  return { files: base.files, gaps: [...new Set([...base.gaps, 'preload-not-read' as const])] };
}

// ---------------------------------------------------------------- where the file is

export type Confined =
  | { readonly state: 'file'; readonly entry: InputFile }
  | { readonly state: 'no-file'; readonly reasonCode: SourceUnlinkedReason };

/**
 * Confines a path written in an input file to the root and finds the file of class `cls`
 * it names (a Node source file by default; B2 reuses this for `gunicorn.conf.py`).
 */
export function confineSource(
  intake: IntakeResult,
  path: string,
  cls: InputClass = 'node-source',
): Confined {
  // A container runs on Linux: paths are case-sensitive and a file has no trailing slash.
  // macOS resolves both, so check what the host file system accepted (second review pass, N6).
  if (path.endsWith('/')) return { state: 'no-file', reasonCode: 'unreadable' };
  let confined: ReturnType<typeof confineToRoot>;
  try {
    confined = confineToRoot(intake, inputText(path));
  } catch {
    return { state: 'no-file', reasonCode: 'unreadable' };
  }
  if (!confined.ok) return { state: 'no-file', reasonCode: confined.reasonCode };
  // A path that differs from the typed one only by case was matched by a case-insensitive
  // host; on Linux it names no file. (A symlink differs by more than case and is kept.)
  const typed = posix.normalize(path).replace(/^\.\//, '');
  const real = rawInputTextForParser(confined.canonicalPath);
  if (real !== typed && real.toLowerCase() === typed.toLowerCase()) {
    return { state: 'no-file', reasonCode: 'unreadable' };
  }
  const entry = findSourceFile(intake, confined.canonicalPath, cls);
  return entry === undefined
    ? { state: 'no-file', reasonCode: 'not-read-as-source' }
    : { state: 'file', entry };
}

function linkedOrUnlinked(
  intake: IntakeResult,
  path: string,
  by: 'declared' | 'command' | 'npm-script',
  evidence: SourceRef,
  preloads: NodePreloads,
): SourceLink {
  const found = confineSource(intake, path);
  return found.state === 'file'
    ? { state: 'linked', by, entry: found.entry, evidence, preloads }
    : unlinked(found.reasonCode, evidence);
}

/** The folders from `dir` up to the root, nearest first (`''` is the root). */
export function foldersUp(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === '') return out;
    const slash = current.lastIndexOf('/');
    current = slash < 0 ? '' : current.slice(0, slash);
  }
}

/**
 * The command's relative file, tried from the manifest's folder up to the root. Exactly
 * one file is used (and its folder is the assumption); more than one is not decided.
 */
function linkCommandFile(
  input: SourceLinkInput,
  file: string,
  evidence: SourceRef,
  argv: readonly string[],
): SourceLink {
  const found: { dir: string; entry: InputFile }[] = [];
  let failure: SourceUnlinkedReason = 'unreadable';
  for (const dir of foldersUp(input.manifestDir ?? '')) {
    const path = posix.join(dir, file);
    if (path === '..' || path.startsWith('../')) {
      failure = 'outside-root';
      continue;
    }
    const hit = confineSource(input.intake, path);
    if (hit.state === 'file') {
      if (!found.some((f) => f.entry === hit.entry)) found.push({ dir, entry: hit.entry });
    } else if (hit.reasonCode !== 'unreadable' && failure === 'unreadable') {
      failure = hit.reasonCode;
    }
  }
  const [only, ...more] = found;
  if (only === undefined) return unlinked(failure, evidence);
  if (more.length > 0) return unlinked('several-files-match', evidence);
  return {
    state: 'linked',
    by: 'command',
    entry: only.entry,
    evidence,
    assumedWorkingDir: inputText(only.dir === '' ? '.' : only.dir),
    preloads: preloadsFor(input, argv, undefined, only.dir),
  };
}

export function linkSource(input: SourceLinkInput): SourceLink {
  const declared = input.sourceLinks[0];
  const container = input.container;
  const words = container === undefined ? undefined : literalArgv(container);
  if (declared !== undefined) {
    const evidence = declaredSource(input.configFile ?? inputText('tripcurve.yaml'), declared.line);
    // The path is the user's own word in tripcurve.yaml, resolved against the root.
    return linkedOrUnlinked(
      input.intake,
      rawInputTextForParser(declared.target),
      'declared',
      evidence,
      declaredRoutePreloads(input, words),
    );
  }
  if (container === undefined) return unlinked('no-container');
  const commandSource =
    container.command !== undefined && !isUnresolved(container.command)
      ? container.command.source
      : container.source;
  if (words === undefined) return unlinked('no-command', container.source);

  const entry = nodeEntryFile(words);
  if (entry.ok) {
    // A path inside the container (absolute) says nothing about the files under the root.
    if (entry.file.startsWith('/')) return unlinked('absolute-path', commandSource);
    // A relative path is relative to the container's working directory, which is not mapped.
    if (container.workingDirSource !== undefined) {
      return unlinked('working-dir-not-mapped', commandSource);
    }
    return linkCommandFile(input, entry.file, commandSource, words);
  }
  const scriptName = npmScriptName(words);
  if (scriptName === undefined) return unlinked(entry.reasonCode, commandSource);
  const pkg = input.packageJson;
  if (pkg === undefined) return unlinked('script-not-found', commandSource);
  const script = packageScript(pkg, scriptName);
  if (script === undefined) return unlinked('script-not-found', commandSource);
  if (SHELL_SPECIAL.test(script)) return unlinked('script-not-literal', commandSource);
  const scriptWords = script.split(/\s+/).filter((w) => w !== '');
  // `NAME=value node x.js` sets the environment: not a plain node command.
  if (scriptWords.some((w) => w.includes('=') && !w.startsWith('-'))) {
    return unlinked('script-not-literal', commandSource);
  }
  const scriptEntry = nodeEntryFile(scriptWords);
  if (!scriptEntry.ok) return unlinked('script-not-literal', commandSource);
  if (scriptEntry.file.startsWith('/')) return unlinked('absolute-path', commandSource);
  if (container.workingDirSource !== undefined) {
    return unlinked('working-dir-not-mapped', commandSource);
  }
  // npm runs the script in the directory of its package.json.
  const base = posix.dirname(rawInputTextForParser(pkg.canonicalPath));
  return linkedOrUnlinked(
    input.intake,
    posix.join(base, scriptEntry.file),
    'npm-script',
    commandSource,
    preloadsFor(input, undefined, scriptWords, base === '.' ? '' : base),
  );
}
