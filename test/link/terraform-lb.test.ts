// The Terraform load balancer links seen through rule T1 on the demo
// `web` workload (Node 22.23 default idle close: 6 s).
//   - a DECLARED link is established: the aws_lb's idle_timeout (or the provider's documented default) may
//     give PASS or FAIL;
//   - a link BY NAME (the Ingress `load-balancer-name` equals the literal name of exactly one aws_lb) is an
//     ASSUMPTION: the value is shown and what it would mean, but T1 is never PASS and never FAIL, and the
//     assumption is listed.
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyseFiles,
  cleanupTrees,
  DEMO_FILES,
  lineOf,
  renderChain,
  t1Of,
  withEnv,
} from '../support/analyse.js';

afterEach(cleanupTrees);

const INGRESS = DEMO_FILES['k8s/ingress.yaml'] as string;
const IDLE_LINE =
  '    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=60\n';

/** The demo Ingress with no idle timeout annotation, and optionally a load-balancer-name. */
function ingress(options: { name?: string; idle?: string } = {}): string {
  let text = withEnv(INGRESS, IDLE_LINE, '');
  if (options.idle !== undefined) {
    text = withEnv(
      text,
      '    alb.ingress.kubernetes.io/target-type: ip\n',
      `    alb.ingress.kubernetes.io/target-type: ip\n    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=${options.idle}\n`,
    );
  }
  if (options.name !== undefined) {
    text = withEnv(
      text,
      '    alb.ingress.kubernetes.io/target-type: ip\n',
      `    alb.ingress.kubernetes.io/target-type: ip\n    alb.ingress.kubernetes.io/load-balancer-name: ${options.name}\n`,
    );
  }
  return text;
}

const lb = (body: string, name = 'main') => `resource "aws_lb" "${name}" {\n${body}}\n`;
const declare = (target: string) =>
  `version: 1\nworkloads:\n  - name: web\n    namespace: shop\n    load_balancer:\n      terraform: ${target}\n`;

function run(files: Record<string, string>) {
  const { result } = analyseFiles(files);
  return { result, t1: t1Of(result) };
}

