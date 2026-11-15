import express from 'express';

const app = express();
const server = app.listen(3000);
server.keepAliveTimeout = 61 * 1000;
