// Ties a `gunicorn.conf.py` to a gunicorn workload by explicit evidence only, in this order:
//   1. a `gunicorn_config:` link in tripcurve.yaml (the user's statement of which file
//      gunicorn loads from the working directory);
//   2. the file `-c` / `--config` names in the container's command;
//   3. otherwise, when NO file is named but a `gunicorn.conf.py` exists in the checked
//      files, gunicorn may load it from the working directory, which the files do not
//      show: `may-be-loaded` (the settings it could change are UNRESOLVED);
//   4. otherwise `none`: no configuration file is involved.
// A relative `-c` path is relative to the container's working directory (the same rules as
// the Node command file): a container that sets `workingDir` cannot be
// mapped, otherwise the path is tried against every folder from the manifest's up to the
// root, one match is used and its folder is an assumption, several matches are unresolved.
// Only a file named exactly `gunicorn.conf.py` is read as a gunicorn configuration
// (intake's classification), so a file with another name is `not-a-config-file`.
// A link and a `-c` that name different files are in conflict and are not decided.
// Every path is confined to the root. Nothing is executed.

import { posix } from 'node:path';
import {
  declaredSource,
  type InputText,
  inputText,
  inputTextEquals,
  type SourceRef,
} from '../core/index.js';
import {
  type ConfigLink,
  confineToRoot,
  type GunicornConfigArg,
  type InputFile,
  type IntakeResult,
  rawInputTextForParser,
  STDIN,
  type UncheckedReason,
} from '../parse/index.js';
import { confineSource, foldersUp } from './source-link.js';

export const GUNICORN_CONFIG_UNLINKED_REASONS = [
  /** `-c python:module` or another form that is not a file path. */
  'not-a-path',
  /** `-c` is the last word. */
  'no-value',
  'absolute-path',
  'working-dir-not-mapped',
  'several-files-match',
  'outside-root',
  'symlink-loop',
  'unreadable',
  /** The path names a file, but not one that was read as a `gunicorn.conf.py`. */
  'not-a-config-file',
  /** The link in tripcurve.yaml and `-c` name different files. */
  'link-conflict',
  /** Intake skipped the file (over the size limit, unreadable, truncated): `skip` says why. */
  'skipped',
  /** No -c and no link, and a `gunicorn.conf.py` that gunicorn would load from the working directory was skipped. */
  'default-skipped',
] as const;
export type GunicornConfigUnlinkedReason = (typeof GUNICORN_CONFIG_UNLINKED_REASONS)[number];

export type GunicornConfigLink =
  | { readonly state: 'none' }
  /** No `-c` and no link, but a `gunicorn.conf.py` is in the checked files. */
  | { readonly state: 'may-be-loaded' }
  | {
      readonly state: 'linked';
      readonly by: 'declared' | 'command';
      readonly file: InputFile;
      readonly evidence: SourceRef;
      /** The folder taken to be the container's working directory, for a relative `-c` (an assumption). */
      readonly assumedWorkingDir?: InputText;
    }
  | {
      readonly state: 'unlinked';
      readonly reasonCode: GunicornConfigUnlinkedReason;
      readonly evidence?: SourceRef;
      /** For `skipped`: intake's reason for not reading the file. */
      readonly skip?: UncheckedReason;
    };

export interface GunicornConfigLinkInput {
  readonly intake: IntakeResult;
  readonly configLinks: readonly ConfigLink[];
  readonly configFile?: InputText;
  readonly arg?: GunicornConfigArg;
  readonly workingDirSet: boolean;
  /** The folder of the manifest, root-relative (`''` is the root). */
  readonly manifestDir: string;
}

const CONFIG_NAME = 'gunicorn.conf.py';

function unlinked(
  reasonCode: GunicornConfigUnlinkedReason,
  evidence?: SourceRef,
  skip?: UncheckedReason,
): GunicornConfigLink {
  return {
    state: 'unlinked',
    reasonCode,
    ...(evidence === undefined ? {} : { evidence }),
    ...(skip === undefined ? {} : { skip }),
  };
}

/** Why intake skipped the file at this root-relative path, when it did (size, unreadable, truncated...). */
function skipReasonOf(intake: IntakeResult, path: string): UncheckedReason | undefined {
  let confined: ReturnType<typeof confineToRoot>;
  try {
    confined = confineToRoot(intake, inputText(path));
  } catch {
    return undefined;
  }
  if (!confined.ok) return undefined;
  for (const u of intake.unchecked) {
    if (u.path !== STDIN && inputTextEquals(u.path, confined.canonicalPath)) return u.reasonCode;
  }
  return undefined;
}

/** A gunicorn.conf.py skipped by intake anywhere in the checked files, with its reason. */
function skippedDefaultConfig(intake: IntakeResult): UncheckedReason | undefined {
  for (const u of intake.unchecked) {
    if (u.path === STDIN) continue;
    if (rawInputTextForParser(u.path).split('/').pop() === CONFIG_NAME) return u.reasonCode;
  }
  return undefined;
}

