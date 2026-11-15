import http from 'node:http';
import './tuning';

export function start(_l, _e) {
  http.createServer((_req, res) => res.end('ok')).listen(8080);
}
