import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim().toLowerCase())
  .pipe(z.enum(['', 'true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim().replace(/\/+$/, '')),
  ENCRYPTION_KEY: z.string().optional(),
  ALLOW_PRIVATE_NETWORKS: bool,
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_DIR: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
});

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  publicUrl: string;
  encryptionKey: string | undefined;
  allowPrivateNetworks: boolean;
  trustProxy: string | boolean;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  webDir: string;
  workerConcurrency: number;
  version: string;
  isDev: boolean;
}

export const VERSION = process.env.EVOBRIDGE_VERSION ?? '0.1.0';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(e.DATA_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const trustProxy = e.TRUST_PROXY === 'true' ? true : e.TRUST_PROXY === 'false' ? false : e.TRUST_PROXY;
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir,
    dbPath: path.join(dataDir, 'evobridge.db'),
    publicUrl: e.PUBLIC_URL,
    encryptionKey: e.ENCRYPTION_KEY?.trim() || undefined,
    allowPrivateNetworks: e.ALLOW_PRIVATE_NETWORKS,
    trustProxy,
    logLevel: e.LOG_LEVEL,
    // dist/index.js -> ../web (Docker) ; src/index.ts -> ../../web/out (dev)
    webDir: path.resolve(e.WEB_DIR ?? path.join(here, '..', '..', 'web', 'out')),
    workerConcurrency: e.WORKER_CONCURRENCY,
    version: VERSION,
    isDev: env.NODE_ENV !== 'production',
  };
}
