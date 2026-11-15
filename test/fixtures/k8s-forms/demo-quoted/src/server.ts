import http from 'node:http';

const port = 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.end('ok');
    return;
  }
  res.end('hello from web');
});
// (no keep-alive setting here: Node's default applies)
server.listen(port);
