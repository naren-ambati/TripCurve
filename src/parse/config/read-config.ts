// ConfigReader. Reads tripcurve.yaml from the intake
// result. B1 scope: the strict schema (so a valid file is never rejected and a
// typo always is), the declarations and links, and the waive entries as raw
// records. Whether a declaration names zero or two workloads is decided by the
// linker, which knows the workloads; applying waivers is (B6).
//
// Every problem is a ConfigError in the result; nothing throws and nothing
// stops here (PipelineRunner stops on a non-empty list).

import {
  declaredSource,
  fileSource,
  type InputText,
  inputText,
  inputTextEquals,
  makeSourcedValue,
  type SourcedValue,
  type WorkloadName,
} from '../../core/index.js';
import { type K8sWorkloadKind, k8sWorkloadKindFromInput } from '../../core/vocab.js';
import { terraformWaiverComments } from '../iac/read-iac.js';
import {
  type InputFile,
  type IntakeDocument,
  type IntakeResult,
  rawTextForParser,
} from '../intake/index.js';
import type {
  ConfigError,
  ConfigErrorCode,
  ConfigLink,
  ConfigResult,
  Declaration,
  RawField,
  RawFieldValue,
  RawWaiverRecord,
  WholeFileProblem,
  WorkloadSelector,
} from './types.js';

type PathKey = string | number;

const ROOT_KEYS = ['version', 'workloads', 'waive'] as const;
const WORKLOAD_KEYS = [
  'name',
  'namespace',
  'kind',
  'longest_request_s',
  'drain',
  'runtime',
  'source',
  'dockerfile',
  'gunicorn_config',
  'load_balancer',
] as const;
const LB_KEYS = ['terraform', 'ingress', 'service', 'idle_timeout_s'] as const;
const TERRAFORM_LB = /^aws_lb\.[A-Za-z_][A-Za-z0-9_-]*$/;

/** Used for a failure of the file as a whole (cannot be read, not a mapping, several documents). */
const WHOLE_FILE_KEY = '(file)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function pathText(path: readonly PathKey[]): string {
  let out = '';
  for (const part of path) {
    out += typeof part === 'number' ? `[${part}]` : out === '' ? part : `.${part}`;
  }
  return out;
}

class Reader {
  readonly errors: ConfigError[] = [];
  readonly declarations: Declaration[] = [];
  readonly links: ConfigLink[] = [];
  readonly waivers: RawWaiverRecord[] = [];
  /** The selector of every entry read so far, to find two entries that name one workload. */
  private readonly seen: WorkloadSelector[] = [];

  constructor(
    private readonly file: InputText,
    private readonly doc: IntakeDocument,
  ) {}

  private lineOf(path: readonly PathKey[]): number {
    return lineOfSource(this.doc.sourceAt(path));
  }

  private keyLineOf(path: readonly PathKey[]): number {
    return lineOfSource(this.doc.keySourceAt(path));
  }

  /** An error at the value at `path` (or, for an unknown key, at the key). */
  fail(
    code: ConfigErrorCode,
    path: readonly PathKey[],
    keyAsWritten?: string,
    expected?: string,
  ): void {
    const line = code === 'unknown-key' ? this.keyLineOf(path) : this.lineOf(path);
    this.errors.push({
      file: this.file,
      line,
      key: inputText(keyAsWritten ?? pathText(path)),
      reasonCode: code,
      ...(expected === undefined ? {} : { expected }),
    });
  }

