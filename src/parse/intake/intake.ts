// Intake: find, classify and bound the input.
//
// This is the only code that opens a path. It is also the only code allowed to
// turn an InputText back into a string (`unwrapForIo`; see
// test/core/input-text-scan.test.ts). Everything it cannot read or that is over
// a limit becomes an UncheckedInput with a fixed reason code and the run goes on.

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileSource, type InputText, inputText, stdinSource } from '../../core/index.js';
import { unwrapForIo } from '../../core/safe-text.js';
import {
  classifyByName,
  classifyShowJson,
  classifyYamlContent,
  couldBeCfnJson,
  couldBeK8sText,
  hasPlainK8sLines,
  isCfnTemplateValue,
  isJsonName,
  isK8sCandidateValue,
  isShowJsonValue,
  isYamlName,
} from './classify.js';
import { decodeUtf8, readBounded, readHeadBytes, readStreamBounded } from './read-file.js';
import {
  DEFAULT_LIMITS,
  type InputClass,
  type InputFile,
  type IntakeLimits,
  type IntakeResult,
  STDIN,
  type UncheckedInput,
  type UncheckedReason,
  YAML_CLASSES,
} from './types.js';
import { compareBytes, isInside, toPosix, walkRoot } from './walk.js';
import { parseYamlDocuments } from './yaml-documents.js';

export interface IntakeOptions {
  /** The directory (or one file) to check. */
  readonly root: string;
  /** An explicit configuration file (--config); it may lie outside the root. */
  readonly configPath?: string;
  readonly limits?: IntakeLimits;
}

export interface StdinOptions {
  /** The descriptor to read; 0 is standard input. */
  readonly fd?: number;
  /** With `-` no tripcurve.yaml is looked up; a file is read only when named here. */
  readonly configPath?: string;
  readonly limits?: IntakeLimits;
}

// The real root of each result, kept out of the public shape (it is a path, not input text).
const rootsOfResults = new WeakMap<IntakeResult, string>();

export type RootInspection =
  | { readonly ok: true; readonly kind: 'directory' | 'file' }
  | { readonly ok: false };

/**
 * CliApp's check before any file is read: does an explicit
 * root exist and can it be read? A directory must be listable.
 */
