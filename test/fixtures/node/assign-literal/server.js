import http from 'node:http';

const server = http.createServer((_req, res) => res.end('ok'));
server.keepAliveTimeout = 65000;
server.headersTimeout = 66_000;
server.requestTimeout = 30 * 1000;
server['keepAliveTimeoutBuffer'] = 2000;
server.listen(8080);