  private checkKeys(
    record: Record<string, unknown>,
    allowed: readonly string[],
    path: readonly PathKey[],
  ): void {
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) this.fail('unknown-key', [...path, key], key);
    }
  }

  private text(value: unknown, path: readonly PathKey[]): string | undefined {
    if (typeof value === 'string' && value.length > 0) return value;
    this.fail('bad-value', path);
    return undefined;
  }

  private seconds(value: unknown, path: readonly PathKey[], example: string): number | undefined {
    // numbers of seconds, finite and not negative. There is no documented
    // maximum in the approved documents, so none is applied (see the area 2 report).
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    this.fail('bad-value', path, undefined, `a number of seconds, for example ${example}`);
    return undefined;
  }

  private declared(
    value: number | string | InputText,
    unit: 's' | 'none',
    path: readonly PathKey[],
  ): SourcedValue {
    return makeSourcedValue({
      value,
      unit,
      source: declaredSource(this.file, this.lineOf(path)),
      basis: 'declared',
    });
  }

  run(root: unknown): void {
    if (!isRecord(root)) {
      this.errors.push({
        file: this.file,
        line: this.doc.startLine,
        key: inputText(WHOLE_FILE_KEY),
        reasonCode: 'invalid-schema',
        wholeFile: 'not-a-mapping',
      });
      return;
    }
    this.checkKeys(root, ROOT_KEYS, []);
    if (!Object.hasOwn(root, 'version')) {
      this.errors.push({
        file: this.file,
        line: this.doc.startLine,
        key: inputText('version'),
        reasonCode: 'invalid-schema',
      });
    } else if (root.version !== 1) {
      this.fail('bad-value', ['version']);
    }
    const workloads = own(root, 'workloads');
    if (Object.hasOwn(root, 'workloads')) {
      if (!Array.isArray(workloads)) this.fail('invalid-schema', ['workloads']);
      else for (let i = 0; i < workloads.length; i += 1) this.workload(workloads[i], i);
    }
    const waive = own(root, 'waive');
    if (Object.hasOwn(root, 'waive')) {
      if (!Array.isArray(waive)) {
        // Not a list (a scalar, a mapping, or nothing): one raw record, judged invalid by the waiver
        // reader; it never stops the run.
        this.waivers.push({
          rawFields: [],
          rawText: this.doc.sourceTextAt(['waive']) ?? inputText(''),
          source: declaredSource(this.file, this.keyLineOf(['waive'])),
          mechanism: 'config',
          notAList: true,
        });
      } else for (let i = 0; i < waive.length; i += 1) this.waiver(waive[i], i);
    }
  }

  private workload(entry: unknown, i: number): void {
    const base: PathKey[] = ['workloads', i];
    if (!isRecord(entry)) {
      this.fail('invalid-schema', base);
      return;
    }
    this.checkKeys(entry, WORKLOAD_KEYS, base);

    const name = Object.hasOwn(entry, 'name')
      ? this.text(entry.name, [...base, 'name'])
      : undefined;
    if (!Object.hasOwn(entry, 'name')) this.fail('invalid-schema', [...base, 'name']);
    const namespaceRaw = own(entry, 'namespace');
    const namespace =
      namespaceRaw === undefined ? undefined : this.text(namespaceRaw, [...base, 'namespace']);
    let kind: K8sWorkloadKind | undefined;
    const kindRaw = own(entry, 'kind');
    if (kindRaw !== undefined) {
      kind = typeof kindRaw === 'string' ? k8sWorkloadKindFromInput(kindRaw) : undefined;
      if (kind === undefined) this.fail('bad-value', [...base, 'kind']);
    }
    // Without a usable name nothing below can be attached to a workload, but
    // every other field is still checked so one run reports every mistake.
    let selector: WorkloadSelector | undefined;
    if (name !== undefined) {
      const workload: WorkloadName =
        namespace === undefined
          ? { name: inputText(name) }
          : { name: inputText(name), namespace: inputText(namespace) };
      selector = kind === undefined ? { workload } : { workload, workloadKind: kind };
    }

    if (selector !== undefined) {
      if (this.seen.some((other) => overlaps(other, selector))) {
        this.errors.push({
          file: this.file,
          line: this.lineOf([...base, 'name']),
          key: inputText(pathText(base)),
          reasonCode: 'duplicate-workload-entry',
          workload: selector.workload.name,
        });
      }
      this.seen.push(selector);
    }

    const longest = own(entry, 'longest_request_s');
    if (longest !== undefined) {
      const path = [...base, 'longest_request_s'];
      const n = this.seconds(longest, path, 'longest_request_s: 5');
      if (n !== undefined && selector !== undefined) {
        this.declarations.push({
          ...selector,
          key: 'longest_request_s',
          value: this.declared(n, 's', path),
          line: this.lineOf(path),
        });
      }
    }

    const drain = own(entry, 'drain');
    if (drain !== undefined) {
      const path = [...base, 'drain'];
      if (!isRecord(drain)) this.fail('invalid-schema', path);
      else {
        this.checkKeys(drain, ['in_process_s'], path);
        if (!Object.hasOwn(drain, 'in_process_s')) this.fail('invalid-schema', path);
        else {
          const inner = [...path, 'in_process_s'];
          const n = this.seconds(drain.in_process_s, inner, 'in_process_s: 5');
          if (n !== undefined && selector !== undefined) {
            this.declarations.push({
              ...selector,
              key: 'drain.in_process_s',
              value: this.declared(n, 's', inner),
              line: this.lineOf(inner),
            });
          }
        }
      }
    }

    const runtime = own(entry, 'runtime');
    if (runtime !== undefined) {
      const path = [...base, 'runtime'];
      if (!isRecord(runtime)) this.fail('invalid-schema', path);
      else {
        const runtimeKeys = ['node', 'gunicorn', 'uvicorn'] as const;
        this.checkKeys(runtime, runtimeKeys, path);
        if (!runtimeKeys.some((k) => Object.hasOwn(runtime, k))) this.fail('invalid-schema', path);
        for (const k of runtimeKeys) {
          if (!Object.hasOwn(runtime, k)) continue;
          const inner = [...path, k];
          // A version is text: `node: 22.10` would be the number 22.1, so a bare number is refused.
          const v = this.text(runtime[k], inner);
          if (v !== undefined && selector !== undefined) {
            this.declarations.push({
              ...selector,
              key: `runtime.${k}`,
              value: this.declared(inputText(v), 'none', inner),
              line: this.lineOf(inner),
            });
          }
        }
      }
    }

    for (const kindKey of ['source', 'dockerfile', 'gunicorn_config'] as const) {
      const raw = own(entry, kindKey);
      if (raw === undefined) continue;
      const path = [...base, kindKey];
      const target = this.text(raw, path);
      if (target !== undefined && selector !== undefined) {
        this.links.push({
          ...selector,
          kind: kindKey,
          target: inputText(target),
          line: this.lineOf(path),
        });
      }
    }

    const lb = own(entry, 'load_balancer');
    if (lb !== undefined) this.loadBalancer(lb, [...base, 'load_balancer'], selector);
  }

  private loadBalancer(
    lb: unknown,
    path: readonly PathKey[],
    selector: WorkloadSelector | undefined,
  ): void {
    if (!isRecord(lb)) {
      this.fail('invalid-schema', path);
      return;
    }
    this.checkKeys(lb, LB_KEYS, path);
    const forms = (['terraform', 'ingress', 'service'] as const).filter((f) =>
      Object.hasOwn(lb, f),
    );
    if (forms.length !== 1) {
      this.fail('invalid-schema', path);
      return;
    }
    const form = forms[0] as 'terraform' | 'ingress' | 'service';
    const targetPath = [...path, form];
    const targetRaw = this.text(lb[form], targetPath);
    if (form === 'terraform') {
      if (Object.hasOwn(lb, 'idle_timeout_s')) this.fail('invalid-schema', path);
      else if (targetRaw !== undefined && !TERRAFORM_LB.test(targetRaw)) {
        this.fail('bad-value', targetPath);
      } else if (targetRaw !== undefined && selector !== undefined) {
        this.links.push({
          ...selector,
          kind: 'load_balancer',
          target: inputText(targetRaw),
          line: this.lineOf(targetPath),
          loadBalancer: { form },
        });
      }
      return;
    }
    if (!Object.hasOwn(lb, 'idle_timeout_s')) {
      this.fail('invalid-schema', path);
      return;
    }
    const idlePath = [...path, 'idle_timeout_s'];
    const idle = this.seconds(lb.idle_timeout_s, idlePath, 'idle_timeout_s: 60');
    if (targetRaw !== undefined && idle !== undefined && selector !== undefined) {
      this.links.push({
        ...selector,
        kind: 'load_balancer',
        target: inputText(targetRaw),
        line: this.lineOf(targetPath),
        loadBalancer: { form, idleTimeoutS: this.declared(idle, 's', idlePath) },
      });
    }
  }

  private waiver(entry: unknown, i: number): void {
    const path: PathKey[] = ['waive', i];
    const fields: RawField[] = [];
    if (isRecord(entry)) {
      for (const key of Object.keys(entry)) {
        fields.push({ key: inputText(key), value: rawValue(entry[key]) });
      }
    }
    this.waivers.push({
      rawFields: fields,
      rawText: this.doc.sourceTextAt(path) ?? inputText(''),
      source: declaredSource(this.file, this.lineOf(path)),
      mechanism: 'config',
    });
  }
}

