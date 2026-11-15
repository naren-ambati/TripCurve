// The intake output. Intake is the file boundary: everything
// below it receives bounded, already-parsed data and never opens a path.

import {
  type InputText,
  MAX_FILE_BYTES,
  REASON_TOO_DEEPLY_NESTED,
  type SourceRef,
  YAML_MAX_ALIAS_COUNT,
} from '../../core/index.js';

/** The place-holder for the standard-input stream: tripcurve's word, never quoted. */
export const STDIN = '<stdin>' as const;
export type StdinPath = typeof STDIN;

export const INPUT_CLASSES = [
  'k8s-yaml',
  'dockerfile',
  'package-json',
  /** `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`: read only for the exact version of lightship. */
  'node-lock',
  'gunicorn-conf',
  /** `requirements*.txt`, `pyproject.toml`, `poetry.lock`, `uv.lock`: read only for exact gunicorn or uvicorn pins. */
  'python-pin',
  'node-source',
  'terraform',
  'terraform-json',
  'cfn-template',
  'tripcurve-yaml',
] as const;
export type InputClass = (typeof INPUT_CLASSES)[number];

/** Classes whose text is parsed as YAML into documents at the boundary. */
export const YAML_CLASSES: readonly InputClass[] = [
  'k8s-yaml',
  'cfn-template',
  'tripcurve-yaml',
  // JSON is read as YAML so every value keeps its line (bolt B5).
  'terraform-json',
];

/**
 * The closed list of reasons a file or stream is not checked. `over-count`
 * is in the contract but intake never produces it: no count limit exists
 * (docs/limits.md: there is no basis for a number).
 */
export const UNCHECKED_REASONS = [
  'over-size',
  'over-count',
  'over-depth',
  'alias-limit',
  'unreadable',
  'truncated',
  'parse-error',
  'outside-root',
  'symlink-loop',
  // Not produced by intake itself: added by `analyse` for a Kubernetes object whose
  // name or namespace could not be read, so that the object is never dropped
  // without trace.
  'object-not-identified',
  // Not produced by intake itself: added by the Terraform reader for a `*.tf` file whose
  // syntax it does not read (bolt B5), so its values are unresolved and the run is not clean.
  'terraform-unreadable',
  // Not produced by intake's file reader: a CloudFormation or SAM template whose syntax tripcurve does not read
  // (an alias, a merge key, a key with a tag, several documents), so its values are unresolved (bolt B12).
  'cfn-unreadable',
  // A template with a transform or macro other than AWS::Serverless-2016-10-31 (or Fn::Transform): it can rewrite
  // any resource, so the whole template is not trusted (bolt B12).
  'cfn-transform',
  // A `.json` file with a syntax error or a key written twice (bolt B12 review).
  'json-parse-error',
  // A file that could be a Kubernetes manifest and a CloudFormation or SAM template (or a Terraform plan and a
  // template) at once: it is read as neither (bolt B12).
  'template-ambiguous',
  // A Node source file that does not parse: worded for source, not YAML.
  'source-parse-error',
  // A Node source file with more syntax nodes than tripcurve reads safely (`MAX_SOURCE_NODES`).
  'source-too-large',
] as const;
export type UncheckedReason = (typeof UNCHECKED_REASONS)[number];

/** `line` is set only for a parse error. No field holds a parser message. */
export interface UncheckedInput {
  readonly path: InputText | StdinPath;
  readonly reasonCode: UncheckedReason;
  readonly line?: number;
}

/**
 * One parsed YAML document. `value` is plain data with Secret `data` and
 * `stringData` removed. Nothing here holds a parser object.
 */
export interface IntakeDocument {
  /** 1-based position in the file or stream. */
  readonly index: number;
  /** Line (1-based, in the whole file or stream) where the document starts. */
  readonly startLine: number;
  /**
   * The first and last line this document owns, comments before and after its content included:
   * from the end of the previous document (the file start for the first) to the line before the
   * next `---` (the last line for the last). Inline waivers attach to the object whose lines
   * contain them.
   */
  readonly blockFirstLine: number;
  readonly blockLastLine: number;
  readonly value: unknown;
  /**
   * The text of a Helm `# Source: <path>` comment before the document's first content, when
   * there is one. Quoted input after a fixed label, never a source.
   */
  readonly helmSource?: InputText;
  /**
   * The source of the node at `path` (keys and list positions). When the node
   * cannot be found by path (it came in through an alias or a merge key) this
   * is the nearest enclosing node that can; the line is never invented.
   */
  sourceAt(path: readonly (string | number)[]): SourceRef;
  /**
   * The source of the KEY at `path` (the last element names the key). For an
   * unknown key this is where the key is written, which can be a line above its value.
   */
  keySourceAt(path: readonly (string | number)[]): SourceRef;
  /** The source text of the node at `path`, as written (a raw slice), or undefined. */
  sourceTextAt(path: readonly (string | number)[]): InputText | undefined;
}

