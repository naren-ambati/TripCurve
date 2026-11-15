import http from 'node:http';

const ttl = Number(process.env.KEEPALIVE);
const server = http.createServer((_req, res) => res.end('ok'));
server.keepAliveTimeout = ttl;
server.headersTimeout = computeHeaders();
server.requestTimeout = 5000 + 1;
server.listen(8080);
