// Bolt B20: the package metadata that points at the public repository, and the two fields that stay
// as they are until the maintainer decides the licence and the release.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../support/docs-check.js';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;

describe('package.json metadata (B20)', () => {
  it('points at the public repository', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/naren-ambati/TripCurve.git',
    });
    expect(pkg.homepage).toBe('https://github.com/naren-ambati/TripCurve#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/naren-ambati/TripCurve/issues' });
    expect(pkg.author).toBe('naren-ambati');
  });

  it('has exactly the keywords that describe what the tool checks', () => {
    expect(pkg.keywords).toEqual([
      'timeouts',
      'keep-alive',
      'load balancer',
      'kubernetes',
      'terraform',
      'sarif',
      'sqs',
      'lambda',
    ]);
  });

  it('stays private and UNLICENSED until the maintainer decides the licence', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('UNLICENSED');
  });
});
