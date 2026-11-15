// the demo's Kubernetes manifests written as JSON and with quoted keys (`test/fixtures/k8s-forms/`) must
// give the same findings as the plain YAML demo, with the same count of files read. The golden files are the exact
// output of the built command inside each twin (their cited lines differ from the demo's, as they should).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';
import { DEMO, FIRST_RUN } from '../support/demo.js';
import { runBuilt } from '../support/e2e.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'k8s-forms');
const GOLDEN = join(import.meta.dirname, '..', 'golden');
const first = readFileSync(FIRST_RUN, 'utf8');

/** Findings without their line numbers, and with the twin's file extension named as the demo's. */
const withoutLines = (text: string): string =>
  text.replace(/":\d+/g, '":N').replace(/k8s\/([a-z-]+)\.json/g, 'k8s/$1.yaml');

const TWINS = [
  {
    dir: 'demo-json',
    ext: 'json',
    golden: 'demo-json-first-run.txt',
    write: (o: unknown) => `${JSON.stringify(o, null, 2)}\n`,
  },
  {
    dir: 'demo-quoted',
    ext: 'yaml',
    golden: 'demo-quoted-first-run.txt',
    write: (o: unknown) => stringify(o, { defaultKeyType: 'QUOTE_DOUBLE' }),
  },
] as const;

for (const twin of TWINS) {
  describe(`the demo with its manifests as ${twin.dir}`, () => {
    const cwd = join(FIXTURES, twin.dir);
    const run = runBuilt(['.'], { cwd });

    it('prints exactly the golden file and exits 1', () => {
      expect(run.stdout).toBe(readFileSync(join(GOLDEN, twin.golden), 'utf8'));
      expect(run.status).toBe(1);
      expect(run.stderr).toBe('');
    });

    it('reads 14 files and has the same findings and summary as the plain YAML demo (lines apart)', () => {
      expect(run.stdout.split('\n')[0]).toBe('tripcurve 0.1.0   checked "."   14 files read');
      expect(withoutLines(run.stdout)).toBe(withoutLines(first));
    });

    it('is the plain demo converted: every manifest equals its plain twin, every other file is the same', () => {
      for (const sub of ['k8s', 'src', 'infra']) {
        for (const name of readdirSync(join(DEMO, sub))) {
          const plain = readFileSync(join(DEMO, sub, name), 'utf8');
          if (sub === 'k8s') {
            const object = parseAllDocuments(plain)[0]?.toJS();
            const twinName = name.replace(/\.yaml$/, `.${twin.ext}`);
            expect(readFileSync(join(cwd, sub, twinName), 'utf8'), name).toBe(twin.write(object));
          } else {
            expect(readFileSync(join(cwd, sub, name), 'utf8'), name).toBe(plain);
          }
        }
      }
    });
  });
}