/** Two entries could name one workload: the same name, and namespaces and kinds that do not exclude each other. */
function overlaps(a: WorkloadSelector, b: WorkloadSelector): boolean {
  if (!inputTextEquals(a.workload.name, b.workload.name)) return false;
  const na = a.workload.namespace;
  const nb = b.workload.namespace;
  if (na !== undefined && nb !== undefined && !inputTextEquals(na, nb)) return false;
  return (
    a.workloadKind === undefined ||
    b.workloadKind === undefined ||
    a.workloadKind === b.workloadKind
  );
}

function rawValue(value: unknown): RawFieldValue {
  if (typeof value === 'string') return inputText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  return { nested: true };
}

function lineOfSource(source: ReturnType<IntakeDocument['sourceAt']>): number {
  return source.type === 'file' || source.type === 'declared' || source.type === 'stdin'
    ? source.line
    : 1;
}

function emptyResult(extra: Partial<ConfigResult> = {}): ConfigResult {
  return Object.freeze({
    declarations: [],
    links: [],
    waiverRecords: [],
    configErrors: [],
    ...extra,
  });
}

function wholeFileError(
  file: InputText,
  line: number,
  problem: WholeFileProblem,
  key = WHOLE_FILE_KEY,
  lineKnown = true,
): ConfigError {
  // An error that names a real key (a repeated key) keeps naming it; only the placeholder is replaced by words.
  return {
    file,
    line,
    key: inputText(key),
    reasonCode: 'invalid-schema',
    ...(key === WHOLE_FILE_KEY ? { wholeFile: problem } : {}),
    ...(lineKnown ? {} : { lineUnknown: true as const }),
  };
}

