// Hostile input to the Python readers: none may crash, freeze or grow faster than the input.
// The two "very large inputs" cases reproduce defects found in this bolt's own code (a huge array
// spread into Math.max and into push overflowed the stack); they failed before the fix. The scaling
// cases are guards: they pass today, and fail if a regex or a loop here turns quadratic.
import { afterEach, describe, expect, it } from 'vitest';
import { fileSource, inputText } from '../../src/core/index.js';
import { intakeStreamBytes } from '../../src/parse/intake/index.js';
import {
  newGunicornAcc,
  readGunicornFlags,
  readUvicornFlags,
  type Word,
} from '../../src/parse/python/flags.js';
import {
  readDockerfileEnv,
  readGunicornConfig,
  readPythonCommand,
} from '../../src/parse/python/index.js';
import { resolveSettingPrecedence } from '../../src/resolve/gunicorn-precedence.js';
import { cleanupPythonTrees, containerFrom, fakeFile } from '../support/python.js';
import { LINEAR_RATIO_LIMIT, SCALING_TEST_TIMEOUT_MS, scalingRatio } from '../support/scaling.js';

afterEach(cleanupPythonTrees);

const SRC = fileSource(inputText('x'), 1);
const words = (texts: string[]): Word[] => texts.map((text) => ({ text, source: SRC }));

describe('work grows linearly with the input', () => {
  it(
    'a word of dashes that ends in $( (a regex that backtracked between two dash classes)',
    () => {
      const ratio = scalingRatio((n) => {
        const acc = newGunicornAcc();
        readGunicornFlags(words([`${'-'.repeat(n)}!$(`]), 'command', acc);
        readUvicornFlags(words([`${'-'.repeat(n)}!$(`]), 'command');
      }, 20000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a Helm comment line with a huge run of spaces (a lazy match that re-scanned the run)',
    () => {
      const ratio = scalingRatio((n) => {
        const text = `---\n# Source: ${' '.repeat(n)}x\napiVersion: v1\nkind: Pod\nmetadata:\n  name: a\n`;
        intakeStreamBytes(new TextEncoder().encode(text));
      }, 20000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a Dockerfile ENV with very many pairs on one line (a slice of the rest for every pair)',
    () => {
      const ratio = scalingRatio((n) => {
        readDockerfileEnv(fakeFile(`FROM x\nENV ${'A=1 '.repeat(n)}\n`, 'dockerfile'), [
          'GUNICORN_CMD_ARGS',
        ]);
      }, 5000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a Dockerfile with a very long continuation',
    () => {
      const ratio = scalingRatio((n) => {
        readDockerfileEnv(
          fakeFile(`FROM x\nENV A=1 \\\n${'  B=2 \\\n'.repeat(n)}  C=3\n`, 'dockerfile'),
          ['GUNICORN_CMD_ARGS'],
        );
      }, 5000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a gunicorn.conf.py of many lines and one of near-numbers',
    () => {
      expect(
        scalingRatio((n) => {
          readGunicornConfig(fakeFile('x_setting = 1\n'.repeat(n), 'gunicorn-conf'));
        }, 5000),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
      expect(
        scalingRatio((n) => {
          readGunicornConfig(fakeFile(`workers = ${'1_'.repeat(n)}x\n`, 'gunicorn-conf'));
        }, 5000),
      ).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );

  it(
    'a command of very many flags',
    () => {
      const ratio = scalingRatio((n) => {
        const acc = newGunicornAcc();
        readGunicornFlags(words(Array.from({ length: n }, () => '--keep')), 'command', acc);
      }, 5000);
      expect(ratio).toBeLessThan(LINEAR_RATIO_LIMIT);
    },
    SCALING_TEST_TIMEOUT_MS,
  );
});

describe('very large inputs do not crash', () => {
  it('300,000 contributions to one setting resolve (a spread of that array into Math.max threw)', () => {
    const acc = newGunicornAcc();
    readGunicornFlags(
      words(Array.from({ length: 300_000 }, () => '--keep-alive=3')),
      'command',
      acc,
    );
    expect(acc.settings.keepalive).toHaveLength(300_000);
    expect(() =>
      resolveSettingPrecedence('gunicorn', 'keepalive', acc.settings.keepalive),
    ).not.toThrow();
    expect(() =>
      resolveSettingPrecedence('gunicorn', 'threads', acc.settings.keepalive),
    ).not.toThrow();
  });

  it('a GUNICORN_CMD_ARGS value of 200,000 flags is read (pushing that many values in one call threw)', () => {
    const value = '--keep-alive 3 '.repeat(200_000);
    const reading = readPythonCommand(
      containerFrom(
        `          command: ["gunicorn"]\n          env:\n            - name: GUNICORN_CMD_ARGS\n              value: "${value}"`,
      ),
    );
    expect(reading?.program).toBe('gunicorn');
    if (reading?.program === 'gunicorn') expect(reading.settings.keepalive.length).toBe(200_000);
  });

  it('a config file of one enormous line and a Dockerfile of one enormous value', () => {
    expect(
      readGunicornConfig(fakeFile(`workers = "${'a'.repeat(3_000_000)}"\n`, 'gunicorn-conf'))
        .settings.workers,
    ).toBeDefined();
    expect(
      readDockerfileEnv(
        fakeFile(`FROM x\nENV GUNICORN_CMD_ARGS="${'a'.repeat(3_000_000)}"\n`, 'dockerfile'),
        ['GUNICORN_CMD_ARGS'],
      ).GUNICORN_CMD_ARGS?.text?.length,
    ).toBe(3_000_000);
  });
});