export function inspectRoot(root: string): RootInspection {
  try {
    const real = realpathSync.native(root);
    const st = statSync(real);
    if (st.isDirectory()) {
      readdirSync(real); // listing is the permission test; the walk repeats it per directory
      return { ok: true, kind: 'directory' };
    }
    if (st.isFile()) return { ok: true, kind: 'file' };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function byCanonical(a: InputFile, b: InputFile): number {
  return compareBytes(unwrapForIo(a.canonicalPath), unwrapForIo(b.canonicalPath));
}

const STRAY_WAIVER = /(?:^|[ \t])(#[ \t]*tripcurve:.*)$/;

/** The lines that carry a `# tripcurve:` comment, found without parsing the YAML: linear in the text. */
function strayWaiverLines(text: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let line = 1;
  for (let from = 0; from <= text.length; line += 1) {
    let to = text.indexOf('\n', from);
    if (to === -1) to = text.length;
    const end = to > from && text.charCodeAt(to - 1) === 13 ? to - 1 : to;
    const row = text.slice(from, end);
    if (row.includes('#')) {
      const m = STRAY_WAIVER.exec(row);
      if (m !== null) found.push({ line, text: m[1] as string });
    }
    from = to + 1;
  }
  return found;
}

function lineIndexOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function uncheckedEntry(
  path: InputText | typeof STDIN,
  reasonCode: UncheckedReason,
  line?: number,
): UncheckedInput {
  return line === undefined ? { path, reasonCode } : { path, reasonCode, line };
}

interface FileJob {
  readonly real: string;
  /** The canonical path text shown to the user. */
  readonly canonical: string;
  readonly classHint: InputClass | undefined;
  /** The one file the person named as the root: a `.json` file is then read as `terraform show -json` output when it looks like it (B5). */
  readonly sniffJson?: boolean;
}

interface Collected {
  readonly files: InputFile[];
  readonly unchecked: UncheckedInput[];
  /** Waiver comments of YAML files tripcurve does not classify (a values file, a comment-only file). */
  readonly strays: { path: InputText; line: number; text: InputText }[];
}

// The documented deploy limit of a template body (1 MB, docs/lookups-b12.txt): any deployable template has its
// markers inside this window, and the read stays bounded.
const HEAD_BYTES = 1_048_576;

/**
 * True when the raw bytes of a file that failed to read may be a template: an ASCII marker of one, or bytes that
 * cannot be searched as text at all (a NUL byte, a UTF-16 byte-order mark), which are never ignored.
 */
function looksLikeTemplateBytes(head: Buffer): boolean {
  if (head.includes(0)) return true;
  if (
    head.length >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
  ) {
    return true;
  }
  const text = head.toString('latin1');
  return (
    text.includes('AWSTemplateFormatVersion') ||
    text.includes('AWS::Serverless') ||
    couldBeK8sText(text) ||
    (text.includes('"Type"') && text.includes('"AWS::')) ||
    (text.includes('"Resources"') && text.includes('"AWS::'))
  );
}

/** What a `.json` file with no name-based class may be, by its text: a candidate list that the parsed shape then decides. */
function jsonCandidates(
  text: string,
  sniffShow: boolean,
): { show: boolean; cfn: boolean; k8s: boolean } {
  return {
    show: sniffShow && classifyShowJson(text) !== undefined,
    cfn: couldBeCfnJson(text),
    k8s: couldBeK8sText(text),
  };
}

function readOne(job: FileJob, limits: IntakeLimits, out: Collected): void {
  const canonicalPath = inputText(job.canonical);
  const real = basename(job.real);
  const genericJson = job.classHint === undefined && !isYamlName(real) && isJsonName(real);
  const read = readBounded(job.real, limits.maxFileBytes);
  if (!read.ok) {
    // A `.json` file nothing names that fails to read (too large, not UTF-8): its first 1 MB of raw bytes decide. A
    // template marker there means it may be one, so it is reported with the real reason; without one it is ignored,
    // as any other file that is not known to be ours. A file that cannot be opened at all is reported.
    if (genericJson) {
      const head = readHeadBytes(job.real, HEAD_BYTES);
      if (head !== undefined && !looksLikeTemplateBytes(head)) return;
    }
    out.unchecked.push(uncheckedEntry(canonicalPath, read.reasonCode));
    return;
  }
  let cls: InputClass | 'both' | 'k8s-probe' | undefined;
  let ambiguousJson = false;
  let probed = false;
  if (job.classHint !== undefined) cls = job.classHint;
  else if (isYamlName(real)) cls = classifyYamlContent(read.text);
  else if (genericJson) {
    const c = jsonCandidates(read.text, job.sniffJson === true);
    if (c.show && c.cfn) {
      ambiguousJson = true;
      cls = 'cfn-template';
    } else if (c.show) cls = 'terraform-json';
    else if (c.cfn && c.k8s) cls = 'both';
    else if (c.cfn) cls = 'cfn-template';
    else if (c.k8s) cls = 'k8s-probe';
  }
  if (cls === undefined) {
    // Not one of ours: ignored without comment, except that a waiver comment in a YAML file is never
    // dropped (bolt B6 review): it names no workload, so the waiver applier lists it as invalid. The file
    // is never parsed (a hostile file would cost seconds): one linear pass over its lines finds the
    // comment lines. A line inside a block scalar that looks like one is listed too; a listed waiver is
    // never applied, so over-listing is safe and dropping one is the error.
    if (isYamlName(real)) stray(read.text, canonicalPath, out);
    return;
  }
  if (cls === 'k8s-probe') {
    // The words `apiVersion` and `kind` are in the text, but not as plain block-style lines (JSON, quoted keys, flow
    // style): the parsed documents decide. A document that is a mapping with a string `apiVersion` and a
    // string `kind` makes the file Kubernetes. A candidate that does not parse is reported, not ignored: it may be the
    // manifest it looks like . One that parses and holds no such mapping is not ours.
    const probe = parseYamlDocuments(read.text, limits, (_i, line) =>
      fileSource(canonicalPath, line),
    );
    if (!probe.documents.some((d) => isK8sCandidateValue(d.value))) {
      if (probe.documents.some((d) => Array.isArray(d.value)) && probe.issue === undefined) {
        // A root list with the two words and no object in it: it may be the manifest list it looks like, so it is
        // listed, not ignored.
        out.unchecked.push(uncheckedEntry(canonicalPath, 'object-not-identified'));
      } else if (probe.issue !== undefined) {
        out.unchecked.push(
          uncheckedEntry(canonicalPath, issueCode(probe.issue.reasonCode, real), probe.issue.line),
        );
      } else if (isYamlName(real)) {
        stray(read.text, canonicalPath, out);
      }
      return;
    }
    cls = 'k8s-yaml';
    probed = true;
  } else if (cls === 'both') {
    // The text fits Kubernetes and a template: the parsed documents decide. A file with a template document and a
    // Kubernetes object is reported, never guessed; one with only a template is read as one; the rest is Kubernetes.
    const probe = parseYamlDocuments(read.text, limits, (_i, line) =>
      fileSource(canonicalPath, line),
    );
    const template = probe.documents.some((d) => isCfnTemplateValue(d.value));
    const object = probe.documents.some((d) => isK8sCandidateValue(d.value));
    if (template && object) {
      out.unchecked.push(uncheckedEntry(canonicalPath, 'template-ambiguous'));
      return;
    }
    if (!template && !object && !hasPlainK8sLines(read.text)) {
      // The words were there but in no plain line, and the parsed documents hold neither shape : not ours,
      // unless the file did not parse, which is reported.
      if (probe.issue !== undefined) {
        out.unchecked.push(
          uncheckedEntry(canonicalPath, issueCode(probe.issue.reasonCode, real), probe.issue.line),
        );
      } else if (isYamlName(real)) stray(read.text, canonicalPath, out);
      return;
    }
    cls = template ? 'cfn-template' : 'k8s-yaml';
    probed = true;
  }
  if (cls === 'cfn-template' && isYamlName(real) && job.classHint === undefined && !probed) {
    // The text only made this YAML file a candidate. Decide by shape first, with an ordinary parse (alias limits
    // and all), so a file that is not a template (a values file, a workflow, a Compose file) is never parsed in
    // template mode and never reported as an unreadable template. Only a real template is parsed again, in
    // template mode, where its own problems are reported (bolt B12 review, second pass, R1).
    const probe = parseYamlDocuments(read.text, limits, (_i, line) =>
      fileSource(canonicalPath, line),
    );
    if (!probe.documents.some((d) => isCfnTemplateValue(d.value))) {
      if (probe.issue !== undefined) {
        // A candidate that does not parse: the ordinary YAML rules (a code and a line), as for any YAML file.
        out.unchecked.push(uncheckedEntry(canonicalPath, probe.issue.reasonCode, probe.issue.line));
      } else {
        stray(read.text, canonicalPath, out);
      }
      return;
    }
  }
  const lineIndex = lineIndexOf(read.text);
  if (!YAML_CLASSES.includes(cls)) {
    out.files.push({ canonicalPath, class: cls, text: inputText(read.text), lineIndex });
    return;
  }
  const parsed = parseYamlDocuments(
    read.text,
    limits,
    (_index, line) => fileSource(canonicalPath, line),
    { cfn: cls === 'cfn-template' },
  );
  let documents = parsed.documents;
  if (ambiguousJson) {
    // The text fits a Terraform plan and a template: the parsed shape decides, and a file that fits both is reported.
    const show = documents.some((d) => isShowJsonValue(d.value));
    const cfn = documents.some((d) => isCfnTemplateValue(d.value));
    if (show && cfn) {
      out.unchecked.push(uncheckedEntry(canonicalPath, 'template-ambiguous'));
      return;
    }
    cls = show ? 'terraform-json' : cfn ? 'cfn-template' : undefined;
    if (cls === undefined) {
      if (parsed.issue !== undefined) {
        out.unchecked.push(
          uncheckedEntry(
            canonicalPath,
            issueCode(parsed.issue.reasonCode, real),
            parsed.issue.line,
          ),
        );
      }
      return;
    }
  }
  if (cls === 'cfn-template') {
    // The text only made this file a candidate: a document that is not a template is not ours.
    const templates = documents.filter((d) => isCfnTemplateValue(d.value));
    if (templates.length === 0 && parsed.issue === undefined) {
      if (isYamlName(real)) stray(read.text, canonicalPath, out);
      return;
    }
    if (templates.length > 0 && documents.length > 1) {
      // A template is one document: a stream of several is not read (a claim about which one is meant would be a guess).
      out.unchecked.push(uncheckedEntry(canonicalPath, 'cfn-unreadable'));
      documents = [];
    }
  }
  if (parsed.issue !== undefined) {
    out.unchecked.push(
      uncheckedEntry(canonicalPath, issueCode(parsed.issue.reasonCode, real), parsed.issue.line),
    );
  }
  out.files.push({
    canonicalPath,
    class: cls,
    text: inputText(read.text),
    lineIndex,
    documents,
    ...(parsed.waiverComments.length === 0 ? {} : { waiverComments: parsed.waiverComments }),
  });
}

/** A syntax error in a `.json` file is worded as JSON's (the parser is YAML's, the file is not). */
function issueCode(code: UncheckedReason, fileName: string): UncheckedReason {
  return code === 'parse-error' && isJsonName(fileName) ? 'json-parse-error' : code;
}

function stray(text: string, path: InputText, out: Collected): void {
  for (const c of strayWaiverLines(text)) {
    out.strays.push({ path, line: c.line, text: inputText(c.text) });
  }
}

// An explicit configuration file. A file inside the root is shown by its path relative to the root. A file outside
// it is shown EXACTLY AS THE PERSON TYPED IT, never resolved (bolt B17): a resolved path would print the person's
// home directory and differ between machines, and the person named it themselves. `inside` tells the caller which.
function configJob(
  configPath: string,
  rootReal: string | undefined,
  out: Collected,
): { job: FileJob; shown: InputText; inside: boolean } | undefined {
  const shown = inputText(configPath);
  let real: string;
  try {
    real = realpathSync.native(configPath);
    if (!statSync(real).isFile()) throw new Error('not a file');
  } catch {
    out.unchecked.push(uncheckedEntry(shown, 'unreadable'));
    return undefined;
  }
  const inside = rootReal !== undefined && isInside(rootReal, real);
  const canonical = inside ? toPosix(relative(rootReal as string, real)) : configPath;
  return {
    job: { real, canonical, classHint: 'tripcurve-yaml' },
    shown: inputText(canonical),
    inside,
  };
}

/**
 * The name an outside --config file is shown by must not equal the name of a file read from the root: a typed
 * `tripcurve.yaml` in another folder would otherwise look like the root's own. A name a root file has gets `./`
 * in front (a name read from the root never starts with it), as often as it takes.
 */
function distinctFrom(typed: string, taken: ReadonlySet<string>): string {
  let name = typed;
  while (taken.has(name)) name = `./${name}`;
  return name;
}

function identityOf(path: string): string {
  try {
    const st = statSync(path, { bigint: true });
    return st.ino === 0n ? path : `${st.dev}:${st.ino}`;
  } catch {
    return path;
  }
}

/** Checks a root: walks it, reads what it recognises, and reports what it could not read. */
export function intake(options: IntakeOptions): IntakeResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const out: Collected = { files: [], unchecked: [], strays: [] };

  let rootReal: string;
  let rootIsFile = false;
  try {
    rootReal = realpathSync.native(options.root);
    rootIsFile = statSync(rootReal).isFile();
  } catch {
    const shown = inputText(options.root);
    const result: IntakeResult = {
      root: shown,
      files: [],
      unchecked: [uncheckedEntry(shown, 'unreadable')],
      filesRead: 0,
      noRecognisedFiles: false,
    };
    return Object.freeze(result);
  }
  const confinement = rootIsFile ? dirname(rootReal) : rootReal;

  const jobs: FileJob[] = [];
  const seen = new Set<string>();
  const explicitConfig = options.configPath !== undefined;
  let configCandidate: InputText | undefined;

  let outside: IntakeResult['outsideConfig'];
  const config =
    options.configPath === undefined ? undefined : configJob(options.configPath, confinement, out);
  if (options.configPath !== undefined) {
    configCandidate = config?.shown ?? inputText(options.configPath);
    if (config !== undefined) seen.add(identityOf(config.job.real));
  }

  const walked = rootIsFile
    ? { candidates: [{ real: rootReal, rel: basename(rootReal) }], unchecked: [] }
    : walkRoot(rootReal);
  for (const item of walked.unchecked) {
    out.unchecked.push(uncheckedEntry(inputText(item.rel), item.reasonCode));
  }
  if (config !== undefined) {
    // an outside file's shown name must not equal a name read from the root (see distinctFrom)
    const canonical = config.inside
      ? config.job.canonical
      : distinctFrom(
          config.job.canonical,
          new Set([...walked.candidates, ...walked.unchecked].map((c) => c.rel)),
        );
    jobs.push({ ...config.job, canonical });
    configCandidate = inputText(canonical);
    if (!config.inside) outside = { shown: inputText(canonical), real: inputText(config.job.real) };
  }
  const sorted = [...walked.candidates].sort((a, b) => compareBytes(a.rel, b.rel));
  for (const candidate of sorted) {
    const identity = identityOf(candidate.real);
    if (seen.has(identity)) continue; // two spellings of one file: read once
    seen.add(identity);
    const atRoot = !candidate.rel.includes('/');
    // With an explicit --config the root's own tripcurve.yaml is not a configuration file.
    const classHint = classifyByName(basename(candidate.rel), atRoot && !explicitConfig);
    jobs.push({
      real: candidate.real,
      canonical: candidate.rel,
      classHint,
      ...(rootIsFile ? { sniffJson: true } : {}),
    });
  }
  if (!explicitConfig) {
    const rootConfig = jobs.find((job) => job.classHint === 'tripcurve-yaml');
    if (rootConfig !== undefined) {
      configCandidate = inputText(rootConfig.canonical);
    } else if (walked.unchecked.some((item) => item.rel === 'tripcurve.yaml')) {
      // A tripcurve.yaml that was refused (a link out of the root, a loop): its
      // declarations must not vanish quietly, so the ConfigReader reports it.
      configCandidate = inputText('tripcurve.yaml');
    }
  }

  for (const job of jobs) readOne(job, limits, out);

  return finish(
    inputText(rootReal),
    out,
    undefined,
    configCandidate,
    confinement,
    rootIsFile,
    outside,
  );
}

function sortUnchecked(list: readonly UncheckedInput[]): UncheckedInput[] {
  return [...list].sort((a, b) => {
    const pa = a.path === STDIN ? STDIN : unwrapForIo(a.path);
    const pb = b.path === STDIN ? STDIN : unwrapForIo(b.path);
    const c = compareBytes(pa, pb);
    return c !== 0 ? c : compareBytes(a.reasonCode, b.reasonCode);
  });
}

/**
 * Adds records found after intake (a Kubernetes object that could not be
 * identified) to its list, keeping the rule of at most one entry per file or
 * stream: a file already not checked keeps its own reason. Same order as intake.
 */
export function mergeUnchecked(
  base: readonly UncheckedInput[],
  extra: readonly UncheckedInput[],
): UncheckedInput[] {
  if (extra.length === 0) return [...base];
  const same = (a: UncheckedInput['path'], b: UncheckedInput['path']): boolean =>
    a === STDIN || b === STDIN ? a === b : unwrapForIo(a) === unwrapForIo(b);
  const has = (p: UncheckedInput['path']): boolean => base.some((b) => same(p, b.path));
  return sortUnchecked([...base, ...extra.filter((e) => !has(e.path))]);
}

function finish(
  root: InputText | typeof STDIN,
  out: Collected,
  stream: IntakeResult['stream'],
  configCandidate: InputText | undefined,
  confinement: string | undefined,
  rootIsFile = false,
  outsideConfig?: IntakeResult['outsideConfig'],
): IntakeResult {
  const files = [...out.files].sort(byCanonical);
  const unchecked = sortUnchecked(out.unchecked);
  const nothingRecognised =
    files.every((f) => f.class === 'tripcurve-yaml') &&
    unchecked.length === 0 &&
    (stream === undefined || stream.documents.length === 0);
  const result: IntakeResult = {
    root,
    files,
    ...(stream === undefined ? {} : { stream }),
    unchecked,
    ...(out.strays.length === 0 ? {} : { strayWaiverComments: out.strays }),
    filesRead: files.length,
    noRecognisedFiles: nothingRecognised,
    ...(rootIsFile ? { rootIsFile } : {}),
    ...(outsideConfig === undefined ? {} : { outsideConfig }),
    ...(configCandidate === undefined ? {} : { configCandidate }),
  };
  const frozen = Object.freeze(result);
  if (confinement !== undefined) rootsOfResults.set(frozen, confinement);
  return frozen;
}

/**
 * Reads rendered YAML from standard input. The stream is read
 * under the same size limit; documents are numbered from 1 and a line is the
 * line in the whole stream. With `-` no tripcurve.yaml is looked up;
 * `configPath` reads the one file the person named.
 */
export function intakeStdin(options: StdinOptions = {}): IntakeResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const read = readStreamBounded(options.fd ?? 0, limits.maxFileBytes);
  return intakeStreamText(read, limits, options.configPath);
}

/** The same as `intakeStdin`, for text already read (tests, the library). */
export function intakeStreamBytes(
  bytes: Uint8Array,
  options: Omit<StdinOptions, 'fd'> = {},
): IntakeResult {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const outcome =
    bytes.length > limits.maxFileBytes
      ? ({ ok: false, reasonCode: 'over-size' } as const)
      : decodeUtf8(bytes);
  return intakeStreamText(outcome, limits, options.configPath);
}

function intakeStreamText(
  read: ReturnType<typeof decodeUtf8>,
  limits: IntakeLimits,
  configPath: string | undefined,
): IntakeResult {
  const out: Collected = { files: [], unchecked: [], strays: [] };
  let stream: IntakeResult['stream'];
  if (!read.ok) {
    out.unchecked.push(uncheckedEntry(STDIN, read.reasonCode));
  } else {
    const parsed = parseYamlDocuments(read.text, limits, (index, line) => stdinSource(index, line));
    stream = { documents: parsed.documents, bytes: read.bytes };
    if (parsed.issue !== undefined) {
      out.unchecked.push(uncheckedEntry(STDIN, parsed.issue.reasonCode, parsed.issue.line));
    }
  }
  let configCandidate: InputText | undefined;
  let outside: IntakeResult['outsideConfig'];
  if (configPath !== undefined) {
    const config = configJob(configPath, undefined, out);
    configCandidate = config?.shown ?? inputText(configPath);
    if (config !== undefined) {
      readOne(config.job, limits, out);
      outside = { shown: config.shown, real: inputText(config.job.real) };
    }
  }
  return finish(STDIN, out, stream, configCandidate, undefined, false, outside);
}

export type ConfineResult =
  | { readonly ok: true; readonly canonicalPath: InputText }
  | { readonly ok: false; readonly reasonCode: 'outside-root' | 'symlink-loop' | 'unreadable' };

/**
 * Confines a path found inside an input file (a `source:` link, a Dockerfile
 * link, a command's file) to the root of `result`. The path is
 * resolved with its symlinks; one that lands outside the root, loops, or cannot
 * be resolved is refused. The answer is the canonical path, so it can be
 * compared with `InputFile.canonicalPath`.
 */
export function confineToRoot(result: IntakeResult, candidate: InputText): ConfineResult {
  const root = rootsOfResults.get(result);
  if (root === undefined) return { ok: false, reasonCode: 'outside-root' };
  const raw = unwrapForIo(candidate);
  let real: string;
  try {
    real = realpathSync.native(isAbsolute(raw) ? raw : join(root, raw));
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    return { ok: false, reasonCode: code === 'ELOOP' ? 'symlink-loop' : 'unreadable' };
  }
  if (!isInside(root, real)) return { ok: false, reasonCode: 'outside-root' };
  return { ok: true, canonicalPath: inputText(toPosix(relative(root, real))) };
}

/**
 * The text of a file, as a string, for a parser (Dockerfile, package.json,
 * source). Parsers need a real string; this is the one door, and it is in the
 * intake folder so the scan test sees every use of the unwrap. A parser must
 * wrap anything it keeps from this text back into an InputText.
 */
export function rawTextForParser(file: InputFile): string {
  return unwrapForIo(file.text);
}

/**
 * The same door for a piece of text a parser holds as an InputText (a declared
 * version, an image reference, a canonical path it needs to resolve an import
 * against). The caller must compute a result that is not that text, or wrap
 * whatever it keeps back into an InputText; it never prints this string.
 */
export function rawInputTextForParser(text: InputText): string {
  return unwrapForIo(text);
}
