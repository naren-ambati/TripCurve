// A `--config` file outside the checked folder (bolt B17, change 4; the JSON and SARIF contracts name no resolved path, and
// the configuration contract says the person named the file on the command line). It used to be printed resolved to an absolute real path,
// which shows the home directory and makes the output differ between machines. Now it is printed exactly as the
// person typed it, quoted as input text, in the human report, in JSON (`configErrors[].file`, `unchecked[].file`, a
// chain source) and in SARIF (the location of a configuration error and of an unchecked file).
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBuilt } from '../support/e2e.js';
import { fixtureTree } from '../support/fixture-tree.js';
import { validateSarif } from '../support/sarif-validate.js';
import { makeTree } from '../support/tmp-tree.js';

const root = fixtureTree('link/web-demo');
const elsewhere = makeTree();
afterAll(() => {
  root.cleanup();
  elsewhere.cleanup();
});

elsewhere.write(
  'good/c.yaml',
  'version: 1\nworkloads:\n  - name: web\n    runtime:\n      node: "22.23"\n',
);
elsewhere.write('bad/c.yaml', 'version: 1\nworkloads: [unclosed\n');

const rel = (name: string) => relative(root.root, `${elsewhere.root}/${name}`);

describe('a valid --config outside the root, typed relative to the folder it is run in', () => {
  const typed = rel('good/c.yaml');
  const human = runBuilt(['.', '--config', typed, '--verbose'], { cwd: root.root });
  const json = runBuilt(['.', '--config', typed, '--format', 'json'], { cwd: root.root });

  it('the typed path is printed, quoted, and no resolved path is', () => {
    expect(typed.startsWith('..')).toBe(true);
    expect(human.stdout.replace(/\s+/g, ' ')).toContain(`declared "22.23" at "${typed}":5`);
    expect(human.stdout).not.toContain(elsewhere.root);
    expect(human.stdout).not.toContain('/private/');
    expect(human.stderr).toBe('');
  });

  it('JSON gives the typed path in the chain source, and no absolute path anywhere', () => {
    const text = json.stdout;
    expect(text).toContain(JSON.stringify(typed));
    expect(text).not.toContain(elsewhere.root);
    const files = [...text.matchAll(/"file": "([^"]*)"/g)].map((m) => m[1]);
    expect(files).toContain(typed);
  });
});

describe('a --config outside the root that is not valid YAML, typed absolute', () => {
  const typed = `${elsewhere.root}/bad/c.yaml`;
  const out = {
    human: runBuilt(['.', '--config', typed], { cwd: root.root }),
    json: runBuilt(['.', '--config', typed, '--format', 'json'], { cwd: root.root }),
    sarif: runBuilt(['.', '--config', typed, '--format', 'sarif'], { cwd: root.root }),
  };

  it('exits 2 and prints the path as typed in the configuration error and the unchecked file', () => {
    expect(out.human.status).toBe(2);
    // a long quoted name is cut with `...` in the human report (the full path is in JSON and SARIF): the cut path
    // is the typed one, and a resolved path (/private/var on macOS) is not shown
    expect(out.human.stdout).toContain(`Config error in "${typed.slice(0, 24)}`);
    expect(out.human.stdout).not.toContain('/private/');
  });

  it('JSON: configErrors[].file and unchecked[].file are the typed path', () => {
    const json = JSON.parse(out.json.stdout);
    expect(json.configErrors[0].file).toBe(typed);
    expect(json.unchecked.map((u: { file: string }) => u.file)).toEqual([typed]);
  });

  it('SARIF: valid, and each location is a file: URI of the real path with no base (an outside file is not under SRCROOT)', () => {
    const sarif = JSON.parse(out.sarif.stdout);
    expect(validateSarif(sarif)).toEqual([]);
    const places = sarif.runs[0].results.map(
      (r: {
        locations: {
          physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string } };
        }[];
      }) => r.locations[0]?.physicalLocation.artifactLocation,
    );
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) {
      expect(place.uri).toBe(`file://${realpathSync(typed)}`);
      expect(place.uriBaseId).toBeUndefined();
    }
  });
});

describe('a --config outside the root that is not valid YAML, typed relative', () => {
  const typed = rel('bad/c.yaml');
  const json = JSON.parse(
    runBuilt(['.', '--config', typed, '--format', 'json'], { cwd: root.root }).stdout,
  );
  const sarif = JSON.parse(
    runBuilt(['.', '--config', typed, '--format', 'sarif'], { cwd: root.root }).stdout,
  );

  it('JSON shows the typed relative path, not a resolved one', () => {
    expect(json.configErrors[0].file).toBe(typed);
    expect(json.unchecked[0].file).toBe(typed);
  });

  it('SARIF locates it by a file: URI of the real path with no base, never a path under SRCROOT (review info)', () => {
    const places = sarif.runs[0].results.map(
      (r: {
        locations: {
          physicalLocation: { artifactLocation: { uri: string; uriBaseId?: string } };
        }[];
      }) => r.locations[0]?.physicalLocation.artifactLocation,
    );
    expect(places.length).toBeGreaterThan(0);
    for (const place of places) {
      expect(place.uri).toBe(`file://${realpathSync(`${elsewhere.root}/bad/c.yaml`)}`);
      expect(place.uriBaseId).toBeUndefined();
    }
  });

  it('the same when the command runs in another folder than the checked root: the typed path is relative to the cwd', () => {
    const other = makeTree();
    try {
      const typed2 = relative(other.root, `${elsewhere.root}/bad/c.yaml`);
      const out = runBuilt(['--config', typed2, '--format', 'sarif', root.root], {
        cwd: other.root,
      });
      const log = JSON.parse(out.stdout);
      const art = log.runs[0].results[0].locations[0].physicalLocation.artifactLocation;
      expect(art.uri).toBe(`file://${realpathSync(`${elsewhere.root}/bad/c.yaml`)}`);
      expect(art.uriBaseId).toBeUndefined();
      const human = runBuilt(['--config', typed2, root.root], { cwd: other.root });
      expect(human.stdout).toContain(`Config error in "${typed2}"`);
      expect(human.stdout).not.toContain(realpathSync(elsewhere.root));
    } finally {
      other.cleanup();
    }
  });
});

describe('a --config inside the root is still shown relative to the root', () => {
  it('whatever way it is typed', () => {
    root.write(
      'cfg/in.yaml',
      'version: 1\nworkloads:\n  - name: web\n    runtime:\n      node: "22.23"\n',
    );
    for (const typed of ['cfg/in.yaml', `${root.root}/cfg/in.yaml`, './cfg/in.yaml']) {
      const out = runBuilt(['.', '--config', typed, '--verbose'], { cwd: root.root });
      expect(out.stdout, typed).toContain('declared "22.23" at "cfg/in.yaml":5');
    }
  });
});