describe('a declared Terraform link is established', () => {
  const files = (tf: string, target = 'aws_lb.main', ing = ingress()) => ({
    'k8s/ingress.yaml': ing,
    'infra/lb.tf': tf,
    'tripcurve.yaml': declare(target),
  });

  it('FAIL on a literal idle_timeout: the value, its file and its line', () => {
    const { t1 } = run(files(lb('  idle_timeout = 120\n')));
    expect(lineOf(t1)).toBe('FAIL idle close 6 s is not longer than LB idle 120 s');
    expect(renderChain(t1).slice(-2)).toEqual([
      'LB link: "aws_lb.main" @ "tripcurve.yaml":6',
      'LB idle: 120 s @ "infra/lb.tf":2',
    ]);
  });

  it('PASS when the idle close is longer', () => {
    const { t1 } = run(files(lb('  idle_timeout = 3\n')));
    expect(t1.kind).toBe('PASS');
    expect(t1.headline).toBe('idle close 6 s is longer than LB idle 3 s');
  });

  it('equal is FAIL (T1 is strict)', () => {
    expect(run(files(lb('  idle_timeout = 6\n'))).t1.kind).toBe('FAIL');
  });

  it('an absent idle_timeout is the documented provider default 60 s, which may FAIL (not assumed)', () => {
    const { t1, result } = run(files(lb('  name = "main-alb"\n')));
    expect(lineOf(t1)).toBe('FAIL idle close 6 s is not longer than LB idle 60 s');
    expect(renderChain(t1).join('\n')).toContain(
      'LB idle: 60 s @ default: Terraform aws_lb idle_timeout (Terraform AWS provider docs; documented)',
    );
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toMatch(
      /assumed to be the documented default/,
    );
  });

  it.each([
    ['a variable', '  idle_timeout = var.idle\n', /idle_timeout is not a whole number/],
    ['a block with count', '  idle_timeout = 3\n  count = 2\n', /count or for_each/],
    [
      'a network load balancer',
      '  load_balancer_type = "network"\n  idle_timeout = 3\n',
      /not an application load balancer/,
    ],
    [
      'an unreadable type',
      '  load_balancer_type = var.t\n',
      /load_balancer_type is not a plain string/,
    ],
    ['a value out of range', '  idle_timeout = 4001\n', /outside the documented range 1 to 4000/],
  ])('%s: UNRESOLVED with the reason', (_n, body, reason) => {
    const { t1 } = run(files(lb(body)));
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toMatch(reason);
  });

  it('an explicit application type is understood', () => {
    expect(
      run(files(lb('  load_balancer_type = "application"\n  idle_timeout = 3\n'))).t1.kind,
    ).toBe('PASS');
  });

  it('a declared name that matches no aws_lb is UNRESOLVED, never a guess from another one', () => {
    const { t1 } = run(files(lb('  idle_timeout = 3\n', 'other'), 'aws_lb.main'));
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('no aws_lb of the declared name was found');
  });

  it('two aws_lb of one name in two folders: UNRESOLVED', () => {
    const { t1 } = run({
      ...files(lb('  idle_timeout = 3\n')),
      'other/lb.tf': lb('  idle_timeout = 3\n'),
    });
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('more than one aws_lb');
  });

  it('a Terraform file that cannot be read makes a missing declared name UNRESOLVED for that reason', () => {
    const { t1 } = run({
      ...files(lb('  idle_timeout = 3\n', 'other')),
      'infra/bad.tf': 'resource "aws_lb" "main" {\n  x = "abc\n}\n',
    });
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('a Terraform file could not be read');
  });

  it('the annotation and the Terraform value agree: established; they differ: UNRESOLVED with both', () => {
    const agree = run(files(lb('  idle_timeout = 60\n'), 'aws_lb.main', ingress({ idle: '60' })));
    expect(agree.t1.kind).toBe('FAIL');
    const differ = run(files(lb('  idle_timeout = 3\n'), 'aws_lb.main', ingress({ idle: '60' })));
    expect(differ.t1.kind).toBe('UNRESOLVED');
    expect(differ.t1.headline).toContain(
      'the annotation and the declaration give different idle timeouts',
    );
    expect(renderChain(differ.t1).join('\n')).toContain('LB idle annotation: 60 s');
  });

  it('a declared link outranks a by-name link', () => {
    const { t1, result } = run({
      ...files(
        lb('  idle_timeout = 3\n  name = "main-alb"\n'),
        'aws_lb.main',
        ingress({ name: 'main-alb' }),
      ),
    });
    expect(t1.kind).toBe('PASS');
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toContain('linked by name');
  });
});

