import { describe, expect, it } from 'vitest';
import {
  BRANCH_UNRESOLVED_TO_BE_MEASURED,
  declaredSource,
  defaultSource,
  fileSource,
  inputText,
  makeFinding,
  makeSourcedValue,
  makeUnresolved,
  stdinSource,
} from '../../src/core/index.js';
import { renderHuman } from '../../src/report/index.js';
import {
  buildReport,
  configError,
  defaultChain,
  finding,
  goodChain,
  unchecked,
  wf,
  workload,
} from '../support/report-fixtures.js';

const lines = (text: string): string[] => text.trimEnd().split('\n');

function oneBlock(findings = [finding('FAIL')], subject = workload('web')): string[] {
  return lines(renderHuman(buildReport({ results: [wf(subject, findings)] })));
}

describe('the report layout', () => {
  it('header, blank line, block, blank line, Assumptions, blank line, summary', () => {
    const out = oneBlock([finding('FAIL', 'T1', workload('web'), 'idle close 6 s is not longer')]);
    expect(out[0]).toBe('tripcurve 0.1.0   checked "."   3 files read');
    expect(out[1]).toBe('');
    expect(out[2]).toBe('Workload "web" (Deployment) in "k8s/web.yaml"');
    expect(out[3]).toBe('  FAIL T1  idle close 6 s is not longer');
    expect(out).toContain('Assumptions');
    expect(out.at(-1)).toBe('Summary: 1 failed; not a clean result');
    expect(out.at(-2)).toBe('');
  });

  it('ends with exactly one newline', () => {
    const text = renderHuman(buildReport({ results: [wf(workload('web'), [finding('FAIL')])] }));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('the header counts one file in the singular', () => {
    expect(
      renderHuman(buildReport({ filesRead: 1 })).startsWith('tripcurve 0.1.0   checked ".."'),
    ).toBe(false);
    expect(lines(renderHuman(buildReport({ filesRead: 1 })))[0]).toBe(
      'tripcurve 0.1.0   checked "."   1 file read',
    );
  });
});

describe('result lines (grammar: the word padded to 4 columns)', () => {
  it('N/A aligns with PASS and each PASS or N/A line names its deciding source', () => {
    const out = oneBlock([
      finding('N/A', 'T1', workload('web'), 'sync worker', goodChain('k8s/web.yaml', 19)),
      finding('PASS', 'T2', workload('web'), 'preStop sleep 10 s', goodChain('k8s/web.yaml', 26)),
    ]);
    expect(out).toContain('  N/A  T1  sync worker ("k8s/web.yaml":19)');
    // the PASS line has no label of its own for T2 in B1; its headline is tripcurve text
    expect(out).toContain('  PASS T2  preStop sleep 10 s ("k8s/web.yaml":26)');
  });

  it('a default source is the deciding source, wrapped under the headline', () => {
    const out = oneBlock([
      finding(
        'PASS',
        'T1',
        workload('web'),
        'idle close 6 s is longer than LB idle 3 s',
        defaultChain(),
      ),
    ]);
    expect(out.slice(3, 6)).toEqual([
      '  PASS T1  idle close 6 s is longer than LB idle 3 s (default: Node',
      '           keepAliveTimeout 5 s + buffer 1 s (Node 22.x from 22.19; measured on',
      '           22.23.2))',
    ]);
  });

  it('a PASS line shows no chain unless --verbose; --verbose adds every step', () => {
    const f = finding(
      'PASS',
      'T1',
      workload('web'),
      'idle close 12 s is longer',
      goodChain('k8s/a.yaml', 7),
    );
    const plain = lines(renderHuman(buildReport({ results: [wf(workload('web'), [f])] })));
    const verbose = lines(
      renderHuman(buildReport({ results: [wf(workload('web'), [f])] }), { verbose: true }),
    );
    expect(plain.some((l) => l.startsWith('           idle close 12 s'))).toBe(false);
    expect(verbose).toContain('           idle close 12 s  "k8s/a.yaml":7');
  });

  it('UNRESOLVED continues its headline aligned under the headline (17 columns)', () => {
    const long = 'x'.repeat(30);
    const f = finding('UNRESOLVED', 'T1', workload('web'), `${long} ${long} ${long}`);
    const out = oneBlock([f]);
    expect(out[3]).toBe(`  UNRESOLVED T1  ${long} ${long}`);
    expect(out[4]).toBe(`${' '.repeat(17)}${long}`);
  });

  it('NOT EVALUATED and VERSION-DEPENDENT print their words in full', () => {
    const out = oneBlock([finding('NOT EVALUATED', 'T3'), finding('VERSION-DEPENDENT', 'T1')]);
    expect(out.some((l) => l.startsWith('  NOT EVALUATED T3  '))).toBe(true);
    expect(out.some((l) => l.startsWith('  VERSION-DEPENDENT T1  '))).toBe(true);
  });
});

describe('detail lines (label in 16 columns, value from column 28)', () => {
  it('prints a numeric value with its unit and a file source, aligned', () => {
    const out = oneBlock([
      finding('FAIL', 'T1', workload('web'), 'h', goodChain('k8s/ingress.yaml', 9)),
    ]);
    expect(out[4]).toBe('           idle close 12 s  "k8s/ingress.yaml":9');
  });

  it('a label wider than its column takes its own line so the value column stays aligned', () => {
    const chain = [
      {
        label: 'keepAliveTimeoutBuffer',
        value: makeSourcedValue({
          value: 1000,
          unit: 'ms',
          source: fileSource(inputText('src/server.ts'), 12),
          basis: 'declared',
        }),
      },
    ];
    const out = oneBlock([finding('FAIL', 'T1', workload('web'), 'h', chain)]);
    expect(out[4]).toBe('           keepAliveTimeoutBuffer 1000 ms');
    expect(out[5]).toBe(`${' '.repeat(28)}"src/server.ts":12`);
  });

  it('an unresolved value prints its fixed reason, and declare hints print as plain text', () => {
    const f = finding('UNRESOLVED', 'T1', workload('web'), 'h', [
      { label: 'LB idle', value: makeUnresolved('no idle timeout in any file') },
    ]);
    const withDeclare = makeFinding({
      rule: 'T1',
      subject: workload('web'),
      kind: 'UNRESOLVED',
      headline: 'h',
      chain: f.chain,
      declare: ['declare it in tripcurve.yaml or link the Terraform load balancer'],
    });
    const out = oneBlock([withDeclare]);
    expect(out[4]).toBe('           LB idle          no idle timeout in any file');
    expect(out[5]).toBe(
      '           declare it in tripcurve.yaml or link the Terraform load balancer',
    );
  });

  it('input text is quoted and never starts a line (a value read from a file)', () => {
    const chain = [
      {
        label: 'Node 22.23',
        detail: 'image',
        value: makeSourcedValue({
          value: inputText('node:22\u001b[2J"x"'),
          unit: 'none',
          source: fileSource(inputText('k8s/café.yaml'), 16),
          basis: 'declared',
        }),
      },
    ];
    const out = oneBlock([finding('FAIL', 'T1', workload('web'), 'h', chain)]);
    expect(out.slice(4, 6)).toEqual([
      '           Node 22.23       image "node:22\\x1b[2J\\"x\\""',
      '                            at "k8s/caf\\u00e9.yaml":16',
    ]);
  });

  it('a plain list of file names is quoted, comma separated, and capped', () => {
    const files = Array.from({ length: 25 }, (_v, i) => inputText(`src/f${i}.ts`));
    const [first, ...rest] = files;
    if (first === undefined) throw new Error('unreachable');
    const f = finding('FAIL', 'T1', workload('web'), 'h', [
      { label: 'source', detail: 'no setting found in 25 files read', value: first, more: rest },
    ]);
    const out = oneBlock([f]);
    const text = out.join('\n');
    expect(text).toContain('("src/f0.ts", "src/f1.ts", and 23 more)');
    expect(text).not.toContain('src/f2.ts');
    for (const l of out) expect(l.length).toBeLessThanOrEqual(80);
  });

  it('a wrap never leaves a continuation line that starts with quoted input', () => {
    const files = Array.from({ length: 6 }, (_v, i) =>
      inputText(`src/a-fairly-long-file-name-${i}.ts`),
    );
    const [first, ...rest] = files;
    if (first === undefined) throw new Error('unreachable');
    const f = finding('FAIL', 'T1', workload('web'), 'h', [
      { label: 'source', detail: 'files read', value: first, more: rest },
    ]);
    const out = oneBlock([f]);
    for (const l of out.slice(4)) {
      expect(l.trimStart().startsWith('"')).toBe(false);
    }
    expect(out.slice(4).length).toBeGreaterThan(1);
  });

  it('--verbose marks a declared value with its basis; the plain report does not', () => {
    const chain = [
      {
        label: 'longest request',
        value: makeSourcedValue({
          value: 5,
          unit: 's',
          source: declaredSource(inputText('tripcurve.yaml'), 4),
          basis: 'declared',
        }),
      },
    ];
    const f = finding('FAIL', 'T1', workload('web'), 'h', chain);
    const r = buildReport({ results: [wf(workload('web'), [f])] });
    expect(renderHuman(r)).toContain('longest request 5 s\n'.slice(0, 0));
    expect(renderHuman(r)).not.toContain('(declared)');
    expect(renderHuman(r, { verbose: true })).toContain('"tripcurve.yaml":4 (declared)');
  });

  it('a source on standard input names the document and line', () => {
    const chain = [
      {
        label: 'LB idle',
        value: makeSourcedValue({
          value: 60,
          unit: 's',
          source: stdinSource(1, 9),
          basis: 'declared',
        }),
      },
    ];
    const out = oneBlock([finding('FAIL', 'T1', workload('web'), 'h', chain)]);
    expect(out[4]).toBe('           LB idle 60 s     <stdin> document 1, line 9');
  });

  it('every known range of a VERSION-DEPENDENT result prints with its basis', () => {
    const chain = defaultChain();
    const f = makeFinding({
      rule: 'T1',
      subject: workload('web'),
      kind: 'VERSION-DEPENDENT',
      headline: 'idle close depends on the Node version: 2 ranges apply',
      chain: [],
      branches: [
        { range: '22.x from 22.19', outcome: 'FAIL', chain },
        { range: '24.x', outcome: BRANCH_UNRESOLVED_TO_BE_MEASURED, chain },
      ],
      declare: ['pin the image tag, or declare runtime.node in tripcurve.yaml'],
    });
    const out = oneBlock([f]);
    expect(out).toContain('           every known range evaluated:');
    expect(out).toContain(
      '           22.x from 22.19  idle close 6 s would FAIL (measured on 22.23.2)',
    );
    expect(out).toContain('           24.x             idle close 6 s to be measured');
    expect(out).toContain(
      '           pin the image tag, or declare runtime.node in tripcurve.yaml',
    );
  });
});

describe('a branch with no number prints the reason, and a PASS cites the setting (bolt B3)', () => {
  const unresolvedBranch = (range: string, reason: string) => ({
    range,
    outcome: 'UNRESOLVED' as const,
    chain: [{ label: 'idle close', value: makeUnresolved(reason) }],
  });

  it('prints `unresolved: <reason>` for a range no entry covers, and never a number', () => {
    const f = makeFinding({
      rule: 'T1',
      subject: workload('web'),
      kind: 'VERSION-DEPENDENT',
      headline: 'Node version unknown',
      chain: [],
      branches: [
        unresolvedBranch('before 22.12', 'no knowledge-base entry covers this range'),
        { range: 'Node 22.x from 22.12', outcome: 'FAIL', chain: defaultChain() },
      ],
    });
    const out = oneBlock([f]);
    expect(out).toContain(
      '           before 22.12     unresolved: no knowledge-base entry covers this',
    );
    expect(out).toContain('                            range');
    // the `Node ` of a range label is dropped on the line: the block is about Node
    expect(out).toContain(
      '           22.x from 22.12  idle close 6 s would FAIL (measured on 22.23.2)',
    );
  });

  it('a label wider than its column takes its own line and the reason follows at the value column', () => {
    const f = makeFinding({
      rule: 'T1',
      subject: workload('web'),
      kind: 'VERSION-DEPENDENT',
      headline: 'Node version unknown',
      chain: [],
      branches: [
        unresolvedBranch('19 to before 20.20.2', 'no knowledge-base entry covers this range'),
        { range: 'Node 20.x from 20.20.2', outcome: 'FAIL', chain: defaultChain() },
      ],
    });
    const out = oneBlock([f]);
    const at = out.indexOf('           19 to before 20.20.2');
    expect(at).toBeGreaterThan(0);
    expect(out[at + 1]).toBe(
      '                            unresolved: no knowledge-base entry covers this',
    );
  });

  it('a PASS cites the deciding setting and prints the measured basis after it', () => {
    const idle = makeSourcedValue({
      value: 66,
      unit: 's',
      source: defaultSource({
        citation: 'explicit keepAliveTimeout + 1 s, Node',
        range: 'Node 22.x from 22.12',
        basisText: 'measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5',
        bare: true,
      }),
      basis: 'measured-on',
    });
    const f = makeFinding({
      rule: 'T1',
      subject: workload('web'),
      kind: 'PASS',
      headline: 'idle close 66 s is longer than LB idle 60 s',
      chain: [
        { label: 'idle close', value: idle, decidedBy: fileSource(inputText('src/server.ts'), 7) },
      ],
      decidingNote:
        'keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5)',
    });
    const out = oneBlock([f]);
    expect(out[3]).toBe(
      '  PASS T1  idle close 66 s is longer than LB idle 60 s ("src/server.ts":7,',
    );
    expect(out[4]).toBe(
      '           keepAliveTimeout 65 s + 1 s (Node 22.x from 22.12; measured at K = 7,',
    );
    expect(out[5]).toBe('           12 and 65 s on 5 releases from 22.12.0 to 22.23.5))');
  });

  it("without decidedBy a PASS cites the value's own source, as before", () => {
    const out = oneBlock([finding('PASS', 'T1', workload('web'), 'idle close 12 s is longer')]);
    expect(out[3]).toBe('  PASS T1  idle close 12 s is longer ("k8s/a.yaml":7)');
  });

  it('--verbose prints the rule value as a chain line with its basis', () => {
    const idle = makeSourcedValue({
      value: 66,
      unit: 's',
      source: defaultSource({
        citation: 'explicit keepAliveTimeout + 1 s, Node',
        range: 'Node 22.x from 22.12',
        basisText: 'measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5',
        bare: true,
      }),
      basis: 'measured-on',
    });
    const f = makeFinding({
      rule: 'T1',
      subject: workload('web'),
      kind: 'PASS',
      headline: 'idle close 66 s is longer than LB idle 60 s',
      chain: [
        { label: 'idle close', value: idle, decidedBy: fileSource(inputText('src/server.ts'), 7) },
      ],
    });
    const text = renderHuman(buildReport({ results: [wf(workload('web'), [f])] }), {
      verbose: true,
    });
    expect(text.replace(/\s+/g, ' ')).toContain(
      'idle close 66 s explicit keepAliveTimeout + 1 s, Node (Node 22.x from 22.12; measured at K = 7, 12 and 65 s on 5 releases from 22.12.0 to 22.23.5)',
    );
  });
});

describe('WAIVED lines (one form, continuation 11 columns, never starting with quoted input)', () => {
  it('prints the original kind and headline, the date, the quoted reason and its source', () => {
    const out = oneBlock([
      finding('WAIVED', 'T2', workload('web'), 'no drain delay before SIGTERM'),
    ]);
    expect(out[3]).toBe('  WAIVED T2  (was FAIL: no drain delay before SIGTERM) until 2027-01-31:');
    // the fixed word `reason` stays with its quoted text; the line does not start with quotes
    expect(out[4]).toBe('           reason "drains in sidecar" from "tripcurve.yaml":11');
  });
});

describe('colour wraps only the result word', () => {
  const r = buildReport({
    results: [
      wf(workload('web'), [
        finding('FAIL', 'T1'),
        finding('UNRESOLVED', 'T3'),
        finding('PASS', 'T2'),
        finding('N/A', 'T4'),
      ]),
    ],
  });
  const coloured = renderHuman(r, { color: true });
  const plain = renderHuman(r);

  it('removing the escapes gives the plain text byte for byte', () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
    expect(coloured.replace(/\u001b\[[0-9;]*m/g, '')).toBe(plain);
  });

  it('uses red for FAIL, yellow for UNRESOLVED, green for PASS and dim for N/A', () => {
    expect(coloured).toContain('  \u001b[31mFAIL\u001b[0m T1  ');
    expect(coloured).toContain('  \u001b[33mUNRESOLVED\u001b[0m T3  ');
    expect(coloured).toContain('  \u001b[32mPASS\u001b[0m T2  ');
    expect(coloured).toContain('  \u001b[2mN/A\u001b[0m  T4  ');
  });

  it('plain output has no escape character at all', () => {
    expect(plain.includes('\u001b')).toBe(false);
  });
});

describe('Files not checked, Assumptions and the not-checked workloads', () => {
  it('lists unchecked files with fixed wording, continuation at 21 columns', () => {
    const out = lines(
      renderHuman(
        buildReport({
          results: [wf(workload('web'), [finding('PASS')])],
          unchecked: [
            unchecked('k8s/broken.yaml', 'parse-error', 14),
            unchecked('k8s/huge.yaml', 'over-size'),
            unchecked('k8s/deep.yaml', 'over-depth'),
          ],
        }),
      ),
    );
    const at = out.indexOf('Files not checked');
    expect(out.slice(at, at + 4)).toEqual([
      'Files not checked',
      '  UNRESOLVED (file)  could not parse "k8s/broken.yaml": YAML syntax error at',
      '                     line 14',
      '  UNRESOLVED (file)  skipped "k8s/huge.yaml": larger than the 5 MB limit',
    ]);
    expect(out).toContain('  UNRESOLVED (file)  skipped "k8s/deep.yaml": too deeply nested');
  });

  it('lists workloads, Ingresses and kinds that were not checked', () => {
    const out = lines(
      renderHuman(
        buildReport({
          results: [],
          notChecked: [
            {
              subjectKind: 'workload',
              subject: inputText('worker'),
              kind: 'Deployment',
              file: inputText('k8s/worker.yaml'),
              reasonCode: 'no-recognised-lb',
            },
            {
              subjectKind: 'workload',
              subject: inputText('cron'),
              kind: 'Deployment',
              file: inputText('k8s/cron.yaml'),
              reasonCode: 'no-recognised-lb',
            },
            {
              subjectKind: 'ingress',
              subject: inputText('legacy'),
              kind: 'Ingress',
              file: inputText('k8s/legacy.yaml'),
              reasonCode: 'not-alb-ingress',
            },
            {
              subjectKind: 'kind',
              kind: 'HTTPRoute',
              file: inputText('k8s/route.yaml'),
              reasonCode: 'kind-not-checked',
            },
          ],
        }),
      ),
    );
    expect(out).toEqual([
      'tripcurve 0.1.0   checked "."   3 files read',
      '',
      'Assumptions',
      '  - No load balancer found in the checked files for 2 workloads, T1 to T3 not',
      '    checked for them:',
      '    Workload "worker" (Deployment) in "k8s/worker.yaml"',
      '    Workload "cron" (Deployment) in "k8s/cron.yaml"',
      '  - Not checked: Ingress "legacy" in "k8s/legacy.yaml" is not recognised as an',
      '    ALB Ingress.',
      '  - Not checked: kind "HTTPRoute" in "k8s/route.yaml" (Gateway API) is not a',
      '    kind tripcurve checks.',
      '',
      'Summary: nothing checked; not a clean result',
    ]);
  });

  it('a single workload reads "it"', () => {
    const text = renderHuman(
      buildReport({
        notChecked: [
          {
            subjectKind: 'workload',
            subject: inputText('worker'),
            kind: 'Deployment',
            file: inputText('k8s/worker.yaml'),
            reasonCode: 'no-recognised-lb',
          },
        ],
      }),
    );
    expect(text).toContain('for 1 workload, T1 to T3 not\n    checked for it:');
  });
});

describe('the no-files case, the config-error case and the stdin header', () => {
  it('the no-files case has no blank line between the note and the summary', () => {
    expect(
      renderHuman(buildReport({ noRecognisedFiles: true, filesRead: 0, checked: './docs' })),
    ).toBe(
      [
        'tripcurve 0.1.0   checked "./docs"   0 files read',
        '',
        'No Kubernetes, server or Terraform files found under "./docs".',
        'Summary: nothing checked; not a clean result',
        '',
      ].join('\n'),
    );
  });

  it('the config-error case prints each error then "Nothing was checked." and no header', () => {
    expect(
      renderHuman(
        buildReport({
          configErrors: [
            configError('longest_request_s', 6, 'bad-value'),
            configError('ghost', 9, 'declaration-names-no-workload'),
            configError('x', 2, 'declaration-names-several-workloads'),
            configError('y', 3, 'unknown-key'),
            configError('z', 4, 'invalid-schema'),
          ],
        }),
      ),
    ).toBe(
      [
        'Config error in "tripcurve.yaml" at line 6: key "longest_request_s" has a value',
        'that is not valid.',
        'Config error in "tripcurve.yaml" at line 9: key "ghost" names no workload that',
        'was read.',
        'Config error in "tripcurve.yaml" at line 2: key "x" names more than one',
        'workload.',
        'Config error in "tripcurve.yaml" at line 3: key "y" is not a key tripcurve',
        'knows.',
        'Config error in "tripcurve.yaml" at line 4: key "z" is not in a form tripcurve',
        'reads.',
        'Nothing was checked.',
        '',
      ].join('\n'),
    );
  });

  it('the config-error case prints at most ten errors and says how many more', () => {
    const errors = Array.from({ length: 25 }, (_v, i) => configError(`k${i}`, i + 1));
    const text = renderHuman(buildReport({ configErrors: errors }));
    expect(text.match(/Config error in/g)).toHaveLength(10);
    expect(text).toContain('... and 15 more configuration errors.');
    expect(text.endsWith('Nothing was checked.\n')).toBe(true);
  });

  it('standard input is named as a place-holder, never quoted', () => {
    const r = buildReport({ checked: '-', results: [], filesRead: 0 });
    expect(
      lines(
        renderHuman({
          ...r,
          header: { ...r.header, checked: '<stdin>', stream: { documents: 6 } },
        }),
      )[0],
    ).toBe('tripcurve 0.1.0   checked <stdin>   1 stream, 6 documents read');
  });

  it('a block in a stdin document names the document', () => {
    const subject = workload('api');
    const r = buildReport({
      results: [{ workload: subject, file: stdinSource(3, 2), findings: [finding('PASS')] }],
    });
    expect(renderHuman(r)).toContain('Workload "api" (Deployment) in <stdin> document 3');
  });
});

describe('workload headers (rule 1: the kind prints bare only from the fixed list)', () => {
  it('prints a kind off the list quoted', () => {
    const out = oneBlock([finding('PASS')], workload('x', 'a', inputText('Rollout')));
    expect(out[2]).toBe('Workload "x" ("Rollout") in "k8s/web.yaml"');
  });

  it('prints every fixed kind bare', () => {
    for (const kind of ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod'] as const) {
      expect(oneBlock([finding('PASS')], workload('x', 'a', kind))[2]).toBe(
        `Workload "x" (${kind}) in "k8s/web.yaml"`,
      );
    }
  });

  it('a long name is cut with ... and the kind and file move to the next line', () => {
    const out = oneBlock([finding('PASS')], workload('n'.repeat(300)));
    expect(out[2]?.length).toBeLessThanOrEqual(80);
    expect(out[2]).toMatch(/^Workload "n+\.\.\."$/);
    expect(out[3]).toBe('           (Deployment) in "k8s/web.yaml"');
  });

  it('a name that looks like a result line stays inside its quotes', () => {
    const out = oneBlock([finding('PASS')], workload('x\nPASS T1  all good'));
    expect(out[2]).toBe('Workload "x\\x0aPASS T1  all good" (Deployment) in "k8s/web.yaml"');
  });
});

describe('a default source in a chain', () => {
  it('prints as the expected report layout does, wrapped under the value column', () => {
    const f = finding('FAIL', 'T1', workload('web'), 'idle close 6 s is not longer', [
      ...defaultChain(),
    ]);
    const out = oneBlock([f]);
    expect(out.slice(4, 6)).toEqual([
      '           idle close 6 s   default: Node keepAliveTimeout 5 s + buffer 1 s',
      '                            (Node 22.x from 22.19; measured on 22.23.2)',
    ]);
    // a cited default is not a file source
    expect(defaultSource({ citation: 'c', basisText: 'documented' }).type).toBe('default');
  });
});
