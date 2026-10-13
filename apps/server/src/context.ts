import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db/database.js';
import type { SecretBox } from './lib/crypto.js';
import type { HttpClient } from './lib/http.js';

/** Everything services need, passed explicitly instead of module singletons (keeps tests isolated). */
export interface Ctx {
  config: Config;
  db: DB;
  box: SecretBox;
  http: HttpClient;
  log: FastifyBaseLogger;
  /** Wakes the worker right after a job is queued instead of waiting for the next poll. */
  notifyQueue(): void;
}
