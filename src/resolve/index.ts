// Resolver. (ResolvedWorkload and its candidates).

export { resolveSettingPrecedence } from './gunicorn-precedence.js';
export * from './idle-close.js';
export * from './lb-idle.js';
export * from './model.js';
export {
  DECLARE_NODE_VERSION,
  describeInterval,
  isUnknownInterval,
  resolveNodeVersion,
} from './node-version.js';
export { resolvePythonServer } from './python-server.js';
export {
  DECLARE_NO_GUNICORN_VERSION,
  DECLARE_NO_UVICORN_VERSION,
  resolvePythonServerVersion,
} from './python-version.js';
export { resolveQueueWorkloads } from './queue.js';
export { type ResolveInput, resolveWorkloads } from './resolve.js';
export {
  KUBERNETES_DETECTION_ASSUMPTION,
  REASON_SEVERAL_DRAINS,
  REASON_SOURCE_NOT_LINKED,
} from './shutdown.js';
export { DECLARE_DRAIN, DECLARE_LONGEST_REQUEST } from './shutdown-text.js';
export { terraformIdle } from './terraform-lb.js';
