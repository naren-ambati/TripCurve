// Checks on the documentation. Each function takes text and returns the
// problems it found, so test/docs/docs.test.ts can also show that every check FAILS on a planted
// bad document (a check that cannot fail proves nothing).
//
// What these checks establish, and what they do not:
//   - mermaid: every Mermaid block is followed by a "Text fallback:" paragraph.
//   - quotes: a quoted vendor text (a block quote with a "Source:" line) appears, word for word
//     (whitespace aside; "..." marks a cut), in the file the Source line cites, and carries a date.
//   - verbatim blocks: every line of a fenced block that follows "Verbatim from `path`" is a line of that file.
//   - numbers: every number written with a unit (s or ms) in a paragraph, list item or table row
//     appears in a file that same paragraph, item or row cites (as the number, or the same quantity
//     in the other unit). That a number APPEARS in the cited file does not prove the sentence is
//     true: it only catches a number that no cited file contains. A reader still has to read it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

/** Repository folders whose paths, when cited in backticks, must exist (a typo is a failure). */
const CHECKED_ROOTS = [
  'docs/',
  'src/',
  'test/',
  'measure/',
  'demo/',
  'demo-fixed/',
  'action/',
  'scripts/',
  '.github/',
];

/** Paths that look like repository paths but are not files of this repository. */
export const NOT_IN_THIS_CHECKOUT: ReadonlySet<string> = new Set([
  // inside the installed lightship package under .cache/, not in this repository
  'src/factories/createLightship.ts',
]);

export interface Block {
  readonly kind: 'fence' | 'quote' | 'text';
  readonly lang: string;
  readonly lines: readonly string[];
  /** 1-based line of the first line of the block (of the opening fence for a fence). */
  readonly start: number;
}

/** Splits a Markdown text into fenced blocks, block quotes and ordinary text lines. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^(\s*)```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      const start = i + 1;
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // the closing fence
      out.push({ kind: 'fence', lang: fence[2] ?? '', lines: body, start });
      continue;
    }
    if (/^>/.test(line)) {
      const body: string[] = [];
      const start = i + 1;
      while (i < lines.length && /^>/.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      out.push({ kind: 'quote', lang: '', lines: body, start });
      continue;
    }
    const body: string[] = [];
    const start = i + 1;
    while (i < lines.length && !/^\s*```/.test(lines[i] ?? '') && !/^>/.test(lines[i] ?? '')) {
      body.push(lines[i] ?? '');
      i += 1;
    }
    out.push({ kind: 'text', lang: '', lines: body, start });
  }
  return out;
}

export function mermaidProblems(text: string): string[] {
  const problems: string[] = [];
  const all = blocks(text);
  all.forEach((b, index) => {
    if (b.kind !== 'fence' || b.lang !== 'mermaid') return;
    const next = all[index + 1];
    const firstLine = (next?.lines ?? []).find((l) => l.trim() !== '');
    if (
      next?.kind !== 'text' ||
      firstLine === undefined ||
      !firstLine.startsWith('Text fallback:')
    ) {
      problems.push(
        `line ${b.start}: a Mermaid block is not followed by a "Text fallback:" paragraph`,
      );
    }
  });
  return problems;
}

/** Backticked repository paths in a text, in order, skipping placeholders. */
export function citedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = (m[1] ?? '').trim();
    if (/[<>*{}$\s]/.test(token)) continue;
    if (!/\.(md|ts|json|mjs|txt|yml|yaml|sh|tf|js)$/.test(token)) continue;
    const slash = token.includes('/');
    if (slash && !CHECKED_ROOTS.some((r) => token.startsWith(r))) continue;
    paths.push(token);
  }
  return paths;
}

