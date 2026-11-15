// The Node version evidence order: a declaration, then
// the official `node:` image tag of the container, then a linked Dockerfile, with
// `engines` only narrowing. The first source in that order that is evidence of a
// Node version decides; a source that is present but names no version makes the
// version unresolved (it does not hand over to a weaker source, which could
// disagree with it). An image that is not the official node image is not evidence
// of a Node version and is skipped. A version may be exact, partial (22.23, 22) or
// unknown (all versions): the result is an interval.

import {
  type ChainStep,
  type InputText,
  isInputText,
  makeSourcedValue,
  makeUnresolved,
} from '../core/index.js';
import { formatInterval, isEmpty, narrow, type VersionInterval } from '../kb/index.js';
import {
  type Declaration,
  hintFromDeclaration,
  hintFromDockerfile,
  hintFromImage,
  type InputFile,
  type K8sContainer,
  type Maybe,
  REASON_NOT_NODE_IMAGE,
  type RuntimeVersionHint,
  rawInputTextForParser,
  readPackageEngines,
} from '../parse/index.js';
import type { NodeVersionResolution, ResolveProblem } from './model.js';

export const DECLARE_NODE_VERSION =
  'pin the image to an exact Node version tag, or declare runtime.node for this workload in tripcurve.yaml';
export const REASON_ENGINES_EXCLUDES = 'package.json engines excludes the version the image names';

export interface NodeVersionInput {
  readonly declarations: readonly Declaration[];
  readonly container?: K8sContainer;
  readonly dockerfile?: InputFile;
  /** The package.json nearest the linked entry file, when source is linked. */
  readonly enginesFile?: InputFile;
}

export type NodeVersionOutcome =
  | {
      readonly state: 'known';
      readonly resolution: NodeVersionResolution;
    }
  | {
      readonly state: 'unknown';
      readonly problem: ResolveProblem;
      readonly declare: readonly string[];
    }
  | { readonly state: 'no-evidence' };

/** True for the interval of every version: nothing is known about the Node version. */
export function isUnknownInterval(interval: VersionInterval): boolean {
  const { lower, upper } = interval;
  return upper === null && lower.major === 0 && lower.minor === 0 && lower.patch === 0;
}

/** Digits and dots written from a parsed interval: `22.23.2`, `22.23`, `22`. */
export function describeInterval(interval: VersionInterval): string {
  const { lower, upper } = interval;
  if (upper !== null) {
    if (
      upper.major === lower.major &&
      upper.minor === lower.minor &&
      upper.patch === lower.patch + 1
    ) {
      return `${lower.major}.${lower.minor}.${lower.patch}`;
    }
    if (
      upper.major === lower.major &&
      upper.minor === lower.minor + 1 &&
      upper.patch === 0 &&
      lower.patch === 0
    ) {
      return `${lower.major}.${lower.minor}`;
    }
    if (
      upper.major === lower.major + 1 &&
      upper.minor === 0 &&
      upper.patch === 0 &&
      lower.minor === 0 &&
      lower.patch === 0
    ) {
      return `${lower.major}`;
    }
  }
  return formatInterval(interval);
}

/** `Node 22.23`, or `Node (any version)` when nothing is known: tripcurve text from the interval's numbers. */
function nodeLabel(interval: VersionInterval): string {
  return isUnknownInterval(interval) ? 'Node (any version)' : `Node ${describeInterval(interval)}`;
}

const DETAIL: Record<RuntimeVersionHint['sourceKind'], string> = {
  declaration: 'declared',
  'image-tag': 'image',
  'linked-dockerfile': 'Dockerfile FROM',
  engines: 'engines',
};

function stepFor(hint: RuntimeVersionHint, label: string): ChainStep {
  const text: InputText | undefined = hint.text;
  const value =
    text !== undefined && isInputText(text)
      ? makeSourcedValue({ value: text, unit: 'none', source: hint.sourceRef, basis: 'declared' })
      : makeUnresolved('the version evidence is not written as text');
  return { label, detail: DETAIL[hint.sourceKind], value };
}

function unknown(hint: RuntimeVersionHint): NodeVersionOutcome {
  const reason = hint.unknownReason ?? 'the version is not established';
  const label = 'Node version';
  return {
    state: 'unknown',
    problem: { label, value: makeUnresolved(reason, DECLARE_NODE_VERSION) },
    declare: [DECLARE_NODE_VERSION],
  };
}

/** The first hint, in the fixed order, that is evidence of a Node version. */
function chosenHint(input: NodeVersionInput): RuntimeVersionHint | undefined {
  const declared = input.declarations.find((d) => d.key === 'runtime.node');
  if (declared !== undefined) return hintFromDeclaration(declared);
  if (input.container !== undefined) {
    const image: Maybe | undefined = input.container.image;
    const hint = hintFromImage(image, input.container.source);
    if (hint.unknownReason !== REASON_NOT_NODE_IMAGE) return hint;
  }
  if (input.dockerfile !== undefined) {
    const hint = hintFromDockerfile(input.dockerfile);
    if (hint !== undefined && hint.unknownReason !== REASON_NOT_NODE_IMAGE) return hint;
  }
  return undefined;
}

export function resolveNodeVersion(input: NodeVersionInput): NodeVersionOutcome {
  const hint = chosenHint(input);
  if (hint === undefined) return { state: 'no-evidence' };
  if (hint.interval === undefined) return unknown(hint);
  let interval = hint.interval;
  if (input.enginesFile !== undefined) {
    const engines = readPackageEngines(input.enginesFile).hint;
    if (engines?.text !== undefined && engines.interval !== undefined) {
      // engines only narrows: it can remove versions, never choose one.
      interval = narrow(interval, rawInputTextForParser(engines.text));
      if (isEmpty(interval)) {
        return {
          state: 'unknown',
          problem: { label: 'Node version', value: makeUnresolved(REASON_ENGINES_EXCLUDES) },
          declare: [DECLARE_NODE_VERSION],
        };
      }
    }
  }
  return {
    state: 'known',
    resolution: {
      label: nodeLabel(interval),
      interval,
      step: stepFor(
        hint,
        isUnknownInterval(hint.interval) ? 'Node version' : nodeLabel(hint.interval),
      ),
    },
  };
}
