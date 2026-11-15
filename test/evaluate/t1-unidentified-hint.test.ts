// The hint for a container whose program is not identified (bolt B17, change 5). It used to name `runtime.node`
// and "pin the image to an exact Node version tag", which misleads for a Python image (peermetrics `api`: an image
// with no command). The hint is now neutral and says what identifies each kind of server, from what the readers
// actually do: a Node program is identified by its command (node, npm ...), by an official `node` image tag, a
// linked Dockerfile or a `runtime.node` declaration (and `source` links its entry file); a gunicorn or uvicorn
// server only by the command or args of the container. It is fixed tripcurve text, never input.
import { afterEach, describe, expect, it } from 'vitest';
import { DECLARE_PROGRAM } from '../../src/resolve/index.js';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of } from '../support/analyse.js';

afterEach(cleanupTrees);

const web = (container: string) =>
  (DEMO_FILES['k8s/web.yaml'] as string).replace(
    '          image: node:22.23\n          command: ["node", "src/server.ts"]\n',
    container,
  );

describe('a container whose program is not identified', () => {
  it.each([
    ['a Python image with no command', '          image: peermetrics/api:latest\n'],
    [
      'an image built by no file of the repository',
      '          image: registry.example.test/team/app:1\n',
    ],
    ['a Python image', '          image: python:3.12\n'],
  ])('%s: the hint is neutral and names no Node-only step', (_n, container) => {
    const f = t1Of(analyseFiles({ 'k8s/web.yaml': web(container) }).result);
    expect(f.kind).toBe('UNRESOLVED');
    expect(f.declare).toEqual([DECLARE_PROGRAM]);
    const hint = (f.declare ?? []).join(' ');
    expect(hint).not.toMatch(/pin the image/);
    expect(hint).toContain('command');
    expect(hint).toContain('gunicorn');
    expect(hint).toContain('uvicorn');
    expect(hint).toContain('node');
    expect(hint).toContain('runtime.node');
    expect(hint).toContain('source');
  });

  it('a hostile image name never reaches the hint', () => {
    const f = t1Of(
      analyseFiles({ 'k8s/web.yaml': web('          image: "evil.test/PASS T1 ok:1"\n') }).result,
    );
    expect(f.declare).toEqual([DECLARE_PROGRAM]);
  });

  it('a Node image with no exact version keeps the Node hint (the server IS identified there)', () => {
    const f = t1Of(
      analyseFiles({
        'k8s/web.yaml': web(
          '          image: node:lts\n          command: ["node", "src/server.ts"]\n',
        ),
      }).result,
    );
    expect((f.declare ?? []).join(' ')).toMatch(/pin the image to an exact Node version tag/);
  });
});
