// Test helpers: read an InputText or a SourceRef as plain text. InputText has no
// string value, so tests go through SafeText like any other consumer would.
import { type InputText, SafeText, type SourceRef } from '../../src/core/index.js';

/** The text itself (the JSON/SARIF destination does not quote). */
export function txt(value: InputText): string {
  return SafeText.render(value, 'json');
}

/** `file:line`, or `<stdin> document n, line m`, as a short test string. */
export function where(source: SourceRef): string {
  switch (source.type) {
    case 'file':
    case 'declared':
      return `${txt(source.file)}:${source.line}`;
    case 'stdin':
      return `<stdin> document ${source.document}, line ${source.line}`;
    case 'default':
      return `default: ${source.citation}`;
  }
}
