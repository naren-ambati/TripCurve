// Self-test for the idle-close measurer: fake servers whose behaviour is
// known. A measurer that timed from connect or from the request, turned an
// error or a short reply into a number, accepted a reply that does not keep
// the connection alive, or added a bias fails at least one case.
// Run: node measure/selftest.mjs
import net from 'node:net';
import { measureIdleClose, measureCloseAfterResponse } from './lib/idle-close.mjs';

// Observed bias of the real measurements is +0 to +4 ms (B0 results); 15 ms
// covers loopback scheduling noise and still catches a bias of tens of ms.
const SLACK_MS = 15;
const OK_HEAD = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok';

function fakeServer(onRequest) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.once('data', () => onRequest(sock));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const closeAfter = (ms, head = OK_HEAD, replyDelayMs = 0) => (sock) =>
  setTimeout(() => { sock.write(head); setTimeout(() => sock.end(), ms); }, replyDelayMs);

const cases = [
  { name: 'closes 300 ms after the response', srv: closeAfter(300), expect: 300 },
  { name: 'closes 1200 ms after the response', srv: closeAfter(1200), expect: 1200 },
  { name: 'replies after 500 ms, closes 300 ms later (times from the response, not the request)', srv: closeAfter(300, OK_HEAD, 500), expect: 300 },
  { name: 'header split across two writes', srv: (s) => { s.write('HTTP/1.1 200 OK\r\nContent-'); setTimeout(() => { s.write('Length: 2\r\n\r\nok'); setTimeout(() => s.end(), 300); }, 50); }, expect: 300 },
  { name: 'lower-case content-length, as real servers send it', srv: closeAfter(300, 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'), expect: 300 },
  { name: 'Content-Length and Transfer-Encoding both present', srv: closeAfter(300, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nok'), expectError: 'ambiguous length' },
  { name: 'two Content-Length headers', srv: closeAfter(300, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nok'), expectError: 'ambiguous length' },
  { name: 'extra bytes after the body', srv: closeAfter(300, `${OK_HEAD}xx`), expectError: 'bytes after the response' },
  { name: 'extra bytes after the body, sent later', srv: (s) => { s.write(OK_HEAD); setTimeout(() => s.write('x'), 100); setTimeout(() => s.end(), 300); }, expectError: 'bytes after the response' },
  { name: 'never closes (cap 800 ms)', srv: () => {}, capMs: 800, expectError: 'timed out' },
  { name: 'Connection: close reply', srv: closeAfter(0, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'), expectError: 'not kept alive' },
  { name: 'Connection: keep-alive, close reply', srv: closeAfter(0, 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive, close\r\n\r\nok'), expectError: 'not kept alive' },
  { name: 'HTTP/1.0 reply', srv: closeAfter(300, 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok'), expectError: 'not HTTP/1.1 200' },
  { name: '404 reply', srv: closeAfter(300, 'HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno'), expectError: 'not HTTP/1.1 200' },
  { name: 'chunked reply (no length)', srv: closeAfter(300, 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n'), expectError: 'no content-length' },
  { name: 'body cut short, then close', srv: closeAfter(300, 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nok'), expectError: 'closed before the response was complete' },
  { name: 'reset after the response', srv: (s) => { s.write(OK_HEAD); setTimeout(() => s.resetAndDestroy(), 300); }, expectError: 'ECONNRESET' },
];

let failed = 0;
for (const c of cases) {
  const srv = await fakeServer(c.srv);
  const r = await measureIdleClose({ port: srv.address().port, capMs: c.capMs ?? 5000 });
  srv.close();
  const ok = c.expectError
    ? r.idleCloseMs === null && typeof r.error === 'string' && r.error.includes(c.expectError)
    // The fake server starts its close timer when it writes, slightly before the client sees
    // the last byte, so a correct measurer can read up to 2 ms under nominal here (seen: 1199
    // for 1200). Real servers were never below nominal; a -5 ms bias is still caught.
    : r.error === undefined && r.idleCloseMs >= c.expect - 2 && r.idleCloseMs <= c.expect + SLACK_MS;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(r)}`);
  if (!ok) failed++;
}
// measureCloseAfterResponse: records facts, so a server that closes at once
// and one that never closes must give different answers; replies that are not
// one complete 200 are errors, never facts.
const CLOSE_HEAD = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok';
// The fake server starts its timer when it writes, which is before the client
// has seen the last byte, so a measured interval can come in 1 to 2 ms under
// the nominal one (299 ms against 300 once). The floor of the new
// close-after-response cases therefore allows 2 ms under nominal; the older
// measureIdleClose cases keep their floor of exactly the nominal value.
const FLOOR_SLACK_MS = 2;
const closeCases = [
  { name: 'close: Connection: close and FIN at once', srv: closeAfter(0, CLOSE_HEAD), expect: { closesAfterResponse: true, connectionCloseHeader: true, maxCloseMs: SLACK_MS } },
  { name: 'close: lower-case header, token list', srv: closeAfter(0, 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive, Close\r\n\r\nok'), expect: { closesAfterResponse: true, connectionCloseHeader: true, maxCloseMs: SLACK_MS } },
  { name: 'close: header present but the server never closes (cap 600 ms)', srv: (s) => s.write(CLOSE_HEAD), capMs: 600, expect: { closesAfterResponse: false, connectionCloseHeader: true, closeMs: null } },
  { name: 'close: no header, FIN 300 ms later (time is from the response)', srv: closeAfter(300, OK_HEAD, 400), expect: { closesAfterResponse: true, connectionCloseHeader: false, minCloseMs: 300 - FLOOR_SLACK_MS, maxCloseMs: 300 + SLACK_MS } },
  { name: 'close: no header and never closes', srv: (s) => s.write(OK_HEAD), capMs: 600, expect: { closesAfterResponse: false, connectionCloseHeader: false, closeMs: null } },
  { name: 'close: header split across two writes', srv: (s) => { s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnec'); setTimeout(() => { s.write('tion: close\r\n\r\nok'); setTimeout(() => s.end(), 100); }, 50); }, expect: { closesAfterResponse: true, connectionCloseHeader: true, minCloseMs: 100 - FLOOR_SLACK_MS, maxCloseMs: 100 + SLACK_MS } },
  { name: 'close: 404 reply', srv: closeAfter(0, 'HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno'), expectError: 'not HTTP/1.1 200' },
  { name: 'close: HTTP/1.0 reply', srv: closeAfter(0, 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'), expectError: 'not HTTP/1.1 200' },
  { name: 'close: body cut short, then close', srv: closeAfter(0, 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nok'), expectError: 'closed before the response was complete' },
  { name: 'close: reset after the response', srv: (s) => { s.write(CLOSE_HEAD); setTimeout(() => s.resetAndDestroy(), 100); }, expectError: 'ECONNRESET' },
  { name: 'close: extra bytes after the body', srv: closeAfter(0, `${CLOSE_HEAD}xx`), expectError: 'bytes after the response' },
  { name: 'close: no content-length', srv: closeAfter(0, 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nok'), expectError: 'no content-length' },
  { name: 'close: nothing sent, never closes (cap 600 ms)', srv: () => {}, capMs: 600, expectError: 'timed out' },
];
for (const c of closeCases) {
  const srv = await fakeServer(c.srv);
  const r = await measureCloseAfterResponse({ port: srv.address().port, capMs: c.capMs ?? 5000 });
  srv.close();
  let ok;
  if (c.expectError) ok = typeof r.error === 'string' && r.error.includes(c.expectError) && r.closesAfterResponse === undefined;
  else {
    const e = c.expect;
    ok = r.error === undefined && r.closesAfterResponse === e.closesAfterResponse && r.connectionCloseHeader === e.connectionCloseHeader
      && ('closeMs' in e ? r.closeMs === e.closeMs : r.closeMs >= (e.minCloseMs ?? 0) && r.closeMs <= e.maxCloseMs);
  }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${JSON.stringify(r)}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'selftest: all cases passed' : `selftest: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
