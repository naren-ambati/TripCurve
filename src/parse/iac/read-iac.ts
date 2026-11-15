// IacReader: the Terraform files of an intake result, read for four resource types (bolt B5).
// Pure over the intake result; it opens no file and runs nothing. A file it cannot read is reported as
// not checked and contributes no resource, and `incomplete` says some Terraform input was not read, so
// no claim of absence ("exactly one load balancer has this name") may rest on what was read.

import type { InputText, SourceRef } from '../../core/index.js';
import {
  type InputFile,
  type IntakeDocument,
  type IntakeResult,
  isCfnTemplateValue,
  rawInputTextForParser,
  rawTextForParser,
  STDIN,
  type UncheckedInput,
} from '../intake/index.js';
import { problemOf, TF_PROBLEMS, type TfResource } from './model.js';
import { readCfn } from './read-cfn.js';
import { fileOrigin, hclWaiverComments, readHcl } from './read-hcl.js';
import { isShowJson, readShowJson, readTfJsonSyntax } from './read-terraform-json.js';

export interface IacReadResult {
  readonly resources: readonly TfResource[];
  /** Terraform files that could not be read; the report lists them. */
  readonly unchecked: readonly UncheckedInput[];
  /** True when any Terraform input was not read (unreadable, over size, a syntax this reader does not take). */
  readonly incomplete: boolean;
  /**
   * True when a CloudFormation or SAM template was not read in full. Separate from `incomplete`: no Terraform claim
   * rests on it. NOTE: it has no consumer yet. Any future link from a CloudFormation load balancer to an Ingress
   * must be wired to it, or a claim of absence over templates would ignore a template that was not read.
   */
  readonly incompleteTemplates: boolean;
  /**
   * The folders (root-relative, `''` for the root) that have a Terraform file which was not read (unreadable, over the
   * size limit, or not a syntax this reader takes). A reference whose target is not found in such a folder cannot be
   * called "not there": the unread file may declare it (bolt B17).
   */
  readonly unreadFolders: ReadonlySet<string>;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** `override.tf`, `override.tf.json`, `*_override.tf` and `*_override.tf.json` merge into resources of their folder. */
export function isOverrideName(name: string): boolean {
  return /^(?:.*_)?override\.tf(?:\.json)?$/.test(name);
}

function isTerraformName(path: string): boolean {
  return path.endsWith('.tf') || path.endsWith('.tf.json');
}

const cache = new WeakMap<IntakeResult, IacReadResult>();

function jsonDocuments(
  documents: readonly IntakeDocument[],
  file: InputFile | undefined,
  out: TfResource[],
  rawPath: string,
  streamBase: boolean,
): void {
  documents.forEach((document, index) => {
    const origin = {
      document,
      file: file?.canonicalPath,
      streamIndex: streamBase ? document.index : undefined,
      scope: streamBase ? `<stdin>#${document.index}` : `${rawPath}#${index}`,
      dir: streamBase ? '' : dirOf(rawPath),
    };
    if (isShowJson(document.value)) out.push(...readShowJson(origin));
    else if (!streamBase) out.push(...readTfJsonSyntax(origin));
  });
}

export function readIac(intake: IntakeResult): IacReadResult {
  const cached = cache.get(intake);
  if (cached !== undefined) return cached;
  const resources: TfResource[] = [];
  const unchecked: UncheckedInput[] = [];
  const overrides = new Set<string>();
  // A folder whose override file could not be read: which resources it changes is unknown, so none is trusted.
  const unreadOverrideDirs = new Set<string>();

  for (const file of intake.files) {
    const rawPath = rawInputTextForParser(file.canonicalPath);
    const name = rawPath.slice(rawPath.lastIndexOf('/') + 1);
    const before = resources.length;
    if (file.class === 'terraform') {
      const parsed = readHcl(
        rawTextForParser(file),
        fileOrigin(file.canonicalPath, rawPath, dirOf(rawPath)),
      );
      if (!parsed.ok) {
        unchecked.push({ path: file.canonicalPath, reasonCode: 'terraform-unreadable' });
        if (isOverrideName(name)) unreadOverrideDirs.add(dirOf(rawPath));
        continue;
      }
      resources.push(...parsed.resources);
    } else if (file.class === 'terraform-json') {
      jsonDocuments(file.documents ?? [], file, resources, rawPath, false);
    } else if (file.class === 'cfn-template') {
      (file.documents ?? []).forEach((document, index) => {
        if (!isCfnTemplateValue(document.value)) return;
        const read = readCfn({
          document,
          file: file.canonicalPath,
          streamIndex: undefined,
          scope: `${rawPath}#${index}`,
          dir: dirOf(rawPath),
        });
        resources.push(...read.resources);
        if (read.unread !== undefined) {
          unchecked.push({ path: file.canonicalPath, reasonCode: read.unread });
        }
      });
      continue;
    } else continue;
    if (isOverrideName(name)) {
      for (const r of resources.slice(before)) {
        overrides.add(`${r.dir}\u0000${r.type}\u0000${rawInputTextForParser(r.name)}`);
      }
    }
  }
  if (intake.stream !== undefined) {
    jsonDocuments(intake.stream.documents, undefined, resources, STDIN, true);
  }

  // The same address twice in one folder (two files, or `.tf` and `.tf.json`): Terraform rejects it, so
  // neither is trusted. An address an override file names is already unresolved below.
  const seen = new Map<string, number>();
  const keyOf = (r: TfResource): string =>
    `${r.form === 'plan' ? r.scope : r.dir}\u0000${r.type}\u0000${rawInputTextForParser(r.name)}`;
  for (const r of resources) seen.set(keyOf(r), (seen.get(keyOf(r)) ?? 0) + 1);

  // A resource an override file also names is changed by it: nothing written for it is its value.
  for (const u of intake.unchecked) {
    if (u.path === STDIN) continue;
    const raw = rawInputTextForParser(u.path);
    if (isTerraformName(raw) && isOverrideName(raw.slice(raw.lastIndexOf('/') + 1))) {
      unreadOverrideDirs.add(dirOf(raw));
    }
  }
  const final = resources.map((r) =>
    r.form === 'cfn'
      ? r
      : overrides.has(`${r.dir}\u0000${r.type}\u0000${rawInputTextForParser(r.name)}`) ||
          unreadOverrideDirs.has(r.dir)
        ? { ...r, problem: problemOf(TF_PROBLEMS.override) }
        : (seen.get(keyOf(r)) ?? 0) > 1
          ? { ...r, problem: problemOf(TF_PROBLEMS.declaredTwice) }
          : // The root is one file: the rest of its module (override files, other declarations) was not read, so no
            // value of it is trusted, for PASS or FAIL alike (a sibling could change it either way).
            intake.rootIsFile === true && (r.form === 'hcl' || r.form === 'json')
            ? { ...r, problem: problemOf(TF_PROBLEMS.partialModule) }
            : r,
  );

  const cfnFiles = new Set(
    intake.files
      .filter((f) => f.class === 'cfn-template')
      .map((f) => rawInputTextForParser(f.canonicalPath)),
  );
  const skipped = intake.unchecked.some(
    (u) => u.path !== STDIN && isTerraformName(rawInputTextForParser(u.path)),
  );
  const templatesSkipped = intake.unchecked.some(
    (u) => u.path !== STDIN && cfnFiles.has(rawInputTextForParser(u.path)),
  );
  const unreadFolders = new Set<string>();
  for (const u of unchecked) {
    if (u.reasonCode === 'terraform-unreadable' && u.path !== STDIN) {
      unreadFolders.add(dirOf(rawInputTextForParser(u.path)));
    }
  }
  for (const u of intake.unchecked) {
    if (u.path === STDIN) continue;
    const raw = rawInputTextForParser(u.path);
    if (isTerraformName(raw)) unreadFolders.add(dirOf(raw));
  }
  const result: IacReadResult = Object.freeze({
    resources: Object.freeze(final),
    unchecked: Object.freeze(unchecked),
    // Terraform inputs only: the claims it backs (a load balancer of a name, an address) are about Terraform.
    incomplete: skipped || unchecked.some((u) => u.reasonCode === 'terraform-unreadable'),
    incompleteTemplates:
      templatesSkipped ||
      unchecked.some((u) => u.reasonCode === 'cfn-transform' || u.reasonCode === 'cfn-unreadable'),
    unreadFolders,
  });
  cache.set(intake, result);
  return result;
}

/** The inline waiver comments of the Terraform files (`# tripcurve: ...`, `// tripcurve: ...`), raw, with their lines. */
export function terraformWaiverComments(
  intake: IntakeResult,
): { file: InputText; line: number; text: string }[] {
  const out: { file: InputText; line: number; text: string }[] = [];
  for (const file of intake.files) {
    if (file.class !== 'terraform') continue;
    for (const c of hclWaiverComments(rawTextForParser(file))) {
      out.push({ file: file.canonicalPath, line: c.line, text: c.text });
    }
  }
  return out;
}

export type { SourceRef };
