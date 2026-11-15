// B13: the old-Node measurement was attempted under Rosetta 2 and could not run on
// the build host. Two things must stay true: the three trap entries keep the honest basis and label
// (nothing here may turn them into a "measured" claim), and the attempt record exists and holds every
// command it claims, so the statement "cannot run here" can be checked and repeated.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEntries } from '../../measure/lib/lanes-core.mjs';
import { basisWords, defaultKnowledgeBase } from '../../src/kb/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ATTEMPT = join(ROOT, 'measure', 'results', '2026-11-12-b13-attempt.txt');
const TRAP_IDS = ['node-headers-trap-10x', 'node-headers-trap-12x', 'node-headers-trap-13x'];

describe('B13: the three old-Node trap entries stay unmeasured', () => {
  const raw = loadEntries(join(ROOT, 'src', 'kb', 'data'));
  const kb = defaultKnowledgeBase();

  it.each(TRAP_IDS)('%s keeps basis from-changelogs, and no script or tolerance', (id) => {
    const e = raw.find((x) => x.id === id);
    expect(e, id).toBeDefined();
    expect(e?.basis).toBe('from-changelogs');
    expect(e?.scriptRef).toBeUndefined();
    expect(e?.toleranceMs).toBeUndefined();
  });

  it.each(TRAP_IDS)('%s prints the label "from changelogs, not measured"', (id) => {
    const e = kb.entries.find((x) => x.id === id);
    expect(e, id).toBeDefined();
    if (e !== undefined) expect(basisWords(e)).toBe('from changelogs, not measured');
  });

  it.each(TRAP_IDS)('%s is deferred to B13 and its reason names the attempt record', (id) => {
    const e = raw.find((x) => x.id === id);
    expect(e?.deferredTo?.bolt).toBe('B13');
    expect(e?.deferredTo?.reason).toContain('Attempted in B13 (2026-11-12)');
    expect(e?.deferredTo?.reason).toContain('measure/results/2026-11-12-b13-attempt.txt');
    expect(e?.deferredTo?.reason).toMatch(/Rosetta 2 or an x64 host/);
    expect(e?.deferredTo?.reason).not.toMatch(/measured on|were measured/);
  });
});

describe('B13: the attempt record', () => {
  const claimed = [
    '$ arch -x86_64 /usr/bin/true',
    '$ /usr/bin/pgrep oahd',
    '$ sysctl -n sysctl.proc_translated',
    '$ ls /Library/Apple/usr/share/rosetta',
    '$ curl -sS https://nodejs.org/dist/index.json',
    '$ curl -sS https://nodejs.org/dist/v10.15.3/',
    '$ curl -sS https://nodejs.org/dist/v12.18.4/',
    '$ curl -sS https://nodejs.org/dist/v13.12.0/',
  ];

  it('exists', () => {
    expect(existsSync(ATTEMPT)).toBe(true);
  });

  it.each(claimed)('contains the command %s', (cmd) => {
    expect(readFileSync(ATTEMPT, 'utf8')).toContain(cmd);
  });

  it('records the failure it relies on, and no installation', () => {
    const text = readFileSync(ATTEMPT, 'utf8');
    expect(text).toContain('Bad CPU type in executable');
    expect(text).toContain('osx-arm64 in any release up to v15: none');
    expect(text).toContain('Nothing was installed');
    expect(text).not.toMatch(/install-rosetta/);
  });

  it('is described by the B13 readme, which says what would make it run', () => {
    const text = readFileSync(join(ROOT, 'measure', 'README-b13.md'), 'utf8');
    expect(text).toContain('from changelogs, not measured');
    expect(text).toContain('Rosetta 2');
    expect(text).toContain('x64');
  });
});
