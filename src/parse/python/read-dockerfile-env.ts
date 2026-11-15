// The `ENV` instructions of a LINKED Dockerfile that matter to gunicorn and uvicorn
// (a Dockerfile ENV is read only when `tripcurve.yaml` links the Dockerfile
// to the workload). Pure text reading; nothing is run.
//
// Read: the ENV instructions of the last build stage and of the earlier stages of the same
// file it builds on (`FROM earlier AS later`), later instructions overriding earlier ones. A
// base image that is not a stage of the file may carry ENV that is not seen (the image is not
// read). A value is text only when it has no variable reference (`$`), no backslash and no
// backtick; anything else is a value tripcurve does not read (`text` undefined). A parser
// directive `# escape=` changes how the file is read, so every wanted name is then not read.

import { fileSource, type SourceRef } from '../../core/index.js';
import { type InputFile, rawTextForParser } from '../intake/index.js';
import type { DockerEnv, DockerEnvEntry } from './model.js';

interface Stage {
  readonly alias: string | undefined;
  readonly parent: number | undefined;
  readonly env: Map<string, DockerEnvEntry>;
}

/** Splits the pairs of an ENV instruction; undefined text marks a value that is not literal. */
function parseEnvArguments(args: string): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [];
  const literalOnly = (value: string): string | undefined =>
    /[$\\`]/.test(value) ? undefined : value;
  const first = /^([^\s=]+)=/.exec(args);
  if (first === null) {
    // `ENV key value with spaces`: the value is the rest of the line.
    const m = /^(\S+)[ \t]+([\s\S]*)$/.exec(args);
    if (m === null) return out;
    const value = (m[2] as string).trim();
    out.push([m[1] as string, /["']/.test(value) ? undefined : literalOnly(value)]);
    return out;
  }
  let i = 0;
  while (i < args.length) {
    while (i < args.length && /\s/.test(args[i] as string)) i += 1;
    if (i >= args.length) break;
    const eq = args.indexOf('=', i);
    const space = args.slice(i).search(/\s/);
    if (eq < 0 || (space >= 0 && i + space < eq)) break;
    const name = args.slice(i, eq);
    i = eq + 1;
    let value = '';
    let broken = false;
    while (i < args.length && !/\s/.test(args[i] as string)) {
      const ch = args[i] as string;
      if (ch === '"' || ch === "'") {
        const end = args.indexOf(ch, i + 1);
        if (end < 0) {
          broken = true;
          break;
        }
        value += args.slice(i + 1, end);
        i = end + 1;
      } else {
        value += ch;
        i += 1;
      }
    }
    out.push([name, broken ? undefined : literalOnly(value)]);
    if (broken) break;
  }
  return out;
}

export function readDockerfileEnv(file: InputFile, wanted: readonly string[]): DockerEnv {
  const text = rawTextForParser(file);
  const unreadable = (): DockerEnv =>
    Object.fromEntries(
      wanted.map((name): [string, DockerEnvEntry] => [
        name,
        { text: undefined, source: fileSource(file.canonicalPath, 1) },
      ]),
    );
  const lines = text.split(/\r\n|\r|\n/);

  // logical instructions: comment lines are dropped, a trailing backslash continues the line
  const instructions: Array<{ line: number; text: string }> = [];
  let pending: { line: number; text: string } | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmedStart = raw.trimStart();
    if (/^#\s*escape\s*=/i.test(trimmedStart)) return unreadable();
    if (trimmedStart.startsWith('#')) continue;
    if (pending === undefined && trimmedStart.trim() === '') continue;
    const body = raw.trimEnd();
    const continues = body.endsWith('\\');
    const piece = continues ? body.slice(0, -1) : body;
    pending =
      pending === undefined
        ? { line, text: piece.trimStart() }
        : { line: pending.line, text: `${pending.text} ${piece.trim()}` };
    if (!continues) {
      instructions.push(pending);
      pending = undefined;
    }
  }
  if (pending !== undefined) instructions.push(pending);

  const stages: Stage[] = [];
  for (const { line, text: logical } of instructions) {
    const space = logical.search(/\s/);
    const keyword = (space < 0 ? logical : logical.slice(0, space)).toUpperCase();
    const args = space < 0 ? '' : logical.slice(space).trim();
    if (keyword === 'FROM') {
      const words = args.split(/\s+/).filter((w) => !w.startsWith('--'));
      const image = words[0];
      const asAt = words.findIndex((w) => w.toUpperCase() === 'AS');
      const alias = asAt >= 0 ? words[asAt + 1]?.toLowerCase() : undefined;
      const parent =
        image === undefined
          ? undefined
          : stages.findIndex((s) => s.alias !== undefined && s.alias === image.toLowerCase());
      stages.push({
        alias,
        parent: parent === undefined || parent < 0 ? undefined : parent,
        env: new Map(),
      });
    } else if (keyword === 'ENV') {
      const stage = stages[stages.length - 1];
      if (stage === undefined) continue; // an ENV before any FROM is not valid
      const source: SourceRef = fileSource(file.canonicalPath, line);
      for (const [name, value] of parseEnvArguments(args)) {
        stage.env.set(name, { text: value, source });
      }
    }
  }
  const last = stages.length - 1;
  const chain: Stage[] = [];
  let index: number | undefined = last;
  while (index !== undefined && index >= 0) {
    const stage: Stage | undefined = stages[index];
    if (stage === undefined || chain.includes(stage)) break;
    chain.unshift(stage);
    index = stage.parent;
  }
  const result: Record<string, DockerEnvEntry> = {};
  for (const name of wanted) {
    for (const stage of chain) {
      const entry = stage.env.get(name);
      if (entry !== undefined) result[name] = entry;
    }
  }
  return result;
}
