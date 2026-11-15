// Text layout for the terminal report (interaction spec, rules 1 and 5). A line is
// built from segments: tripcurve's own words (`text`, breakable at spaces) and
// quoted input (`quoted`, one unbreakable piece, already escaped and cut by
// SafeText). Input text enters a line only through `quote`, which calls SafeText.

import { type InputText, SafeText, TERMINAL_WIDTH } from '../core/index.js';

export type Seg = { readonly text: string } | { readonly quoted: string };

export const t = (text: string): Seg => ({ text });

/** Input text, quoted and escaped by SafeText, cut to at most `room` characters. */
export function quoteText(text: InputText, room: number): string {
  return SafeText.render(text, 'terminal', { maxLength: Math.max(room, 5) });
}

export function quote(text: InputText, room: number): Seg {
  return { quoted: quoteText(text, room) };
}

interface Word {
  readonly text: string;
  /** The word begins with quoted input (so a wrap keeps the word before it). */
  readonly startsQuoted: boolean;
}

function toWords(segs: readonly Seg[]): Word[] {
  const words: Word[] = [];
  let buffer = '';
  let startsQuoted = false;
  let open = false;
  const flush = (): void => {
    if (open) words.push({ text: buffer, startsQuoted });
    buffer = '';
    startsQuoted = false;
    open = false;
  };
  for (const seg of segs) {
    if ('quoted' in seg) {
      if (!open) startsQuoted = true;
      buffer += seg.quoted;
      open = true;
      continue;
    }
    for (const ch of seg.text) {
      if (ch === ' ') {
        flush();
      } else {
        buffer += ch;
        open = true;
      }
    }
  }
  flush();
  return words;
}

/**
 * Wraps `segs` at spaces so no line passes `width` columns. The first line starts
 * with `firstPrefix`, later lines with `contPrefix`. A line never continues with
 * quoted input: the words before it move down with it, back to a word of tripcurve's
 * own (rule 5), so the fixed label stays with its quoted text. Width wins over that:
 * when those words would not fit on one line, only the wrapped word moves. A word wider
 * than the room stays whole on its own line (a quoted word was already cut by `quote`).
 */
export function wrap(
  segs: readonly Seg[],
  firstPrefix: string,
  contPrefix: string,
  width: number = TERMINAL_WIDTH,
): string[] {
  const words = toWords(segs);
  const lines: string[] = [];
  let prefix = firstPrefix;
  let line: Word[] = [];
  const fits = (candidate: readonly Word[], lead: string): boolean =>
    lead.length + candidate.reduce((n, w) => n + w.text.length, 0) + candidate.length - 1 <= width;
  const render = (lead: string, ws: readonly Word[]): string =>
    lead + ws.map((w) => w.text).join(' ');
  for (const word of words) {
    if (line.length === 0 || fits([...line, word], prefix)) {
      line.push(word);
      continue;
    }
    // A continuation line never starts with quoted input: the words before it, back to a
    // word of tripcurve's own, move down with it. Width comes first: when the moved words
    // would not fit, only the wrapped word moves.
    const carried: Word[] = [];
    let first: Word = word;
    while (first.startsQuoted && line.length - carried.length > 1) {
      const back = line[line.length - 1 - carried.length];
      if (back === undefined) break;
      carried.unshift(back);
      first = back;
    }
    const moved = first.startsQuoted ? [] : carried;
    const chosen = fits([...moved, word], contPrefix) ? [...moved, word] : [word];
    lines.push(render(prefix, line.slice(0, line.length - (chosen.length - 1))));
    prefix = contPrefix;
    line = chosen;
  }
  lines.push(render(prefix, line));
  return lines;
}

/** Wraps tripcurve's own plain sentence. */
export function wrapText(
  text: string,
  firstPrefix: string,
  contPrefix: string,
  width: number = TERMINAL_WIDTH,
): string[] {
  return wrap([t(text)], firstPrefix, contPrefix, width);
}
