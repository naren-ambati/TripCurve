// `--explain <rule>`: tripcurve's own shipped text for one rule. It holds
// the rule, the vendor quote with its link, the knowledge-base values the rule uses with their basis
// and dates, and when the rule does not apply. The knowledge-base rows are generated from the
// knowledge-base data, one per entry of the rule's subjects, so the text cannot drift from the data.
// No input text can reach it: it reads no file and takes nothing but a rule id.

import { RULE_IDS, type RuleId } from '../core/index.js';
import { EXPLAIN_ENTRIES } from '../evaluate/explain-entries.js';
import {
  basisWords,
  defaultKnowledgeBase,
  explicitBasisWords,
  type KbEntry,
  type KnowledgeBase,
} from '../kb/index.js';
import { wrapText } from './layout.js';

/** The message for a rule that is not one of T1 to T4; fixed, with no input in it. */
export const UNKNOWN_RULE_MESSAGE = `tripcurve: unknown rule. Rules are ${RULE_IDS.slice(0, -1).join(', ')} and ${RULE_IDS[RULE_IDS.length - 1]}. See --help.\n`;

export function isExplainableRule(text: string): text is RuleId {
  return (RULE_IDS as readonly string[]).includes(text);
}

function valueText(entry: KbEntry): string {
  return entry.value === 'n/a' ? 'n/a' : `${entry.value} ${entry.unit}`;
}

function whenText(entry: KbEntry): string {
  if (entry.basis === 'measured' && entry.measuredOn !== undefined) {
    return `dated ${entry.measuredOn.date}`;
  }
  return `source read ${entry.docDate}`;
}

function scriptText(entry: KbEntry): string {
  // A deferred entry is runnable software that has not been measured yet; its reason is fixed
  // knowledge-base text, never input.
  if (entry.deferredTo !== undefined) {
    return `deferred to ${entry.deferredTo.bolt}: not measured (${entry.deferredTo.reason})`;
  }
  return typeof entry.scriptRef === 'string'
    ? `script ${entry.scriptRef}`
    : 'not measurable locally';
}

/**
 * One knowledge-base entry as one wrapped list item: its id (unique, so two entries of one range that
 * differ by a condition stay apart), range, value, basis, date and script. Nothing is added to what the
 * entry and the basis words of the knowledge base say.
 */
function entryLines(entry: KbEntry): string[] {
  const basis = entry.subject.endsWith('-explicit') ? explicitBasisWords(entry) : basisWords(entry);
  const range = entry.rangeLabel === undefined ? '' : `, ${entry.rangeLabel}`;
  const condition = entry.applies.condition === undefined ? '' : ` (${entry.applies.condition})`;
  const never = entry.basis === 'to-be-measured' ? ' (never supports PASS)' : '';
  return wrapText(
    `- ${entry.id}${range}${condition}: ${valueText(entry)}; ${basis}${never}; ${whenText(entry)}; ${scriptText(entry)}`,
    '  ',
    '    ',
  );
}

/** The explain text of a rule, or undefined for anything that is not T1, T2, T3 or T4. */
export function explainRule(
  rule: string,
  kb: KnowledgeBase = defaultKnowledgeBase(),
): string | undefined {
  if (!isExplainableRule(rule)) return undefined;
  const entry = EXPLAIN_ENTRIES[rule];
  const lines: string[] = [...wrapText(entry.statement, `${rule}  `, '    '), ''];
  lines.push('Vendor guidance');
  for (const q of entry.quotes) {
    lines.push(...wrapText(`${q.source} (read ${q.read}):`, '  ', '  '));
    lines.push(...wrapText(`"${q.quote}"`, '  ', '  '));
    lines.push(`  ${q.url}`);
  }
  lines.push('');
  lines.push(`Defaults used by ${rule}`);
  const subjects = new Set<string>(entry.subjects);
  const rows = kb.entries.filter((e) => subjects.has(e.subject));
  // In the order of the rule's subject list, then the order the knowledge base holds them.
  rows.sort((a, b) => entry.subjects.indexOf(a.subject) - entry.subjects.indexOf(b.subject));
  for (const row of rows) lines.push(...entryLines(row));
  if (rows.length === 0) lines.push('  (no knowledge-base entry)');
  lines.push('');
  lines.push(`When ${rule} does not apply or cannot decide`);
  for (const text of entry.notApplicable) lines.push(...wrapText(`- ${text}`, '  ', '    '));
  if (entry.credit !== undefined) {
    lines.push('');
    lines.push('Credit');
    for (const text of entry.credit) {
      // A link stays on one line (rule 5: URLs are exempt from wrapping).
      lines.push(text.startsWith('https://') ? `  ${text}` : wrapText(text, '  ', '  ').join('\n'));
    }
  }
  return `${lines.join('\n')}\n`;
}
