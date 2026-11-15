// The gunicorn or uvicorn VERSION a workload runs (maintainer decision 2026-11-11), in this order:
//   1. a `runtime.gunicorn` or `runtime.uvicorn` declaration in tripcurve.yaml for the workload, a
//      string with the same shape and rules as `runtime.node` (the declaration wins, even over
//      pins that disagree with it);
//   2. else an EXACT pin in the repository: `requirements*.txt`, `pyproject.toml` (PEP 621 or
//      Poetry), `poetry.lock` or `uv.lock` (the readers are in parse/python/read-pins.ts). The pin
//      files used are the ones in the nearest folder, from the manifest's folder up to the root
//      (the same search as the B1 working directory), that pin the package at all. One version
//      among them is used and an Assumption names the file; different versions, or a pin in a
//      form that is not read, are UNRESOLVED;
//   3. else no evidence: UNRESOLVED, with what to declare.
// A knowledge-base default is matched to this release: a release no entry covers is UNRESOLVED,
// never the nearest.

import {
  type Assumption,
  type ChainStep,
  type InputText,
  inputTextEquals,
  isInputText,
  SafeText,
} from '../core/index.js';
import { exactInterval, parseVersion, type VersionInterval } from '../kb/index.js';
import type { WorkloadChain } from '../link/index.js';
import { foldersUp } from '../link/source-link.js';
import {
  type InputFile,
  type IntakeResult,
  isPinFileName,
  type PinReading,
  rawInputTextForParser,
  readPythonPins,
  STDIN,
  type UncheckedReason,
  uncheckedReasonWords,
} from '../parse/index.js';
import { describeInterval } from './node-version.js';

type Program = 'gunicorn' | 'uvicorn';

export const REASON_NO_GUNICORN_VERSION = 'no gunicorn version in the files';
export const REASON_NO_UVICORN_VERSION = 'no uvicorn version in the files';
export const DECLARE_NO_GUNICORN_VERSION =
  'declare runtime.gunicorn for this workload in tripcurve.yaml';
export const DECLARE_NO_UVICORN_VERSION =
  'declare runtime.uvicorn for this workload in tripcurve.yaml';

const NO_VERSION: Record<Program, { reason: string; declare: string }> = {
  gunicorn: { reason: REASON_NO_GUNICORN_VERSION, declare: DECLARE_NO_GUNICORN_VERSION },
  uvicorn: { reason: REASON_NO_UVICORN_VERSION, declare: DECLARE_NO_UVICORN_VERSION },
};

export type PythonVersionOutcome =
  | {
      readonly state: 'known';
      readonly interval: VersionInterval;
      /** A declaration is shown in the chain; a pin from the repository is an Assumption instead. */
      readonly step?: ChainStep;
      readonly assumption?: Assumption;
      /** The pin file the version was taken from (when it came from a pin, not a declaration). */
      readonly file?: InputText;
    }
  | { readonly state: 'unresolved'; readonly reason: string; readonly declare: string };

function unresolved(program: Program, reason: string): PythonVersionOutcome {
  return { state: 'unresolved', reason, declare: NO_VERSION[program].declare };
}

/** The folder of a root-relative path (`''` for the root). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function fromDeclaration(program: Program, chain: WorkloadChain): PythonVersionOutcome | undefined {
  const declared = chain.declarations.find((d) => d.key === `runtime.${program}`);
  if (declared === undefined) return undefined;
  const text = isInputText(declared.value.value) ? rawInputTextForParser(declared.value.value) : '';
  const parsed = parseVersion(text);
  // parseVersion answers "all versions" for text that is not a version: that names none.
  const isVersion = !(
    parsed.upper === null &&
    parsed.lower.major === 0 &&
    parsed.lower.minor === 0 &&
    parsed.lower.patch === 0
  );
  if (!isVersion) return unresolved(program, `the declared ${program} version is not a version`);
  return {
    state: 'known',
    interval: parsed,
    step: {
      label: `${program} ${describeInterval(parsed)}`,
      detail: 'declared',
      value: declared.value,
    },
  };
}

/** A pin file that intake skipped (too large, unreadable...), by folder: it is a file that may pin the package. */
function skippedPinFiles(intake: IntakeResult): Map<string, UncheckedReason> {
  const skipped = new Map<string, UncheckedReason>();
  for (const u of intake.unchecked) {
    if (u.path === STDIN) continue;
    const path = rawInputTextForParser(u.path);
    if (!isPinFileName(path.slice(path.lastIndexOf('/') + 1))) continue;
    const dir = dirOf(path);
    if (!skipped.has(dir)) skipped.set(dir, u.reasonCode);
  }
  return skipped;
}

