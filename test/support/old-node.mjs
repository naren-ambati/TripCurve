// Preload that makes the process report an old Node, to run the real command under the unsupported-Node case.
Object.defineProperty(process.versions, 'node', { value: '20.11.0', configurable: true });