function mapReason(code: string): GunicornConfigUnlinkedReason {
  switch (code) {
    case 'outside-root':
    case 'symlink-loop':
    case 'unreadable':
      return code;
    default:
      return 'not-a-config-file';
  }
}

type Resolved =
  | { readonly state: 'file'; readonly file: InputFile; readonly dir?: string }
  | { readonly state: 'failed'; readonly link: GunicornConfigLink };

function resolveDeclared(input: GunicornConfigLinkInput, link: ConfigLink): Resolved {
  const evidence = declaredSource(input.configFile ?? inputText('tripcurve.yaml'), link.line);
  const target = rawInputTextForParser(link.target);
  const hit = confineSource(input.intake, target, 'gunicorn-conf');
  if (hit.state === 'file') return { state: 'file', file: hit.entry };
  const skip = skipReasonOf(input.intake, target);
  return {
    state: 'failed',
    link:
      skip === undefined
        ? unlinked(mapReason(hit.reasonCode), evidence)
        : unlinked('skipped', evidence, skip),
  };
}

function resolveCommandPath(input: GunicornConfigLinkInput, arg: GunicornConfigArg): Resolved {
  if (arg.kind === 'not-a-path')
    return { state: 'failed', link: unlinked('not-a-path', arg.source) };
  if (arg.kind === 'no-value') return { state: 'failed', link: unlinked('no-value', arg.source) };
  const path = arg.path;
  if (path.startsWith('/')) return { state: 'failed', link: unlinked('absolute-path', arg.source) };
  if (input.workingDirSet) {
    return { state: 'failed', link: unlinked('working-dir-not-mapped', arg.source) };
  }
  const found: { dir: string; file: InputFile }[] = [];
  let failure: GunicornConfigUnlinkedReason = 'unreadable';
  let skipped: UncheckedReason | undefined;
  for (const dir of foldersUp(input.manifestDir)) {
    const joined = posix.join(dir, path);
    if (joined === '..' || joined.startsWith('../')) {
      failure = 'outside-root';
      continue;
    }
    const hit = confineSource(input.intake, joined, 'gunicorn-conf');
    if (hit.state === 'file') {
      if (!found.some((f) => f.file === hit.entry)) found.push({ dir, file: hit.entry });
    } else {
      skipped ??= skipReasonOf(input.intake, joined);
      if (hit.reasonCode !== 'unreadable' && failure === 'unreadable') {
        failure = mapReason(hit.reasonCode);
      }
    }
  }
  const [only, ...more] = found;
  if (only === undefined) {
    return {
      state: 'failed',
      link:
        skipped === undefined
          ? unlinked(failure, arg.source)
          : unlinked('skipped', arg.source, skipped),
    };
  }
  if (more.length > 0)
    return { state: 'failed', link: unlinked('several-files-match', arg.source) };
  return { state: 'file', file: only.file, dir: only.dir };
}

export function linkGunicornConfig(input: GunicornConfigLinkInput): GunicornConfigLink {
  const declared = input.configLinks.find((l) => l.kind === 'gunicorn_config');
  const arg = input.arg;
  if (declared !== undefined) {
    const viaLink = resolveDeclared(input, declared);
    if (viaLink.state === 'failed') return viaLink.link;
    const evidence = declaredSource(input.configFile ?? inputText('tripcurve.yaml'), declared.line);
    if (arg !== undefined) {
      const viaCommand = resolveCommandPath(input, arg);
      // A `-c` that is not a path, or that names another repository file, disagrees with the link.
      // One that cannot be located (a path inside the container) leaves the user's link standing.
      const disagrees =
        viaCommand.state === 'file'
          ? !inputTextEquals(viaCommand.file.canonicalPath, viaLink.file.canonicalPath)
          : arg.kind === 'not-a-path';
      if (disagrees) return unlinked('link-conflict', evidence);
    }
    return { state: 'linked', by: 'declared', file: viaLink.file, evidence };
  }
  if (arg !== undefined) {
    const found = resolveCommandPath(input, arg);
    if (found.state === 'failed') return found.link;
    return {
      state: 'linked',
      by: 'command',
      file: found.file,
      evidence: arg.source,
      assumedWorkingDir: inputText(found.dir === undefined || found.dir === '' ? '.' : found.dir),
    };
  }
  const anywhere = input.intake.files.some(
    (f) =>
      f.class === 'gunicorn-conf' &&
      rawInputTextForParser(f.canonicalPath).split('/').pop() === CONFIG_NAME,
  );
  if (anywhere) return { state: 'may-be-loaded' };
  const skipped = skippedDefaultConfig(input.intake);
  return skipped === undefined
    ? { state: 'none' }
    : unlinked('default-skipped', undefined, skipped);
}
