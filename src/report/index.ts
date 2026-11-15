// the report: the Report model and its three renderers (human, JSON, SARIF).
export { type AssembleInput, assembleReport, buildBlocks, orderFindings } from './assemble.js';
export { explainRule, isExplainableRule, UNKNOWN_RULE_MESSAGE } from './explain.js';
export { type RenderHumanOptions, renderHuman } from './human.js';
export { renderJson } from './json.js';
export * from './model.js';
export { FILE_RULE_ID, renderSarif, uriOf } from './sarif.js';
export {
  configErrorSummary,
  decideOutcome,
  isCleanOutcome,
  type SummarizeInput,
  summarizeRun,
  ZERO_DOWNTIME_LINE,
} from './summarize.js';