/**
 * The mapping key written on a line of the file (`rule` for `    rule: T1`, also after `- `), or the
 * whole-file placeholder when the line is not a plain `key:` line. A file that is not valid YAML is
 * reported at the line of its first error; when that is a repeated key, the error names the key.
 */
function keyOnLine(file: InputFile, line: number): string {
  const text = rawTextForParser(file);
  const from = file.lineIndex[line - 1];
  if (from === undefined) return WHOLE_FILE_KEY;
  const to = file.lineIndex[line] ?? text.length;
  const m = /^[ \t]*(?:-[ \t]+)?([A-Za-z0-9_.-]{1,64})[ \t]*:/.exec(text.slice(from, to));
  return m?.[1] ?? WHOLE_FILE_KEY;
}

/**
 * Reads the configuration file of an intake result. No configuration file is a
 * valid, empty result. A configuration file that intake could not read or parse
 * is a configuration error, not a quietly ignored file: a declaration must
 * never be dropped without a word.
 */
function readConfigFile(intake: IntakeResult): ConfigResult {
  const candidate = intake.configCandidate;
  if (candidate === undefined) return emptyResult();
  const file: InputFile | undefined = intake.files.find(
    (f) => f.class === 'tripcurve-yaml' && inputTextEquals(f.canonicalPath, candidate),
  );
  if (file === undefined) {
    const unchecked = intake.unchecked.find(
      (u) => u.path !== '<stdin>' && inputTextEquals(u.path, candidate),
    );
    return emptyResult({
      configFile: candidate,
      configErrors: [
        wholeFileError(
          candidate,
          unchecked?.line ?? 1,
          'unreadable',
          WHOLE_FILE_KEY,
          unchecked?.line !== undefined,
        ),
      ],
    });
  }
  const failed = intake.unchecked.find(
    (u) => u.path !== '<stdin>' && inputTextEquals(u.path, file.canonicalPath),
  );
  const documents = file.documents ?? [];
  if (failed !== undefined || documents.length === 0) {
    return emptyResult({
      configFile: file.canonicalPath,
      configErrors: [
        wholeFileError(
          file.canonicalPath,
          failed?.line ?? 1,
          failed === undefined ? 'not-a-mapping' : 'unreadable',
          failed?.line === undefined ? WHOLE_FILE_KEY : keyOnLine(file, failed.line),
          failed === undefined || failed.line !== undefined,
        ),
      ],
    });
  }
  const [first, second] = documents as [IntakeDocument, IntakeDocument?];
  const reader = new Reader(file.canonicalPath, first);
  reader.run(first.value);
  if (second !== undefined) {
    reader.errors.push(wholeFileError(file.canonicalPath, second.startLine, 'several-documents'));
  }
  const errors = [...reader.errors].sort((a, b) => a.line - b.line);
  return Object.freeze({
    declarations: Object.freeze(reader.declarations),
    links: Object.freeze(reader.links),
    waiverRecords: Object.freeze(reader.waivers),
    configErrors: Object.freeze(errors),
    configFile: file.canonicalPath,
  });
}

