// JSON text for the JSON and SARIF renderers: two-space indent, a newline at the end, and ASCII only. Every
// character above 0x7e is written as a \uXXXX escape (a valid JSON escape, so a reader gets the same string
// back), so no input text can put a control, bidirectional or other invisible character into the output
// itself. JSON.stringify already escapes controls below 0x20, quotes, backslashes and lone surrogates.

const FIRST_ESCAPED = 0x7f;

export function asciiJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out += unit >= FIRST_ESCAPED ? `\\u${unit.toString(16).padStart(4, '0')}` : text[i];
  }
  return `${out}\n`;
}
