// The JSON and SARIF goldens' inputs (bolt B7): a fixture directory, files added or replaced, and the
// injected UTC date. The expected documents are the files `test/golden/report-<name>.json.txt` and
// `report-<name>.sarif.txt`, written by hand and the design mockup before the
// renderers existed; test/golden/README.md lists the readings.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiWith } from './waiver-scenarios.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const read = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8');

export interface ReportScenario {
  readonly name: string;
  readonly fixture: string;
  readonly overlay: Readonly<Record<string, string>>;
  readonly today: string;
  /** The golden name: `report-<golden>.json.txt` and `report-<golden>.sarif.txt`. */
  readonly golden: string;
  readonly exit: number;
}

/**
 * A name that is hostile on purpose, written as the YAML double-quoted scalar a manifest would hold: a quote, a
 * backslash, a right-to-left override, a lone surrogate, an astral character and a terminal escape sequence.
 */
export const HOSTILE_NAME = String.raw`"w\"b\\‮\ud800\U0001F600\e[2J"`;
const HOSTILE_REASON = String.raw`"r\"q\"\n‮\U0001F600"`;
/** A file name with a quote and a right-to-left override in it (valid on macOS and Linux). */
export const HOSTILE_FILE = 'k8s/bad"‮.yaml';

function hostileOverlay(): Record<string, string> {
  const renamed = (path: string, line: string): string =>
    read(path).replace(line, line.replace('web', HOSTILE_NAME));
  return {
    'k8s/web.yaml': renamed('link/web-demo/k8s/web.yaml', '  name: web'),
    'k8s/service.yaml': renamed('link/web-demo/k8s/service.yaml', '  name: web'),
    'k8s/ingress.yaml': renamed('link/web-demo/k8s/ingress.yaml', '                name: web'),
    'tripcurve.yaml': `version: 1\nwaive:\n  - rule: T3\n    workload: ${HOSTILE_NAME}\n    reason: ${HOSTILE_REASON}\n    until: 2027-01-31\n`,
    [HOSTILE_FILE]: read('hostile/bad-yaml/broken.yaml'),
  };
}

export const REPORT_SCENARIOS: readonly ReportScenario[] = [
  {
    // as far as the fixtures go: api T1 and T2 FAIL, web T1 FAIL, orders T4 FAIL (four errors in SARIF).
    name: 'the demo run: four failures',
    fixture: 'report/demo',
    overlay: {},
    today: '2026-11-12',
    golden: 'demo',
    exit: 1,
  },
  {
    // Applied waivers: external (tripcurve.yaml) and inSource (inline comments); the run ends No failures.
    name: 'applied waivers carry suppressions',
    fixture: 'waivers/valid',
    overlay: {},
    today: '2026-11-12',
    golden: 'waived',
    exit: 0,
  },
  {
    name: 'an expired waiver carries no suppression',
    fixture: 'python/api-admin',
    overlay: {
      'k8s/api.yaml': apiWith(
        '  # tripcurve: ignore T2 reason="drains in sidecar" until=2026-10-31',
      ),
    },
    today: '2026-11-12',
    golden: 'expired',
    exit: 1,
  },
  {
    name: 'no recognised files',
    fixture: 'hostile/no-files',
    overlay: {},
    today: '2026-11-12',
    golden: 'e1',
    exit: 2,
  },
  {
    name: 'a configuration error stops the run',
    fixture: 'config/e4-golden',
    overlay: {},
    today: '2026-11-12',
    golden: 'e4',
    exit: 2,
  },
  {
    name: 'files read, no check evaluated',
    fixture: 'report/e10',
    overlay: {},
    today: '2026-11-12',
    golden: 'e10',
    exit: 2,
  },
  {
    name: 'an unchecked file',
    fixture: 'hostile/bad-yaml',
    overlay: {},
    today: '2026-11-12',
    golden: 'unchecked',
    exit: 2,
  },
  {
    name: 'the stream NLB case: unresolved, never pass',
    fixture: 'report/stream',
    overlay: {},
    today: '2026-11-12',
    golden: 'stream',
    exit: 1,
  },
  {
    name: 'hostile names, a hostile reason and a hostile file name, escaped',
    fixture: 'link/web-demo',
    overlay: hostileOverlay(),
    today: '2026-11-12',
    golden: 'hostile',
    exit: 1,
  },
  {
    // Review M1: the only unsuppressed result is a note, yet the run is not clean.
    name: 'a not-clean run whose only unsuppressed result is a note',
    fixture: 'python/api-admin',
    overlay: {
      'tripcurve.yaml':
        'version: 1\nwaive:\n  - rule: T1\n    workload: api\n    reason: "known and tracked"\n    until: 2027-01-31\n  - rule: T2\n    workload: api\n    reason: "sidecar drains"\n    until: 2027-01-31\n',
    },
    today: '2026-11-12',
    golden: 'runlevel',
    exit: 1,
  },
  {
    // Review m5: the Clean outcome (the demo after the fix).
    name: 'a clean run has no result and says so in the properties',
    fixture: 'link/web-demo-fixed',
    overlay: {},
    today: '2026-11-12',
    golden: 'clean',
    exit: 0,
  },
];
