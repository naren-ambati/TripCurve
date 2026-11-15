import http from 'node:http';
import { base } from './base.js';

http.createServer({ ...base, keepAliveTimeout: 65000 }, (_req, res) => res.end('ok')).listen(80);
