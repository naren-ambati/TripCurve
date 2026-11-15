// Shared by the scan test. The scan looks for the one name that unwraps an
// InputText (see src/core/safe-text.ts) in source text.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const PRINTING_PREFIXES = ['src/report/', 'src/cli/'];
export const FORBIDDEN_NAMES = ['unwrapForIo'];
/**
 * What a printing component (report, cli) may not touch at all: the unwrap, and the
 * two parser-side accessors that hand back the raw string of an InputText.
 */
export const PRINTING_FORBIDDEN_NAMES = [
  'unwrapForIo',
  'rawTextForParser',
  'rawInputTextForParser',
];

export function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

export function relativeSlash(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

export function findRawReaders(
  files: ReadonlyArray<{ path: string; text: string }>,
  allowed: ReadonlyArray<{ prefix: string }>,
): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    const isPrinting = PRINTING_PREFIXES.some((p) => path.startsWith(p));
    const names = isPrinting ? PRINTING_FORBIDDEN_NAMES : FORBIDDEN_NAMES;
    if (!names.some((name) => text.includes(name))) continue;
    const isAllowed = allowed.some((a) => path.startsWith(a.prefix));
    if (isPrinting || !isAllowed) offenders.push(path);
  }
  return offenders;
}
