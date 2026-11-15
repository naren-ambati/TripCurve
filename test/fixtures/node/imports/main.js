import { start } from './boot.js';
import { logger } from './util/logger';
import express from 'express';

start(logger, express);
