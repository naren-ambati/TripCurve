import http from 'node:http';

const server = http.createServer((_req, res) => {
  res.end('ok');
});

server.keepAliveTimeout = 65000;
server.listen(8080);
