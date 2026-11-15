// The Node version check. It runs first, before anything
// else is loaded or read, so it imports nothing from the rest of tripcurve.

export const MIN_NODE = Object.freeze({ major: 22, minor: 12, patch: 0 });
export const MIN_NODE_TEXT = '22.12.0';

function parts(version: string): [number, number, number] | undefined {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True for Node 22.12.0 or later. A version string that cannot be read is not supported. */
export function nodeIsSupported(version: string): boolean {
  const p = parts(version);
  if (p === undefined) return false;
  const [major, minor, patch] = p;
  if (major !== MIN_NODE.major) return major > MIN_NODE.major;
  if (minor !== MIN_NODE.minor) return minor > MIN_NODE.minor;
  return patch >= MIN_NODE.patch;
}

/**
 * The fixed unsupported-Node message. The running version comes from the process, not from
 * input; it is printed only when it is digits and dots.
 */
export function unsupportedNodeMessage(version: string): string {
  const shown = /^v?\d{1,9}(\.\d{1,9}){0,2}$/.test(version) ? version.replace(/^v/, '') : 'unknown';
  return `tripcurve needs Node ${MIN_NODE_TEXT} or later; this is Node ${shown}.\nNothing was checked.\n`;
}
