// App for the lightship measurement: createLightship with its defaults (only
// the port is moved with LIGHTSHIP_PORT), one shutdown handler that closes the
// app's own HTTP server. Prints one line per event so the runner can time them.
//   env: LIGHTSHIP_DIR (folder holding node_modules/lightship), APP_PORT
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const { createLightship } = await import(pathToFileURL(`${process.env.LIGHTSHIP_DIR}/node_modules/lightship/dist/esm/index.js`).href);
const server = createServer((_q, r) => { r.writeHead(200, { 'content-length': '2' }); r.end('ok'); });
await new Promise((r) => server.listen(Number(process.env.APP_PORT), '127.0.0.1', r));
const lightship = await createLightship({});
lightship.registerShutdownHandler(async () => {
  console.log('HANDLER_START');
  await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
  console.log('SERVER_CLOSED');
});
lightship.signalReady();
console.log('APP_READY');
