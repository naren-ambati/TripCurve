// Bolt B15: checks on the documentation set. The checks themselves are in
// test/support/docs-check.ts; each is shown here to FAIL on a planted bad text, so none of them can
// pass by doing nothing.
//
// What is checked, and what is not (the number check is a pragmatic one, named for what it does):
//   - every Mermaid block in README.md, CHANGELOG.md and docs/*.md has a text fallback;
//   - every quoted vendor text is found, word for word, in the file its Source line cites, with a date;
//   - every verbatim block is made of lines of the file it names;
//   - every number written with a unit (s or ms) in the NEW docs appears in a file that the same
//     paragraph, item or table row cites. This does NOT prove the sentence is true.
//   - the rules page repeats the `--explain` statements and quotes, and the README repeats `--help`;
//   - "6 of 26" is never written without its limit in the same section;
//   - no licence text or SPDX header for tripcurve, no LICENSE file, and package.json stays
//     private and UNLICENSED.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPLAIN_ENTRIES } from '../../src/evaluate/explain-entries.js';
import {
  blocks,
  brokenCitations,
  linkProblems,
  mermaidProblems,
  numberProblems,
  quoteProblems,
  ROOT,
  sections,
  sixOf26Problems,
  subcommandProblems,
  topicSentences,
  unapprovedSentences,
  units,
  verbatimProblems,
} from '../support/docs-check.js';
import { runBuilt } from '../support/e2e.js';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** The pages this bolt wrote. The older pages (limits, research, action, arena extract) are sources. */
const NEW_DOCS = [
  'README.md',
  'CHANGELOG.md',
  'docs/rules.md',
  'docs/how-defaults-were-measured.md',
  'docs/add-a-knowledge-base-entry.md',
  'docs/ci-and-sarif.md',
  'docs/security.md',
  'docs/release-checklist.md',
];