const fileText = (path: string): string | undefined => {
  const full = join(ROOT, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
};

/** Whitespace collapsed, and a digit group's thousands commas removed. */
const normal = (text: string): string =>
  text
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

export function brokenCitations(text: string, where: string): string[] {
  const problems: string[] = [];
  for (const p of citedPaths(text)) {
    if (!p.includes('/') && fileText(p) === undefined) continue; // a bare name such as gunicorn.conf.py
    if (NOT_IN_THIS_CHECKOUT.has(p)) continue;
    if (fileText(p) === undefined) problems.push(`${where}: cited file does not exist: ${p}`);
  }
  return problems;
}

const DATE = /\d{4}-\d{2}-\d{2}/;

export function quoteProblems(text: string): string[] {
  const problems: string[] = [];
  for (const b of blocks(text)) {
    if (b.kind !== 'quote') continue;
    const stripped = b.lines.map((l) => l.replace(/^>\s?/, ''));
    const at = stripped.findIndex((l) => l.startsWith('Source:'));
    if (at < 0) {
      problems.push(`line ${b.start}: a block quote has no "Source:" line`);
      continue;
    }
    const sourceLine = stripped.slice(at).join(' ');
    if (!DATE.test(sourceLine)) problems.push(`line ${b.start}: the Source line carries no date`);
    const files = citedPaths(sourceLine).filter((p) => !NOT_IN_THIS_CHECKOUT.has(p));
    const texts = files.map(fileText).filter((t): t is string => t !== undefined);
    if (texts.length === 0) {
      problems.push(`line ${b.start}: the Source line cites no file that exists`);
      continue;
    }
    const haystacks = texts.map(normal);
    let quote = normal(stripped.slice(0, at).join(' '));
    quote = quote.replace(/^"/, '').replace(/"$/, '');
    for (const segment of quote.split('...').map((s) => s.trim())) {
      if (segment === '') continue;
      if (!haystacks.some((h) => h.includes(segment))) {
        problems.push(
          `line ${b.start}: quoted text not found in the cited file: "${segment.slice(0, 70)}"`,
        );
      }
    }
  }
  return problems;
}

export function verbatimProblems(text: string): string[] {
  const problems: string[] = [];
  const all = blocks(text);
  all.forEach((b, index) => {
    if (b.kind !== 'fence') return;
    const before = all[index - 1];
    const marker = [...(before?.lines ?? [])].reverse().find((l) => l.trim() !== '');
    const m = marker === undefined ? null : /^Verbatim from `([^`]+)`/.exec(marker);
    if (!m?.[1]) return;
    const content = fileText(m[1]);
    if (content === undefined) {
      problems.push(`line ${b.start}: verbatim source does not exist: ${m[1]}`);
      return;
    }
    const have = new Set(content.split('\n').map((l) => l.trimEnd()));
    for (const line of b.lines) {
      if (line.trim() === '') continue;
      if (!have.has(line.trimEnd())) {
        problems.push(`line ${b.start}: not a line of ${m[1]}: ${line.slice(0, 70)}`);
      }
    }
  });
  return problems;
}

/** The facts of a text: paragraphs, list items and table rows, outside fenced blocks and quotes. */
export function units(text: string): { start: number; text: string }[] {
  const out: { start: number; text: string }[] = [];
  for (const b of blocks(text)) {
    if (b.kind === 'fence') continue;
    let current: { start: number; text: string } | undefined;
    b.lines.forEach((line, k) => {
      const lineNo = b.start + k;
      const startsUnit = b.kind === 'quote' ? k === 0 : /^\s*([-*]|\d+\.)\s|^\s*\||^#/.test(line);
      if (line.trim() === '') {
        current = undefined;
        return;
      }
      if (current === undefined || startsUnit) {
        current = { start: lineNo, text: line };
        out.push(current);
      } else {
        current.text += ` ${line}`;
      }
    });
  }
  return out;
}

const NUMBER_WITH_UNIT = /(?<![\w.-])(\d[\d,]*(?:\.\d+)?)\s?(ms|s)\b/g;

/**
 * The quantity `value unit` appears in the text with that unit: as `5.0 s`, `5 s`, `5 seconds`, or in the
 * data files' own forms (`"value": 60, "unit": "s"`, `"toleranceMs": 5`). A bare number elsewhere in
 * the file does not count.
 */
function quantityAppears(value: number, unit: string, text: string): boolean {
  const n = String(value).replace('.', '\\.');
  const num = `(?<![\\d.])${n}(?:\\.0+)?`;
  const words = unit === 'ms' ? '(?:ms|milliseconds?)' : '(?:s|seconds?)';
  if (new RegExp(`${num}\\s?${words}\\b`).test(text)) return true;
  if (new RegExp(`"value": ${num},\\s*"unit": "${unit}"`).test(text)) return true;
  return unit === 'ms' && new RegExp(`(?:"[A-Za-z]*Ms": |\`toleranceMs\`? ?)${num}\\b`).test(text);
}

/** Every number with a unit, in the unit's own file citations; a unit with none cites nothing and fails. */
export function numberProblems(text: string): string[] {
  const problems: string[] = [];
  for (const u of units(text)) {
    const found = [...u.text.matchAll(NUMBER_WITH_UNIT)];
    if (found.length === 0) continue;
    const files = citedPaths(u.text);
    const texts = files
      .filter((p) => !NOT_IN_THIS_CHECKOUT.has(p))
      .map(fileText)
      .filter((t): t is string => t !== undefined)
      .map(normal);
    if (texts.length === 0) {
      problems.push(
        `line ${u.start}: a number with a unit but no cited file: ${u.text.slice(0, 80)}`,
      );
      continue;
    }
    for (const m of found) {
      const value = Number((m[1] ?? '').replace(/,/g, ''));
      const unit = m[2];
      const other = unit === 's' ? value * 1000 : value / 1000;
      const otherUnit = unit === 's' ? 'ms' : 's';
      const ok = texts.some(
        (t) => quantityAppears(value, unit ?? 's', t) || quantityAppears(other, otherUnit, t),
      );
      if (!ok)
        problems.push(`line ${u.start}: "${m[0]}" is in no cited file (${files.join(', ')})`);
    }
  }
  return problems;
}

export interface Section {
  readonly heading: string;
  readonly level: number;
  /** 0-based first line (the heading) and one past the last line. */
  readonly from: number;
  readonly to: number;
  readonly body: string;
}

/** Sections of a Markdown text: from a heading up to the next heading of the same or a higher level. */
export function sections(text: string): Section[] {
  const lines = text.split('\n');
  let fenced = false;
  const heads: { at: number; level: number; heading: string }[] = [];
  lines.forEach((line, k) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) heads.push({ at: k, level: (m[1] ?? '').length, heading: m[2] ?? '' });
  });
  return heads.map((h, idx) => {
    const next = heads.slice(idx + 1).find((n) => n.level <= h.level);
    const to = next?.at ?? lines.length;
    return {
      heading: h.heading,
      level: h.level,
      from: h.at,
      to,
      body: lines.slice(h.at, to).join('\n'),
    };
  });
}

