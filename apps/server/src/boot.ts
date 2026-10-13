import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp, newFastify } from './app.js';
import { HealthLoop } from './bridge/health.js';
import { requeueAllRunning } from './bridge/queue.js';
import { Worker } from './bridge/worker.js';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { migrateToLatest, openDatabase } from './db/database.js';
import { SecretBox, loadOrCreateKey } from './lib/crypto.js';
import { createHttpClient } from './lib/http.js';

export interface Runtime {
  app: FastifyInstance;
  ctx: Ctx;
  worker: Worker;
  health: HealthLoop;
  close(): Promise<void>;
}

/** Wires database, crypto, HTTP client, worker and server. `start: false` leaves loops off (tests). */
export async function boot(config: Config, opts: { start?: boolean } = {}): Promise<Runtime> {
  const start = opts.start ?? true;
  if (config.dbPath !== ':memory:') fs.mkdirSync(config.dataDir, { recursive: true });
  const { db, sqlite } = openDatabase(config.dbPath);
  const applied = await migrateToLatest(db);
  const { key, source } = loadOrCreateKey(config.dataDir, config.encryptionKey);
  const http = createHttpClient({ allowPrivate: config.allowPrivateNetworks, userAgent: `EvoBridge/${config.version}` });

  const app = newFastify(config);
  let worker: Worker | null = null;
  const ctx: Ctx = {
    config,
    db,
    box: new SecretBox(key),
    http,
    log: app.log,
    notifyQueue: () => worker?.wake(),
  };
  worker = new Worker(ctx, config.workerConcurrency);
  const health = new HealthLoop(ctx);

  if (applied.length) app.log.info({ migrations: applied }, 'database migrated');
  if (source === 'generated') app.log.warn('generated a new encryption key in the data directory; back it up together with the database');

  await buildApp(ctx, app);

  if (start) {
    const recovered = await requeueAllRunning(ctx);
    if (recovered) app.log.info({ recovered }, 'requeued jobs interrupted by the last shutdown');
    worker.start();
    health.start();
  }

  return {
    app,
    ctx,
    worker,
    health,
    async close() {
      health.stop();
      await worker.stop();
      await app.close();
      await http.close();
      await db.destroy();
      if (sqlite.open) sqlite.close();
    },
  };
}
