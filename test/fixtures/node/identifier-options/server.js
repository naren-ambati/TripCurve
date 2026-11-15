import http from 'node:http';

const options = { keepAliveTimeout: 70000 };
http.createServer(options, (_req, res) => res.end('ok')).listen(80);
