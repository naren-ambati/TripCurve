// The waiver goldens' inputs (bolt B6): a fixture directory, files added or replaced, and the injected UTC
// date. The expected output of each is the file under test/golden/, written from the design mockup
// and the interaction spec before the waiver code existed, and checked line by line against them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertAfter } from './fixture-tree.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const API = readFileSync(join(FIXTURES, 'python', 'api-admin', 'k8s', 'api.yaml'), 'utf8');
const ORDERS = readFileSync(join(FIXTURES, 'terraform', 'orders', 'infra', 'queue.tf'), 'utf8');

/** api.yaml with one line after `  namespace: shop` (so the line is 6, inside the Deployment's block). */
export function apiWith(line: string): string {
  return insertAfter(API, '  namespace: shop', line);
}

/** queue.tf with one line inside the event source mapping block (line 16, after its header on line 15). */
export function queueWith(line: string): string {
  return insertAfter(ORDERS, 'resource "aws_lambda_event_source_mapping" "orders" {', line);
}

export interface WaiverScenario {
  readonly name: string;
  readonly fixture: string;
  readonly overlay: Readonly<Record<string, string>>;
  readonly today: string;
  readonly golden: string;
  readonly exit: number;
}

const LONG_REASON = 'x'.repeat(201);
/** A 187-character reason: long enough that it cannot stay on the WAIVED line. */
export const FULL_REASON =
  'The sidecar drains connections before the pod stops; the platform team reviewed this on 2026-10-01 and accepted the gap until the mesh upgrade lands, tracked in the quarterly plan (ticket 4417).';

export const WAIVER_SCENARIOS: readonly WaiverScenario[] = [
  {
    // WAIVED lines, T1 on an NLB from tripcurve.yaml, T2 and T3 inline; the clean run with waivers.
    name: 'a run with valid waivers ends No failures and exits 0',
    fixture: 'waivers/valid',
    overlay: {},
    today: '2026-11-12',
    golden: 'waivers-valid.txt',
    exit: 0,
  },
  {
    // The form of the same closing line.
    name: 'the same run with a workload that has no load balancer',
    fixture: 'waivers/valid',
    overlay: {
      'k8s/worker.yaml':
        'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: worker\nspec:\n  template:\n    spec:\n      containers:\n        - name: app\n          image: example/worker:1\n',
    },
    today: '2026-11-12',
    golden: 'waivers-valid-not-checked.txt',
    exit: 0,
  },
  {
    // T4 on a Terraform mapping: the comment sits inside the block of the mapping resource.
    name: 'a T4 result waived by a comment inside its Terraform mapping block',
    fixture: 'terraform/orders',
    overlay: {
      'infra/queue.tf': queueWith(
        '  # tripcurve: ignore T4 reason="queue is resized next sprint" until=2027-01-31',
      ),
    },
    today: '2026-11-12',
    golden: 'waivers-t4-terraform.txt',
    exit: 0,
  },
  {
    // a reason is the control, so a long one is printed whole.
    name: 'a long reason is printed whole on the WAIVED line',
    fixture: 'python/api-admin',
    overlay: {
      'tripcurve.yaml': `version: 1\nwaive:\n  - rule: T2\n    workload: api\n    reason: "${FULL_REASON}"\n    until: 2027-01-31\n`,
    },
    today: '2026-11-12',
    golden: 'waivers-long-reason.txt',
    exit: 1,
  },
  {
    // the waiver ended on 2026-10-31; the finding is back with its own kind.
    name: 'an expired waiver does not apply and the report says so',
    fixture: 'python/api-admin',
    overlay: {
      'k8s/api.yaml': apiWith(
        '  # tripcurve: ignore T2 reason="drains in sidecar" until=2026-10-31',
      ),
    },
    today: '2026-11-12',
    golden: 'waivers-e5-expired.txt',
    exit: 1,
  },
  {
    // T2 of admin is a PASS, so the waiver names nothing it can cover.
    name: 'a waiver that matches no finding is listed and counted',
    fixture: 'python/api-admin',
    overlay: {
      'tripcurve.yaml':
        'version: 1\nwaive:\n  - rule: T2\n    workload: admin\n    reason: "fixed last week"\n    until: 2027-01-31\n',
    },
    today: '2026-11-12',
    golden: 'waivers-e6-unmatched.txt',
    exit: 1,
  },
  {
    // no reason, so nothing is suppressed and the finding shows its real result.
    name: 'an invalid waiver suppresses nothing and is listed with what is wrong',
    fixture: 'python/api-admin',
    overlay: { 'k8s/api.yaml': apiWith('  # tripcurve: ignore T2 until=2027-01-31') },
    today: '2026-11-12',
    golden: 'waivers-e9-invalid.txt',
    exit: 1,
  },
  {
    // Every other way a waiver is invalid, written in tripcurve.yaml; none stops the run.
    name: 'every kind of invalid waiver is listed, none stops the run',
    fixture: 'python/api-admin',
    overlay: {
      'k8s/api.yaml': apiWith('  # tripcurve: ignore T9 reason="x" until=2027-01-31'),
      'tripcurve.yaml': [
        'version: 1',
        'waive:',
        '  - rule: T1',
        '    workload: ghost',
        '    reason: "no such workload"',
        '    until: 2027-01-31',
        '  - rule: T1',
        '    workload: api',
        '    reason: "bad date"',
        '    until: 2027-02-30',
        '  - rule: T1',
        '    workload: api',
        `    reason: "${LONG_REASON}"`,
        '    until: 2027-01-31',
        '  - rule: T1',
        '    workload: api',
        '    reason: ""',
        '    until: 2027-01-31',
        '  - rule: T1',
        '    workload: api',
        '    until: 2027-01-31',
        '',
      ].join('\n'),
    },
    today: '2026-11-12',
    golden: 'waivers-invalid-kinds.txt',
    exit: 1,
  },
];
