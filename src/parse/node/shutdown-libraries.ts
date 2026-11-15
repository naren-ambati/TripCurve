// Packages that handle SIGTERM or delay a server's shutdown for the program, whose drain tripcurve does
// not read. Importing one (static, `require` or `import()`, with or without a subpath)
// makes the search for a drain incomplete: "no drain found" is not evidence while one of them is in
// use. `@godaddy/terminus` and `lightship` are READ (see read-node-drains.ts) and are not listed.
// The one place the list lives; add a name here, nowhere else.

export const SHUTDOWN_LIBRARIES: readonly string[] = [
  'close-with-grace',
  'http-terminator',
  'stoppable',
  'http-graceful-shutdown',
  'fastify-graceful-shutdown',
  'graceful-shutdown',
  'node-graceful-shutdown',
  'death',
  'signal-exit',
  'exit-hook',
  'async-exit-hook',
];

/** The package a module specifier names: `a/b/c` is `a`, `@s/a/b` is `@s/a`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

export function isShutdownLibrary(specifier: string): boolean {
  return SHUTDOWN_LIBRARIES.includes(packageNameOf(specifier));
}
