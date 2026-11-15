// The Action definition, checked as a file. It has never run on GitHub.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(import.meta.dirname, '..', '..');
const RAW = readFileSync(join(ROOT, 'action.yml'), 'utf8');

interface Step {
  id?: string;
  if?: unknown;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Action {
  inputs: Record<string, { default?: string; required?: boolean }>;
  outputs: Record<string, { value: string }>;
  runs: { using: string; steps: Step[] };
}
const action = parse(RAW) as Action;
const steps = action.runs.steps;

describe('action.yml: interface', () => {
  it('is a composite Action', () => {
    expect(action.runs.using).toBe('composite');
  });

  it('has exactly the five inputs, with the defaults and the upload off by default (B19)', () => {
    expect(Object.keys(action.inputs).sort()).toEqual([
      'config',
      'format',
      'path',
      'sarif-file',
      'upload-sarif',
    ]);
    expect(action.inputs['upload-sarif']?.default).toBe('false');
    expect(action.inputs.path?.default).toBe('.');
    expect(action.inputs.format?.default).toBe('human');
    expect(action.inputs['sarif-file']?.default).toBe('tripcurve.sarif');
    expect(action.inputs.config?.default).toBeUndefined();
    expect(action.inputs.config?.required).toBe(false);
  });

  it('has exactly the outputs sarif-file and exit-code, both fed by a step', () => {
    expect(Object.keys(action.outputs).sort()).toEqual(['exit-code', 'sarif-file']);
    expect(action.outputs['sarif-file']?.value).toContain('steps.check.outputs.sarif-file');
    // exit-code also falls back to the build step, so a failed build still sets it.
    expect(action.outputs['exit-code']?.value).toContain('steps.check.outputs.exit-code');
    expect(action.outputs['exit-code']?.value).toContain('steps.build.outputs.exit-code');
  });

  it('sets up Node, builds, checks, then has the upload step, in that order', () => {
    expect(steps.map((s) => s.uses?.split('@')[0] ?? s.id)).toEqual([
      'actions/setup-node',
      'build',
      'check',
      'github/codeql-action/upload-sarif',
    ]);
  });
});

describe('action.yml: no script injection', () => {
  const runs = steps.filter((s) => s.run !== undefined);

  it('has run bodies to check (so the check below can fail)', () => {
    expect(runs.length).toBe(2);
  });

  it('has no ${{ }} expression in any run body', () => {
    for (const s of runs) expect(s.run).not.toContain('${{');
  });

  it('passes every input through env, and only through env', () => {
    const check = steps.find((s) => s.id === 'check');
    expect(check?.env).toEqual({
      TRIPCURVE_PATH: '${{ inputs.path }}',
      TRIPCURVE_CONFIG: '${{ inputs.config }}',
      TRIPCURVE_FORMAT: '${{ inputs.format }}',
      TRIPCURVE_SARIF_FILE: '${{ inputs.sarif-file }}',
    });
    // `inputs.` appears nowhere else in the file except the check step's env (4) and the upload
    // step's condition (1; a condition is never a run body).
    const lines = RAW.split('\n').filter((l) => l.includes('inputs.') && !l.trim().startsWith('#'));
    expect(lines.length).toBe(5);
    expect(lines.filter((l) => l.includes('inputs.upload-sarif'))).toHaveLength(1);
  });

  it('only calls the one script', () => {
    for (const s of runs)
      expect(s.run).toMatch(/^bash "\$GITHUB_ACTION_PATH\/action\/run\.sh" (build|check)$/);
  });
});

describe('action.yml: third-party Actions', () => {
  const usesLines = RAW.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l));

  it('lists each third-party Action', () => {
    expect(usesLines.length).toBe(2);
  });

  // A reference is either pinned to a full 40-hex commit SHA with its tag in a comment, or carries
  // the marker `TODO(owner): pin SHA` (a lookup that failed). Today there is no marker: all pinned.
  it('pins every Action to a 40-hex commit SHA with the tag in a comment (a marked TODO is a KNOWN GAP and is printed)', () => {
    const gaps: string[] = [];
    for (const line of usesLines) {
      if (/uses:\s+\S+@[0-9a-f]{40}\s+#\s+v\d/.test(line)) continue;
      if (line.includes('TODO(owner): pin SHA')) {
        gaps.push(line.trim());
        continue;
      }
      expect.fail(`not pinned and not marked: ${line.trim()}`);
    }
    if (gaps.length > 0) console.warn(`KNOWN GAP, unpinned Actions: ${gaps.join(' | ')}`);
  });

  it('currently has no known gap (every SHA was looked up on 2026-11-12)', () => {
    expect(RAW).not.toContain('TODO(owner)');
  });
});

describe('.github/workflows/verify.yml: third-party Actions (review of B9)', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');
  const lines = workflow.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l));

  it('lists its Actions', () => {
    expect(lines.length).toBe(2);
  });

  it('pins each to a 40-hex SHA with the tag in a comment, or marks a TODO (a KNOWN GAP, printed)', () => {
    for (const line of lines) {
      if (/uses:\s+\S+@[0-9a-f]{40}\s+#\s+v\d/.test(line)) continue;
      if (line.includes('TODO(owner): pin SHA')) {
        console.warn(`KNOWN GAP, unpinned in verify.yml: ${line.trim()}`);
        continue;
      }
      expect.fail(`not pinned and not marked: ${line.trim()}`);
    }
  });

  it('uses the same setup-node pin as the Action', () => {
    const pin = (text: string) => /actions\/setup-node@([0-9a-f]{40})/.exec(text)?.[1];
    expect(pin(workflow)).toBeDefined();
    expect(pin(workflow)).toBe(pin(RAW));
  });
});

describe('action.yml: the upload step is opt-in (B19)', () => {
  const upload = steps.find((s) => s.uses?.startsWith('github/codeql-action/upload-sarif@'));
  const condition = String(upload?.if).replace(/\s+/g, ' ');

  it('exists', () => {
    expect(upload).toBeDefined();
  });

  it('runs only when upload-sarif is the string "true" and a SARIF file was written', () => {
    expect(condition).toContain("inputs.upload-sarif == 'true'");
    expect(condition).toContain("steps.check.outputs.sarif-file != ''");
    expect(condition).not.toMatch(/\bfalse\b/);
    expect(condition).not.toMatch(/\|\|/);
  });

  it('uses always(), so it runs after a failed check step (the default status check is success())', () => {
    expect(condition).toMatch(/^\$\{\{ always\(\) && /);
  });

  it('is the only conditional step', () => {
    expect(steps.filter((s) => s.if !== undefined).length).toBe(1);
  });

  it('uploads the file the check step wrote', () => {
    expect(upload?.with?.sarif_file).toBe('${{ steps.check.outputs.sarif-file }}');
  });

  it('requests no token', () => {
    expect(RAW).not.toMatch(/token|secrets\./i);
  });
});