const SIX_OF_26 = /\b(?:6|six)(?:\s+of\s+|\s*\/\s*|-of-)26\b/gi;

/** Wherever the 6-of-26 result is written (in any of its spellings, even across a line break), its limit is written in the same section. */
export function sixOf26Problems(text: string): string[] {
  const problems: string[] = [];
  const all = sections(text);
  for (const m of text.matchAll(SIX_OF_26)) {
    const k = text.slice(0, m.index).split('\n').length - 1;
    const smallest = all
      .filter((s) => s.from <= k && k < s.to)
      .sort((x, y) => x.to - x.from - (y.to - y.from))[0];
    const scope = smallest?.body ?? text;
    if (!/toxiproxy/.test(scope) || !/not an ALB/.test(scope)) {
      problems.push(
        `line ${k + 1}: the 6-of-26 result without its limit (toxiproxy, not an ALB) in the same section`,
      );
    }
  }
  return problems;
}

/**
 * Words that put a sentence in the release-and-hosting topic. A claim of absence ("nothing is
 * published", "no hosted run") cannot be checked by looking for bad phrasings, so every sentence
 * with one of these words must be on a list a person has read (test/docs/approved-release-sentences.txt).
 */
export const TOPIC_WORDS =
  /\b(hosted|runners?|workflows?|CI|GitHub|Action|npm|registry|publish(?:ed|es|ing)?|releas(?:e|ed|es|ing)|available|install(?:s|ed|ing|ation)?|badges?|upload(?:s|ed|ing)?|Marketplace)\b/i;

/** The sentences of a Markdown text, outside fenced blocks, normalised: one line each, list and table marks removed. */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trim() === '') continue;
    const body = line.trim().replace(/^([-*]|\d+\.|\|)\s*/, '');
    for (const part of body.split(/(?<=[.!?;])\s+/)) {
      const one = part.replace(/\s+/g, ' ').trim();
      if (one !== '') out.push(one);
    }
  }
  return out;
}

export function topicSentences(text: string): string[] {
  return sentences(text).filter((x) => TOPIC_WORDS.test(x));
}

/** Topic sentences that are not on the approved list. */
export function unapprovedSentences(text: string, approved: ReadonlySet<string>): string[] {
  return topicSentences(text).filter((x) => !approved.has(x));
}

export function linkProblems(text: string, fromDir: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = (m[1] ?? '').split('#')[0] ?? '';
    if (target === '' || /^[a-z]+:/i.test(target)) continue;
    const full = join(ROOT, fromDir, target);
    if (!existsSync(full)) problems.push(`broken link: ${m[1]}`);
  }
  return problems;
}

/**
 * Invocations of the command shown in a text: every inline code span and every line of a fenced block whose words
 * start with `tripcurve` (after an optional `$ ` or `npx `), and are at most four words long. A longer span that
 * starts with the name is a message the tool prints (`tripcurve needs Node 22.12.0 ...`), not a command line.
 * Returns the word after `tripcurve`, or undefined when there is none.
 */
export function invocationWords(text: string): Array<{ span: string; word: string | undefined }> {
  const spans: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) spans.push(line.trim());
    else for (const m of line.matchAll(/`([^`]+)`/g)) spans.push((m[1] ?? '').trim());
  }
  const out: Array<{ span: string; word: string | undefined }> = [];
  for (const span of spans) {
    const words = span.replace(/^(\$\s+)?(npx\s+)?/, '').split(/\s+/);
    if (words[0] !== 'tripcurve' || words.length > 4) continue;
    out.push({ span, word: words[1] });
  }
  return out;
}

/**
 * Invocations that name a subcommand: the word after `tripcurve` is a bare lowercase word and not one of the options
 * the `--help` text lists. The command has none, so such a text would send a reader to a path that does not exist.
 */
export function subcommandProblems(text: string, options: readonly string[]): string[] {
  return invocationWords(text)
    .filter(
      (i) => i.word !== undefined && /^[a-z][a-z-]*$/.test(i.word) && !options.includes(i.word),
    )
    .map((i) => `\`${i.span}\` names a subcommand (\`${i.word}\`); the command has none`);
}
