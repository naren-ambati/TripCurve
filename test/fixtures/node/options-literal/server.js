const http = require('node:http');

const server = http.createServer(
  { keepAliveTimeout: 65_000, 'headersTimeout': 66000, requestTimeout: (60 * 1000) as number },
  (_req, res) => res.end('ok'),
);
server.listen(8080);