/**
 * The inline waiver comments of every YAML file read: `# tripcurve: ignore <RULE> ...`, raw,
 * each with its file and line. Nothing is validated here, so a malformed one is still a record: the
 * waiver reader judges it and lists it by its line. The `#` and `//` comments of
 * Terraform files are read the same way (bolt B5), raw, from the Terraform lexer; comments in standard
 * input are not read.
 */
function inlineWaiverRecords(intake: IntakeResult): RawWaiverRecord[] {
  const out: RawWaiverRecord[] = [];
  for (const file of intake.files) {
    for (const comment of file.waiverComments ?? []) {
      out.push({
        rawFields: [],
        rawText: comment.text,
        source: fileSource(file.canonicalPath, comment.line),
        mechanism: 'inline',
      });
    }
  }
  for (const stray of intake.strayWaiverComments ?? []) {
    out.push({
      rawFields: [],
      rawText: stray.text,
      source: fileSource(stray.path, stray.line),
      mechanism: 'inline',
    });
  }
  for (const comment of terraformWaiverComments(intake)) {
    out.push({
      rawFields: [],
      rawText: inputText(comment.text),
      source: fileSource(comment.file, comment.line),
      mechanism: 'inline',
    });
  }
  return out;
}

/** The configuration file's declarations, links and `waive:` entries, then the inline waiver comments (all raw). */
export function readConfig(intake: IntakeResult): ConfigResult {
  const result = readConfigFile(intake);
  const inline = inlineWaiverRecords(intake);
  if (inline.length === 0) return result;
  return Object.freeze({
    ...result,
    waiverRecords: Object.freeze([...result.waiverRecords, ...inline]),
  });
}