const ALL_DOCS = [
  'README.md',
  'CHANGELOG.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

describe('the docs set exists', () => {
  for (const f of NEW_DOCS) {
    it(`${f} exists and is not empty`, () => {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(read(f).trim().length, f).toBeGreaterThan(500);
    });
  }
  it('the dated lookup file of this bolt exists', () => {
    expect(existsSync(join(ROOT, 'docs/lookups-b15.txt'))).toBe(true);
  });
});

describe('every Mermaid block has a text fallback', () => {
  for (const f of ALL_DOCS) {
    it(f, () => {
      expect(mermaidProblems(read(f))).toEqual([]);
    });
  }
  it('there is at least one diagram in the new docs', () => {
    const count = NEW_DOCS.flatMap((f) => blocks(read(f))).filter(
      (b) => b.kind === 'fence' && b.lang === 'mermaid',
    ).length;
    expect(count).toBeGreaterThanOrEqual(5);
  });
  it('can fail: a diagram with no fallback, or a fallback after other text, is reported', () => {
    const bad = 'x\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\nThe next paragraph.\n';
    expect(mermaidProblems(bad)).toHaveLength(1);
    const late = '```mermaid\nflowchart LR\n  A-->B\n```\n\nSomething.\n\nText fallback: a to b\n';
    expect(mermaidProblems(late)).toHaveLength(1);
    const good = '```mermaid\nflowchart LR\n  A-->B\n```\n\nText fallback: a to b\n';
    expect(mermaidProblems(good)).toEqual([]);
  });
});

describe('cited files exist', () => {
  for (const f of NEW_DOCS) {
    it(f, () => {
      expect(brokenCitations(read(f), f)).toEqual([]);
    });
  }
  it('can fail: a cited path under a checked folder that does not exist is reported', () => {
    expect(brokenCitations('see `docs/does-not-exist.md`', 'x')).toHaveLength(1);
    expect(brokenCitations('see `docs/research.md`', 'x')).toEqual([]);
  });
});

describe('relative links resolve', () => {
  for (const f of NEW_DOCS) {
    it(f, () => {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
      expect(linkProblems(read(f), dir)).toEqual([]);
    });
  }
  it('can fail', () => {
    expect(linkProblems('[x](docs/missing-page.md)', '')).toHaveLength(1);
    expect(linkProblems('[x](https://example.invalid/a)', '')).toEqual([]);
  });
});

describe('quoted vendor text is found, word for word, in the cited file, with a date', () => {
  for (const f of NEW_DOCS) {
    it(f, () => {
      expect(quoteProblems(read(f))).toEqual([]);
    });
  }
  it('there are quotes to check', () => {
    const n = NEW_DOCS.flatMap((f) => blocks(read(f))).filter((b) => b.kind === 'quote').length;
    expect(n).toBeGreaterThanOrEqual(6);
  });
  it('can fail: an altered quote, a missing Source line and a missing date are reported', () => {
    const base =
      "> We recommend setting your queue's visibility timeout to six times your Event Function timeout\n>\n";
    const ok = `${base}> Source: AWS (\`docs/lookups-b5.txt\`), read 2026-11-12\n`;
    expect(quoteProblems(ok)).toEqual([]);
    expect(quoteProblems(ok.replace('six times', 'seven times'))).toHaveLength(1);
    expect(quoteProblems(base)).toHaveLength(1);
    expect(quoteProblems(ok.replace(', read 2026-11-12', ''))).toHaveLength(1);
  });
});

describe('verbatim blocks are lines of the named file', () => {
  for (const f of NEW_DOCS) {
    it(f, () => {
      expect(verbatimProblems(read(f))).toEqual([]);
    });
  }
  it('there are verbatim blocks to check', () => {
    const n = NEW_DOCS.map((f) => (read(f).match(/^Verbatim from `/gm) ?? []).length).reduce(
      (a, b) => a + b,
      0,
    );
    expect(n).toBeGreaterThanOrEqual(4);
  });
  it('can fail: a line that is not in the file is reported', () => {
    const bad = 'Verbatim from `docs/lookups-b5.txt`:\n\n```text\nnot a line of that file\n```\n';
    expect(verbatimProblems(bad)).toHaveLength(1);
  });
});

describe('every number with a unit appears in a file its own paragraph, item or row cites', () => {
  for (const f of NEW_DOCS) {
    it(f, () => {
      expect(numberProblems(read(f))).toEqual([]);
    });
  }
  it('there are numbers to check', () => {
    const n = NEW_DOCS.flatMap((f) => units(read(f))).filter((u) => /\d\s?(ms|s)\b/.test(u.text));
    expect(n.length).toBeGreaterThan(20);
  });
  it('can fail: a number that is not in the cited file, or a number with no citation, is reported', () => {
    expect(numberProblems('The idle close is 6.0 s (`docs/research.md` section 2).')).toEqual([]);
    expect(numberProblems('The idle close is 7777 s (`docs/research.md` section 2).')).toHaveLength(
      1,
    );
    expect(numberProblems('The idle close is 6.0 s.')).toHaveLength(1);
    // the same quantity in the other unit counts: 6000 ms is 6 s
    expect(numberProblems('The delay is 5000 ms (`docs/research.md` section 8).')).toEqual([]);
  });
});

describe('the rules page follows `--explain`', () => {
  const rules = read('docs/rules.md')
    .split('\n')
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
  for (const [rule, entry] of Object.entries(EXPLAIN_ENTRIES)) {
    it(`${rule}: the statement and every vendor quote are written as --explain prints them`, () => {
      expect(rules, `${rule} statement`).toContain(entry.statement.replace(/\s+/g, ' '));
      for (const q of entry.quotes) {
        expect(rules, `${rule} quote`).toContain(q.quote.replace(/\s+/g, ' '));
        expect(rules, `${rule} url`).toContain(q.url);
      }
    });
  }
  it('names every result kind for every rule', () => {
    const text = read('docs/rules.md');
    for (const s of sections(text).filter((x) => /^T[1-4]:/.test(x.heading))) {
      for (const kind of ['PASS', 'FAIL', 'UNRESOLVED', 'VERSION-DEPENDENT', 'N/A']) {
        expect(s.body, `${s.heading} must say what ${kind} means`).toContain(`| ${kind} |`);
      }
    }
  });
});

describe('the README', () => {
  const readme = read('README.md');
  it('prints the --help text of the built command', () => {
    const help = runBuilt(['--help']);
    expect(help.status).toBe(0);
    expect(readme).toContain(help.stdout.trimEnd());
  });
  it('says the licence is decided by the maintainer before release, and has no badge', () => {
    expect(readme).toContain('Licence: decided by the maintainer before release.');
    // No badge: an image is allowed only when it is a local screenshot under docs/screenshots/ (the test
    // evidence); anything else, in particular a hosted status image, is a badge and is refused.
    expect(readme).not.toMatch(/!\[[^\]]*\]\((?!docs\/screenshots\/[A-Za-z0-9_-]+\.png\))[^)]*\)/);
    expect(readme).not.toMatch(/shields\.io|badge|build passing|ci passing/i);
  });
  it('says where the source is, that it is not on npm, and claims only the recorded hosted runs', () => {
    expect(readme).toContain('The source is at https://github.com/naren-ambati/TripCurve.');
    expect(readme).not.toContain('will be at');
    expect(readme).toContain('tripcurve is not published to npm.');
    expect(readme).not.toMatch(
      /is (now )?public|has been published|CI (is )?(green|passing)|ran green/i,
    );
  });
  it('links the three-step demo and every documentation page', () => {
    for (const link of ['demo/README.md', ...NEW_DOCS.filter((f) => f.startsWith('docs/'))]) {
      expect(readme, link).toContain(link);
    }
  });
});

describe('"6 of 26" always comes with its limit', () => {
  for (const f of NEW_DOCS) {
    it(f, () => {
      expect(sixOf26Problems(read(f))).toEqual([]);
    });
  }
  it('is written at least once', () => {
    expect(NEW_DOCS.some((f) => /6 of 26|6-of-26/.test(read(f)))).toBe(true);
  });
  it('can fail: the result without its limit in the same section is reported', () => {
    const bad = '## A\n\n6 of 26 requests failed.\n\n## B\n\nThrough toxiproxy, not an ALB.\n';
    expect(sixOf26Problems(bad)).toHaveLength(1);
    const good = '## A\n\n6 of 26 requests failed, through toxiproxy, not an ALB.\n';
    expect(sixOf26Problems(good)).toEqual([]);
  });
});

describe('no licence for tripcurve itself', () => {
  // Built from pieces so that this file does not match its own scan.
  const SPDX = ['SPDX', 'License', 'Identifier'].join('-');
  const PHRASES = [
    ['Permission is hereby', 'granted'].join(' '),
    ['Apache', 'License,', 'Version'].join(' '),
    ['GNU', 'General', 'Public', 'License'].join(' '),
    ['THE SOFTWARE IS PROVIDED', '"AS IS"'].join(' '),
  ];
  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = dir === '' ? name : `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
      else out.push(rel);
    }
  }
  it('there is no LICENSE, LICENCE or COPYING file at the root', () => {
    const names = readdirSync(ROOT).filter((n) => /^(licen[sc]e|copying|unlicense)/i.test(n));
    expect(names).toEqual([]);
  });
  it('no doc, source file, script or manifest carries licence text or an SPDX header', () => {
    const files: string[] = [...NEW_DOCS, 'package.json', 'action.yml'];
    for (const dir of ['docs', 'src', 'action', 'scripts']) walk(dir, files);
    const hits: string[] = [];
    for (const f of files) {
      if (!/\.(md|ts|json|mjs|sh|yml|txt)$/.test(f)) continue;
      const text = read(f);
      if (text.includes(SPDX)) hits.push(`${f}: SPDX header`);
      for (const p of PHRASES) if (text.includes(p)) hits.push(`${f}: ${p}`);
    }
    expect(hits).toEqual([]);
  });
  it('package.json stays private and UNLICENSED', () => {
    const pkg = JSON.parse(read('package.json')) as { private?: unknown; license?: unknown };
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('UNLICENSED');
  });
  it('can fail: the scan sees a planted SPDX header and a licence phrase', () => {
    const planted = `// ${SPDX}: MIT\n${PHRASES[0]} free of charge`;
    expect(planted.includes(SPDX)).toBe(true);
    expect(PHRASES.some((p) => planted.includes(p))).toBe(true);
  });
});

describe('the "never runs your code, never uses the network" claim of docs/security.md', () => {
  function sources(dir: string, out: string[]): void {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
      else if (rel.endsWith('.ts')) out.push(rel);
    }
  }
  const FORBIDDEN_IMPORT =
    /(from|import\(|require\()\s*['"](node:)?(child_process|net|http|https|http2|dns|tls|dgram|vm|worker_threads|cluster|inspector|repl)['"]/;
  const FORBIDDEN_CALL = /\bfetch\(|\beval\(|new Function\(|XMLHttpRequest|process\.binding/;
  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
  function offenders(text: string): string[] {
    return text
      .split('\n')
      .filter((l) => !isComment(l))
      .filter((l) => FORBIDDEN_IMPORT.test(l) || FORBIDDEN_CALL.test(l));
  }
  it('no file under src/ imports a process or network module or calls fetch or eval', () => {
    const files: string[] = [];
    sources('src', files);
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap((f) => offenders(read(f)).map((l) => `${f}: ${l.trim()}`));
    expect(hits).toEqual([]);
  });
  it('can fail: planted imports and calls are found, comments are not', () => {
    expect(offenders("import { exec } from 'node:child_process';")).toHaveLength(1);
    expect(offenders("const net = require('net');")).toHaveLength(1);
    expect(offenders('await fetch(url);')).toHaveLength(1);
    expect(offenders("  // e.g. require('http').createServer")).toEqual([]);
  });
});

describe('review B15-1: supply chain', () => {
  const security = read('docs/security.md');
  const action = read('docs/action.md');
  it('security.md says the dependencies are fetched by npm ci, with integrity hashes, and what that does not protect against', () => {
    expect(security).toContain('npm ci');
    expect(security).toMatch(/integrity hash/);
    expect(security).toMatch(/already locked/);
    expect(security).not.toMatch(/no registry fetch to hijack/);
  });
  it('action.md does not say nothing comes from a registry', () => {
    expect(action).not.toMatch(/never from a registry at run time/);
    expect(action).toMatch(/pinned dependencies/);
    expect(action).toMatch(/integrity/);
  });
});

describe('review B15-2: Node tolerance counts are computed from the data (m1)', () => {
  const data = JSON.parse(read('src/kb/data/node-idle-close.json')) as {
    entries: { id: string; toleranceMs?: number }[];
  };
  const counts = new Map<number, number>();
  for (const e of data.entries) {
    if (e.toleranceMs !== undefined)
      counts.set(e.toleranceMs, (counts.get(e.toleranceMs) ?? 0) + 1);
  }
  it('the sentence in how-defaults-were-measured.md gives the exact counts, for any set of tolerance values', () => {
    const text = read('docs/how-defaults-were-measured.md');
    const m =
      /the (\d+) Node entries with a script have these tolerances: ((?:\d+(?:\.\d+)? ms \(\d+ entr(?:y|ies)\)(?:, | and )?)+)/.exec(
        text,
      );
    expect(
      m,
      'the sentence "the N Node entries with a script have these tolerances: A ms (n entries) and B ms (k entries)" is missing',
    ).not.toBeNull();
    const total = Number(m?.[1]);
    const stated = new Map<number, number>();
    for (const p of (m?.[2] ?? '').matchAll(/(\d+(?:\.\d+)?) ms \((\d+) entr/g)) {
      stated.set(Number(p[1]), Number(p[2]));
    }
    expect(stated).toEqual(counts);
    expect([...counts.values()].reduce((x, y) => x + y, 0)).toBe(total);
  });

  it('can fail: a sentence with a wrong count or a missing value does not equal the computed counts', () => {
    const wrong = new Map<number, number>([...counts].map(([k, v]) => [k, v + 1]));
    expect(wrong).not.toEqual(counts);
    const missing = new Map([...counts].slice(1));
    expect(missing).not.toEqual(counts);
  });
});

describe('review B16: the entry totals of how-defaults-were-measured.md are computed from the data', () => {
  const dir = join(ROOT, 'src/kb/data');
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap(
      (f) =>
        (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { entries: { basis: string }[] })
          .entries,
    );
  const byBasis = new Map<string, number>();
  for (const e of entries) byBasis.set(e.basis, (byBasis.get(e.basis) ?? 0) + 1);

  it('"Of the N entries" and the table of bases match the data files', () => {
    const text = read('docs/how-defaults-were-measured.md');
    const total = /Of the (\d+) entries in `src\/kb\/data\/`/.exec(text);
    expect(total, 'the sentence "Of the N entries in `src/kb/data/`" is missing').not.toBeNull();
    expect(Number(total?.[1])).toBe(entries.length);
    const rows = new Map<string, number>();
    for (const r of text.matchAll(/^\| `([a-z-]+)` \| (\d+) \|/gm))
      rows.set(r[1] as string, Number(r[2]));
    expect(rows).toEqual(byBasis);
  });
});

describe('review B15-3: attributions and dated absence claims (m2, m6)', () => {
  const readme = read('README.md');
  it('the "shorter than the defaults used by common infrastructure" quote is attributed to PR #59203', () => {
    const line =
      readme
        .split('\n')
        .find((l) => l.includes('shorter than the defaults used by common infrastructure')) ?? '';
    expect(line).toContain('#59203');
    expect(line).toContain('#62782');
  });
  it('the "none has a rule for" claim carries the dates of the searches', () => {
    const line = readme.split('\n').find((l) => l.includes('none has a rule for')) ?? '';
    expect(line).toMatch(/2026-10-29 to 2026-11-02/);
  });
});

describe("review B15-4: the checks fail on the reviewer's cases (m7)", () => {
  it('"6 of 26" in other spellings, across a line break, without its limit', () => {
    for (const bad of [
      '6/26 requests failed.',
      'six of 26 requests failed.',
      'It was 6 of\n26 requests.',
      '6-of-26 failed',
    ]) {
      expect(sixOf26Problems(`## A\n\n${bad}\n`), bad).toHaveLength(1);
    }
  });
  it('"6 of 26" is checked in every doc, old and new', () => {
    const all = [
      'README.md',
      'CHANGELOG.md',
      ...readdirSync(join(ROOT, 'docs'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => `docs/${f}`),
    ];
    // docs/arena-report-extract.md is a verbatim, read-only copy of the source report (its table row
    // carries no limit; the limit is in docs/research.md and in every doc of ours), so it is not edited or checked.
    for (const f of all.filter((x) => x !== 'docs/arena-report-extract.md')) {
      expect(sixOf26Problems(read(f)), f).toEqual([]);
    }
  });
  it('a number must appear with the same unit: 5.0 s changed to 9.0 s is caught', () => {
    const good = 'uvicorn 0.54.0 alone closes at 5.0 s (`docs/research.md` section 2).';
    expect(numberProblems(good)).toEqual([]);
    expect(numberProblems(good.replace('5.0 s', '9.0 s'))).toHaveLength(1);
    // 7.0 s does occur in research.md (Node 18, K = 7000), so it passes there: the check is per cited file
    expect(numberProblems(good.replace('5.0 s', '7.0 s'))).toEqual([]);
    expect(
      numberProblems(
        good.replace('5.0 s', '7.0 s').replace('docs/research.md', 'docs/lookups-b5.txt'),
      ),
    ).toHaveLength(1);
    // the same quantity in the other unit still counts
    expect(numberProblems('It closes at 5000 ms (`docs/research.md` section 2).')).toEqual([]);
    // a bare number elsewhere in the file is not enough: 22 appears in research.md, not as 22 s
    expect(numberProblems('It closes at 22 s (`docs/research.md` section 2).')).toHaveLength(1);
  });
  it('review B25: no page says the Action or the hosted workflows have not run, or that the first run is pending', () => {
    const stale =
      /has never run|have never run|had never run|(?:Action|workflows?|upload) (?:has|have|had) not (?:been )?run|never run on GitHub|not run on GitHub|no hosted (?:CI )?run|no upload before|pending the push|waits for the push|after the push|will be at|not run on a hosted runner|Nothing has run on GitHub/i;
    const hits: string[] = [];
    for (const f of ALL_DOCS) {
      for (const line of read(f).split('\n')) {
        // only the two logs may keep the old wording, as dated history on a line that names B25 and the date
        const history =
          /^(?:CHANGELOG|BUILD-NOTES)\.md$/.test(f) &&
          /B25/.test(line) &&
          line.includes('2026-11-15');
        if (stale.test(line) && !history) {
          hits.push(`${f}: ${line.slice(0, 80)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
  it('review B25: the pages that mention the Action or hosted CI cite the two hosted runs of 2026-11-15', () => {
    for (const f of [
      'README.md',
      'docs/action.md',
      'docs/ci-and-sarif.md',
      'docs/security.md',
      'docs/release-checklist.md',
    ]) {
      const text = read(f);
      expect(text, f).toMatch(/GitHub Action|hosted (CI|workflow)/);
      expect(text, f).toContain('43682221175');
      expect(text, f).toContain('43682221183');
    }
  });
  it('the knowledge-base guide lists the optional entry fields and when each is needed', () => {
    const text = read('docs/add-a-knowledge-base-entry.md');
    for (const field of ['toleranceRelative', 'toleranceMsAt', 'measuredOptions', 'sources']) {
      expect(text, field).toMatch(new RegExp(`\\| \`${field}\` \\|`));
    }
  });
});

describe('review B15-5: secrets wording (m5)', () => {
  it('security.md does not claim tripcurve never reads or prints secrets, and says what is read and shown', () => {
    const t = read('docs/security.md');
    expect(t).not.toMatch(/never reads or prints secrets/);
    expect(t).toMatch(/Secret/);
    expect(t).toMatch(/ConfigMap/);
    expect(t).toMatch(/Terraform literals/);
    expect(t).toMatch(/quoted in the report/);
  });
});

describe('review B15-6: release and hosting sentences are an allow-list', () => {
  const approvedText = readFileSync(
    join(import.meta.dirname, 'approved-release-sentences.txt'),
    'utf8',
  );
  const approved = new Set(approvedText.split('\n').filter((l) => l.trim() !== ''));
  const scanned = [
    'README.md',
    'CHANGELOG.md',
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md') && f !== 'arena-report-extract.md')
      .map((f) => `docs/${f}`),
  ];
  it('every sentence that names a release, hosting or publishing topic is on the approved list', () => {
    const missing = scanned.flatMap((f) =>
      unapprovedSentences(read(f), approved).map((x) => `${f}: ${x}`),
    );
    expect(missing).toEqual([]);
  });
  it('every approved sentence still occurs in a doc (the list does not keep old approvals)', () => {
    const present = new Set(scanned.flatMap((f) => topicSentences(read(f))));
    expect([...approved].filter((x) => !present.has(x))).toEqual([]);
  });
  it("can fail: the reviewer's four claims, a negated claim and an unapproved edit are all refused", () => {
    for (const claim of [
      'The hosted workflow ran green on 2026-11-12.',
      'The Action has run successfully on hosted runners.',
      'tripcurve 0.1.0 is available on npm.',
      'We released 0.1.0 to npm on 2026-11-12.',
      'The workflow ran green, not published.',
    ]) {
      expect(unapprovedSentences(claim, approved), claim).toHaveLength(1);
    }
    const sentence =
      'Nothing is published: there is no remote, no package on a registry and no hosted CI run.';
    expect(unapprovedSentences(sentence, new Set())).toHaveLength(1);
    expect(unapprovedSentences(sentence, new Set([sentence]))).toEqual([]);
    expect(unapprovedSentences('Nothing is published today.', new Set([sentence]))).toHaveLength(1);
  });
  it('a sentence with no topic word needs no approval', () => {
    expect(unapprovedSentences('Idle close is 6 s.', new Set())).toEqual([]);
  });
});

describe('review B22-M1: the command has no subcommand, and no published text shows one', () => {
  const help = runBuilt(['--help']).stdout;
  const options = [...help.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1] as string);
  const PUBLISHED = [
    ...ALL_DOCS.filter((f) => f !== 'docs/arena-report-extract.md'),
    'demo/README.md',
    'measure/README.md',
    'measure/README-lanes.md',
    'test/fixtures/real/README.md',
  ];
  it('--help lists no commands: one usage line with options and a path', () => {
    expect(help).toMatch(/^Usage: tripcurve \[options\] \[path\]$/m);
    expect(help).not.toMatch(/^Commands:/m);
    expect(options).toEqual(
      expect.arrayContaining(['--explain', '--format', '--config', '--version', '--help']),
    );
  });
  for (const f of PUBLISHED) {
    it(f, () => {
      expect(subcommandProblems(read(f), options)).toEqual([]);
    });
  }
  it('can fail: a subcommand in a code span, a heading or a fenced line is reported; options and paths are not', () => {
    expect(subcommandProblems('## What `tripcurve check` never does', options)).toHaveLength(1);
    expect(subcommandProblems('```sh\n$ tripcurve scan .\n```', options)).toHaveLength(1);
    expect(subcommandProblems('Run `npx tripcurve explain T1`.', options)).toHaveLength(1);
    expect(
      subcommandProblems('`tripcurve --explain T1`, `tripcurve .`, `tripcurve`', options),
    ).toEqual([]);
    expect(
      subcommandProblems('`tripcurve needs Node 22.12.0 or later; this is Node 20.`', options),
    ).toEqual([]);
  });
});

describe('review B22-M6: the CHANGELOG has one entry per bolt, B0 to B30, in order', () => {
  const text = read('CHANGELOG.md');
  const ids = [...text.matchAll(/^- \*\*B(\d+)\b/gm)].map((m) => Number(m[1]));
  it('the entries are B0, B1, ... B30 once each, in this order', () => {
    expect(ids).toEqual(Array.from({ length: 31 }, (_, i) => i));
  });
  it('can fail: a missing, repeated or misplaced entry is not the sequence', () => {
    const want = Array.from({ length: 31 }, (_, i) => i);
    expect(want.filter((n) => n !== 18)).not.toEqual(want);
    expect([...want, 21]).not.toEqual(want);
    expect([...want.slice(0, 5), 7, 6, ...want.slice(7)]).not.toEqual(want);
  });
  it('the dated lines that say an audit was clean point to row 5b for the tarball caveat', () => {
    const lines = text
      .split('\n')
      .filter((l) => /npm audit/.test(l) && /clean|0 vulnerabilities/.test(l));
    const old = lines.filter(
      (l) => /^- \*\*B(?:\d|1[0-6])\b/.test(l) || /clean only because/.test(l),
    );
    expect(old.length).toBeGreaterThanOrEqual(2);
    for (const l of old)
      expect(l, l).toContain('(see the release checklist row 5b for the tarball caveat)');
  });
  it('no page writes "npm audit clean" without a qualifier (a checkout, or the tarball caveat)', () => {
    for (const f of ALL_DOCS.filter((x) => x !== 'docs/arena-report-extract.md')) {
      for (const [i, line] of read(f).split('\n').entries()) {
        if (!/npm audit (is )?clean\b/i.test(line)) continue;
        expect(
          /checkout|tarball|row 5b|NOT clean|fresh|every way/i.test(line),
          `${f}:${i + 1}: ${line}`,
        ).toBe(true);
      }
    }
  });
});
