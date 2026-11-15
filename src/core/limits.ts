// Input limits. Each value is derived from what it protects, not
// picked; the basis of each is in docs/limits.md and repeated beside the
// constant. Tests take limits as parameters, so a test can use small values.

/**
 * Per-file size limit: 5 MB = 5,000,000 bytes.
 * Basis: the maintainer-confirmed performance envelope "files under 5 MB"
 * and the wireframe wording "5 MB". Decimal megabytes,
 * as the wording says; not 5 MiB.
 */
export const MAX_FILE_BYTES = 5_000_000;

/**
 * YAML alias expansion: the `yaml` library's own default `maxAliasCount`,
 * 100 (yaml 2.9.1: `Document.toJS` uses 100 when none is given; documented
 * as "Default: 100" in options.d.ts; read 2026-11-11). Passed explicitly to
 * every parse so a change of the library default cannot silently remove the
 * limit. -1 would disable the check and must never be used.
 */
export const YAML_MAX_ALIAS_COUNT = 100;

/**
 * The documented range of an ALB's `idle_timeout.timeout_seconds`: 1 to 4000
 * seconds. Source: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html,
 * read 2026-11-11: "The valid range is 1 to 4000 seconds." A value outside it
 * cannot be what a load balancer runs with, so it is never used as one. This is a documented range of a value, not an input limit.
 */
export const ALB_IDLE_MIN_S = 1;
export const ALB_IDLE_MAX_S = 4000;
export const REASON_ALB_IDLE_OUT_OF_RANGE = `outside the documented range ${ALB_IDLE_MIN_S} to ${ALB_IDLE_MAX_S} s`;

/** True when `seconds` can be an ALB idle timeout. */
export function isDocumentedAlbIdle(seconds: number): boolean {
  return Number.isInteger(seconds) && seconds >= ALB_IDLE_MIN_S && seconds <= ALB_IDLE_MAX_S;
}

/**
 * Nesting depth: no number is picked. A parse or walk that overflows the
 * stack throws RangeError; the file boundary catches it and reports the file
 * unchecked with this fixed reason.
 */
export const REASON_TOO_DEEPLY_NESTED = 'too deeply nested';

/*
 * No separate limit (and no number to name) for documents per file, line
 * length, total files or total bytes: there is no basis for one, and the
 * per-file limit, root confinement and symlink-loop detection already bound
 * the work.
 */
