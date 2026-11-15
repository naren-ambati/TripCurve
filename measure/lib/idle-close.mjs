// Measure how long a server keeps an idle keep-alive connection open:
// send one keep-alive request on 127.0.0.1, read the whole response, then
// time from the response's last byte to the server's FIN (docs/research.md
// section 2 method). Times are monotonic and rounded to whole ms.
// Returns {idleCloseMs} or {idleCloseMs: null, error}. Anything that is not
// an HTTP/1.1 200 reply with a Content-Length that keeps the connection
// alive and then ends it with a FIN is an error, never a number.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

export function measureIdleClose({ port, capMs = 120000, path = '/' }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let doneAt = null; // when the full response had arrived
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      sock.destroy();
      resolve(r);
    };
    const fail = (error) => finish({ idleCloseMs: null, error });
    const cap = setTimeout(() => fail(`timed out: still open after ${capMs} ms`), capMs);
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      if (doneAt !== null) return fail('bytes after the response: the reply was not one complete response');
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 200 /.test(head)) return fail(`not HTTP/1.1 200: ${JSON.stringify(head.split('\r\n')[0])}`);
      const connection = [...head.matchAll(/\r\nconnection:([^\r]*)/gi)].flatMap((m) => m[1].split(',').map((t) => t.trim().toLowerCase()));
      if (connection.includes('close')) return fail('not kept alive: the reply says Connection: close');
      const lengths = [...head.matchAll(/\r\ncontent-length:\s*(\d+)\s*(?=\r|$)/gi)];
      if (/\r\ntransfer-encoding:/i.test(head) && lengths.length > 0) return fail('ambiguous length: Content-Length and Transfer-Encoding');
      if (lengths.length > 1) return fail('ambiguous length: more than one Content-Length');
      if (lengths.length === 0) return fail('no content-length');
      const total = end + 4 + Number(lengths[0][1]);
      if (buf.length < total) return;
      if (buf.length > total) return fail('bytes after the response: the reply was not one complete response');
      doneAt = performance.now();
      serverHeader = /\r\nserver:\s*([^\r]*)/i.exec(head)?.[1] ?? null;
    });
    let serverHeader = null;
    const onClose = () => {
      if (doneAt === null) return fail('closed before the response was complete');
      finish({ idleCloseMs: Math.round(performance.now() - doneAt), serverHeader });
    };
    sock.on('end', onClose);
    sock.on('close', onClose);
    sock.on('error', (e) => fail(e.code ?? 'socket error'));
  });
}

// Record whether a server closes the connection right after its response, and
// whether the reply says `Connection: close`. This is a separate, explicit
// measurer for servers that are not expected to keep the connection alive
// (gunicorn's sync worker); measureIdleClose above stays strict and rejects
// `Connection: close`. Only facts are returned:
//   {closesAfterResponse, connectionCloseHeader, closeMs, serverHeader}
// closesAfterResponse is false when the connection was still open after capMs
// (closeMs is then null). Anything that is not one complete HTTP/1.1 200 reply
// with a Content-Length, or a reset, or a close before the reply was complete,
// is {error}.
export function measureCloseAfterResponse({ port, capMs = 10000, path = '/' }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let doneAt = null;
    let settled = false;
    let connectionCloseHeader = false;
    let serverHeader = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      sock.destroy();
      resolve(r);
    };
    const fail = (error) => finish({ error });
    // Still open at the cap: that is an observation, once the reply is complete.
    const cap = setTimeout(() => {
      if (doneAt === null) return fail(`timed out before the response was complete (${capMs} ms)`);
      finish({ closesAfterResponse: false, connectionCloseHeader, closeMs: null, serverHeader });
    }, capMs);
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      if (doneAt !== null) return fail('bytes after the response: the reply was not one complete response');
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buf.subarray(0, end).toString('latin1');
      if (!/^HTTP\/1\.1 200 /.test(head)) return fail(`not HTTP/1.1 200: ${JSON.stringify(head.split('\r\n')[0])}`);
      const lengths = [...head.matchAll(/\r\ncontent-length:\s*(\d+)\s*(?=\r|$)/gi)];
      if (/\r\ntransfer-encoding:/i.test(head) && lengths.length > 0) return fail('ambiguous length: Content-Length and Transfer-Encoding');
      if (lengths.length > 1) return fail('ambiguous length: more than one Content-Length');
      if (lengths.length === 0) return fail('no content-length');
      const total = end + 4 + Number(lengths[0][1]);
      if (buf.length < total) return;
      if (buf.length > total) return fail('bytes after the response: the reply was not one complete response');
      doneAt = performance.now();
      const tokens = [...head.matchAll(/\r\nconnection:([^\r]*)/gi)].flatMap((m) => m[1].split(',').map((t) => t.trim().toLowerCase()));
      connectionCloseHeader = tokens.includes('close');
      serverHeader = /\r\nserver:\s*([^\r]*)/i.exec(head)?.[1] ?? null;
    });
    const onClose = () => {
      if (doneAt === null) return fail('closed before the response was complete');
      finish({ closesAfterResponse: true, connectionCloseHeader, closeMs: Math.round(performance.now() - doneAt), serverHeader });
    };
    sock.on('end', onClose);
    sock.on('close', onClose);
    sock.on('error', (e) => fail(e.code ?? 'socket error'));
  });
}