describe('a link by name is an assumption and never decides', () => {
  const files = (tf: string, name = 'main-alb', ing = ingress({ name })) => ({
    'k8s/ingress.yaml': ing,
    'infra/lb.tf': tf,
  });

  it('a short idle value that would PASS is UNRESOLVED, with what it would mean and the assumption listed', () => {
    const { t1, result } = run(files(lb('  name = "main-alb"\n  idle_timeout = 3\n')));
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toBe(
      'LB idle 3 s is linked to a Terraform load balancer by name only (assumed), so idle close 6 s is longer (T1 would pass)',
    );
    expect(renderChain(t1).slice(-2)).toEqual([
      'LB idle: 3 s @ "infra/lb.tf":3',
      'LB link: by name @ Terraform load balancer linked by name (assumed)',
    ]);
    expect(result.assumptions.map((a) => a.text)).toContain(
      'Terraform load balancer linked by name: the load-balancer-name annotation value "main-alb" at "k8s/ingress.yaml":9 equals the name of aws_lb "main" at "infra/lb.tf":2. The controller applies the name only when it creates a load balancer, and a Terraform-owned one is normally joined by TargetGroupBinding, which tripcurve does not read, so the link is assumed.',
    );
  });

  it('a long idle value that would FAIL is UNRESOLVED, not FAIL', () => {
    const { t1 } = run(files(lb('  name = "main-alb"\n  idle_timeout = 120\n')));
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('(T1 would FAIL)');
  });

  it('an absent idle_timeout reached by name is the documented default, still only assumed', () => {
    const { t1 } = run(files(lb('  name = "main-alb"\n')));
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain(
      'LB idle 60 s is linked to a Terraform load balancer by name only (assumed)',
    );
  });

  it.each([
    [
      'a name that matches no aws_lb',
      lb('  name = "other"\n  idle_timeout = 3\n'),
      /LB idle is not set in the files; assumed 60 s/,
    ],
    [
      'two aws_lb of that name',
      lb('  name = "main-alb"\n') + lb('  name = "main-alb"\n', 'second'),
      /more than one aws_lb/,
    ],
    [
      'an aws_lb with a name that is not a literal',
      lb('  name = "main-alb"\n') + lb('  name = var.n\n', 'second'),
      /name that is not a literal/,
    ],
    [
      'an aws_lb with no name',
      lb('  name = "main-alb"\n') + lb('', 'second'),
      /name that is not a literal/,
    ],
    ['a name with a count', lb('  name = "main-alb"\n  count = 2\n'), /name that is not a literal/],
  ])('%s: UNRESOLVED and no link', (_n, tf, reason) => {
    const { t1, result } = run(files(tf));
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toMatch(reason);
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toContain('linked by name');
  });

  it('a Terraform file that could not be read blocks the claim "exactly one"', () => {
    const { t1 } = run({
      ...files(lb('  name = "main-alb"\n  idle_timeout = 3\n')),
      'infra/bad.tf': 'resource "aws_lb" "x" {\n  n = "abc\n}\n',
    });
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('a Terraform file could not be read');
  });

  it('a name with other characters than letters, digits and hyphens is not linked', () => {
    const { t1, result } = run(
      files(lb('  name = "a b"\n  idle_timeout = 3\n'), 'a b', ingress({ name: '"a b"' })),
    );
    expect(t1.kind).toBe('UNRESOLVED');
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toContain('linked by name');
  });

  it('the annotation gives an idle value: it is established, and the by-name link is not used', () => {
    const { t1, result } = run(
      files(
        lb('  name = "main-alb"\n  idle_timeout = 60\n'),
        'main-alb',
        ingress({ name: 'main-alb', idle: '60' }),
      ),
    );
    expect(t1.kind).toBe('FAIL');
    expect(result.assumptions.map((a) => a.text).join('\n')).not.toContain('linked by name');
  });

  it('the annotation and the Terraform value differ: UNRESOLVED, both shown, never a verdict from either', () => {
    const { t1 } = run(
      files(
        lb('  name = "main-alb"\n  idle_timeout = 3\n'),
        'main-alb',
        ingress({ name: 'main-alb', idle: '60' }),
      ),
    );
    expect(t1.kind).toBe('UNRESOLVED');
    expect(t1.headline).toContain('give different idle timeouts');
    const chain = renderChain(t1).join('\n');
    expect(chain).toContain('LB idle annotation: 60 s');
    expect(chain).toContain('LB idle: 3 s @ "infra/lb.tf":3');
  });

  it('is never PASS or FAIL whatever the numbers: 200 seeded idle values', () => {
    for (let i = 0; i < 200; i += 1) {
      const idle = 1 + ((i * 37) % 4000);
      const { t1 } = run(files(lb(`  name = "main-alb"\n  idle_timeout = ${idle}\n`)));
      expect(t1.kind, `idle ${idle}`).toBe('UNRESOLVED');
    }
  });
});

describe('hostile names stay quoted, ASCII and unbreakable in the assumption', () => {
  it('a long name and a file name with spaces and control characters', () => {
    const name = 'a'.repeat(60);
    const { result } = run({
      'k8s/ingress.yaml': ingress({ name }),
      'infra/my lb\u0001.tf': lb(`  name = "${name}"\n  idle_timeout = 3\n`),
    });
    const text =
      result.assumptions.map((a) => a.text).find((t) => t.startsWith('Terraform load balancer')) ??
      '';
    expect(text).toContain('\\x01');
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
  });
});