function fromPins(
  program: Program,
  chain: WorkloadChain,
  intake: IntakeResult,
): PythonVersionOutcome | undefined {
  const pinFiles = new Map<string, InputFile[]>();
  for (const f of intake.files) {
    if (f.class !== 'python-pin') continue;
    const dir = dirOf(rawInputTextForParser(f.canonicalPath));
    const list = pinFiles.get(dir);
    if (list === undefined) pinFiles.set(dir, [f]);
    else list.push(f);
  }
  const skipped = skippedPinFiles(intake);
  if (pinFiles.size === 0 && skipped.size === 0) return undefined;
  const source = chain.workload.source;
  const start = source.type === 'file' ? dirOf(rawInputTextForParser(source.file)) : '';
  for (const dir of foldersUp(start)) {
    const files = (pinFiles.get(dir) ?? []).sort((a, b) =>
      rawInputTextForParser(a.canonicalPath) < rawInputTextForParser(b.canonicalPath) ? -1 : 1,
    );
    const readings: Array<{ file: InputFile; reading: PinReading }> = files.map((file) => ({
      file,
      reading: readPythonPins(file, program),
    }));
    // The nearest folder with a file that speaks for the package at all is the answer: a file
    // that names it in any form, cannot be read, or was skipped never lets the search go on up.
    const skippedHere = skipped.get(dir);
    if (skippedHere !== undefined) {
      return unresolved(
        program,
        `a ${program} pin file was skipped: ${uncheckedReasonWords(skippedHere)}`,
      );
    }
    if (readings.every((r) => r.reading.state === 'none')) continue;
    const unreadable = readings.flatMap((r) =>
      r.reading.state === 'unreadable' ? [r.reading.reason] : [],
    );
    if (unreadable.length > 0) {
      return unresolved(
        program,
        unreadable.includes('form')
          ? `a ${program} pin in the repository is not in a form tripcurve reads`
          : `the ${program} pin applies only under an environment marker`,
      );
    }
    const versions = new Set<string>();
    let first: InputFile | undefined;
    for (const r of readings) {
      if (r.reading.state === 'conflict') {
        return unresolved(program, `the repository pins different ${program} versions`);
      }
      if (r.reading.state === 'pin') {
        versions.add(r.reading.version);
        first ??= r.file;
      }
    }
    if (versions.size === 0) {
      return unresolved(program, `${program} is not pinned to an exact version in the files`);
    }
    const [only] = versions;
    if (versions.size !== 1 || only === undefined || first === undefined) {
      return unresolved(program, `the repository pins different ${program} versions`);
    }
    const [major, minor, patch] = only.split('.').map(Number) as [number, number, number];
    return {
      state: 'known',
      interval: exactInterval(major, minor, patch),
      file: first.canonicalPath,
      assumption: {
        text: `The ${program} version is taken from ${SafeText.render(first.canonicalPath, 'terminal')}.`,
        reason: `${program} is pinned there, and no runtime.${program} declaration was given`,
      },
    };
  }
  return undefined;
}

export function resolvePythonServerVersion(
  program: Program,
  chain: WorkloadChain,
  intake: IntakeResult,
): PythonVersionOutcome {
  return (
    fromDeclaration(program, chain) ??
    fromPins(program, chain, intake) ??
    unresolved(program, NO_VERSION[program].reason)
  );
}

export type Known = Extract<PythonVersionOutcome, { state: 'known' }>;

/**
 * The assumptions for the versions a result used: the gunicorn version and, for the uvicorn
 * worker, the uvicorn version. When both come from the same pin file there is ONE line; from
 * different files one each (gunicorn first). A declaration is a chain line, never an assumption.
 */
export function versionAssumptions(
  gunicorn: Known | undefined,
  uvicorn: Known | undefined,
): Assumption[] {
  const g = gunicorn?.assumption === undefined ? undefined : gunicorn;
  const u = uvicorn?.assumption === undefined ? undefined : uvicorn;
  if (g?.file !== undefined && u?.file !== undefined && inputTextEquals(g.file, u.file)) {
    return [
      {
        text: `The gunicorn and uvicorn versions are taken from ${SafeText.render(g.file, 'terminal')}.`,
        reason: 'both are pinned there, and no runtime declaration was given',
      },
    ];
  }
  return [g?.assumption, u?.assumption].flatMap((a) => (a === undefined ? [] : [a]));
}