export interface InputFile {
  /** Relative to the root, normalised, '/' separators; absolute for an explicit --config outside the root. */
  readonly canonicalPath: InputText;
  readonly class: InputClass;
  /** The text, bounded by the per-file limit. Parsers get the raw string through `rawTextForParser`. */
  readonly text: InputText;
  /** Offsets of the first character of each line, in UTF-16 units of the decoded text. */
  readonly lineIndex: readonly number[];
  /** For YAML classes: the bounded documents that parsed. Absent for other classes. */
  readonly documents?: readonly IntakeDocument[];
  /** For YAML classes: the comments that open an inline waiver (`# tripcurve: ...`), raw, with their lines. */
  readonly waiverComments?: readonly { readonly line: number; readonly text: InputText }[];
}

export interface InputStream {
  readonly documents: readonly IntakeDocument[];
  /** Bytes read. */
  readonly bytes: number;
}

export interface IntakeResult {
  /** The real path of the checked root, or `<stdin>`. */
  readonly root: InputText | StdinPath;
  /** In byte order of canonical paths. */
  readonly files: readonly InputFile[];
  readonly stream?: InputStream;
  /** In byte order of path, then reason; at most one entry per file or stream. */
  readonly unchecked: readonly UncheckedInput[];
  readonly filesRead: number;
  /**
   * Waiver comments in `.yaml` and `.yml` files that tripcurve does not otherwise read (a values file, a
   * non-Kubernetes file, a comment-only file), raw, with their lines. They are listed as waivers that name
   * no workload; none is ever dropped.
   */
  readonly strayWaiverComments?: readonly {
    readonly path: InputText;
    readonly line: number;
    readonly text: InputText;
  }[];
  /** nothing recognised, nothing unchecked, nothing to say but "found no files". */
  readonly noRecognisedFiles: boolean;
  /** The checked root is one file, not a folder: the rest of that file's folder was not read (bolt B17 review). */
  readonly rootIsFile?: boolean;
  /**
   * An explicit `--config` file outside the root: the name it is shown by (as typed) and its resolved path. The
   * resolved path is for the SARIF location only, which needs a URI that is right wherever the command ran; it is
   * never printed in the human report or JSON (bolt B17 review).
   */
  readonly outsideConfig?: { readonly shown: InputText; readonly real: InputText };
  /** The configuration file that was looked up (explicit or at the root), when one exists. */
  readonly configCandidate?: InputText;
}

/** Tests pass small values; production uses DEFAULT_LIMITS (core/limits.ts). */
export interface IntakeLimits {
  readonly maxFileBytes: number;
  readonly maxAliasCount: number;
}

export const DEFAULT_LIMITS: IntakeLimits = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  maxAliasCount: YAML_MAX_ALIAS_COUNT,
});

/**
 * Suggested fixed wording per reason code (tripcurve's words, never a parser
 * message). Limit values come from the shipped constants, never from input.
 * owns the final report wording and may adopt or replace these.
 */
export function uncheckedReasonWords(
  code: UncheckedReason,
  limits: IntakeLimits = DEFAULT_LIMITS,
): string {
  switch (code) {
    case 'over-size':
      return `larger than the ${limits.maxFileBytes / 1_000_000} MB limit`;
    case 'over-count':
      return 'over the count limit';
    case 'over-depth':
      return REASON_TOO_DEEPLY_NESTED;
    case 'alias-limit':
      return `YAML aliases expand beyond the limit of ${limits.maxAliasCount}`;
    case 'unreadable':
      return 'could not be read';
    case 'truncated':
      return 'ends in the middle of a character, so it may be cut short';
    case 'parse-error':
      return 'YAML syntax error';
    case 'outside-root':
      return 'lies outside the checked root';
    case 'symlink-loop':
      return 'symlink loop';
    case 'object-not-identified':
      return 'a Kubernetes object could not be identified';
    case 'terraform-unreadable':
      return 'Terraform syntax that tripcurve does not read';
    case 'cfn-unreadable':
      return 'CloudFormation or SAM syntax that tripcurve does not read';
    case 'json-parse-error':
      return 'JSON syntax error (or a key written twice)';
    case 'cfn-transform':
      return 'uses a CloudFormation transform or macro that can rewrite the template';
    case 'source-parse-error':
      return 'syntax error in a source file';
    case 'source-too-large':
      return 'source too large to read safely';
    case 'template-ambiguous':
      return 'could be a Kubernetes manifest, a Terraform plan or a CloudFormation template, so it is read as none';
  }
}
