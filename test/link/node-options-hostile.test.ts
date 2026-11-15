// Regression (found while hardening bolt B2, in B1 code): a NODE_OPTIONS value of very many
// preload options pushed all of them in one call, overflowed the stack and ended the run with
// "internal error" (exit 3). It must give a result (the search is incomplete or the files are read).
import { afterEach, describe, expect, it } from 'vitest';
import { analyseFiles, cleanupTrees, DEMO_FILES, t1Of } from '../support/analyse.js';

afterEach(cleanupTrees);

describe('NODE_OPTIONS with very many options', () => {
  it('does not crash the run', () => {
    const web = `${DEMO_FILES['k8s/web.yaml'] as string}          env:\n            - name: NODE_OPTIONS\n              value: "${'--require ./x.js '.repeat(200_000)}"\n`;
    const { result } = analyseFiles({ 'k8s/web.yaml': web });
    expect(t1Of(result).kind).not.toBe('PASS');
  });
});
