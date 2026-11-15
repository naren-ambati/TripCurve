// Splits a string into words the way Python's `shlex.split` does (POSIX mode, no
// comments), which is what gunicorn does with GUNICORN_CMD_ARGS. No variable
// expansion happens in shlex, so none is done here. Returns undefined when the text is
// not splittable (an unterminated quote or a trailing backslash: shlex raises), so the
// caller treats the whole value as not read.

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\u000b', '\f']);

export function shlexSplit(text: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (WHITESPACE.has(ch)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      i += 1;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      current += text.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const next = text[j + 1];
          if (next === undefined) return undefined;
          // Inside double quotes a backslash escapes only a double quote or a backslash.
          if (next === '"' || next === '\\') {
            current += next;
            j += 2;
            continue;
          }
        }
        current += c;
        j += 1;
      }
      if (!closed) return undefined;
      inWord = true;
      i = j + 1;
    } else if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return undefined;
      current += next;
      inWord = true;
      i += 2;
    } else {
      current += ch;
      inWord = true;
      i += 1;
    }
  }
  if (inWord) words.push(current);
  return words;
}
