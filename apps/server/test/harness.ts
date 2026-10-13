import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setBackoffBase } from '../src/bridge/queue.js';
import { type Runtime, boot } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { FakeChatwoot } from './mocks/chatwoot.js';
import { FakeEvolutionGo } from './mocks/evolution-go.js';

export const KEY = 'a'.repeat(64);

export interface Api {
  get<T = any>(p: string): Promise<{ status: number; body: T }>;
  post<T = any>(p: string, body?: unknown): Promise<{ status: number; body: T }>;
  patch<T = any>(p: string, body?: unknown): Promise<{ status: number; body: T }>;
  put<T = any>(p: string, body?: unknown): Promise<{ status: number; body: T }>;
  del<T = any>(p: string, body?: unknown): Promise<{ status: number; body: T }>;
  cookie: string;
  csrf: string;
}

export function client(base: string): Api {
  const api: Api = {
    cookie: '',
    csrf: '',
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
    del: (p, b) => call('DELETE', p, b),
  };
  async function call(method: string, p: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (api.cookie) headers.cookie = api.cookie;
    if (api.csrf) headers['x-csrf-token'] = api.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) api.cookie = set.split(';')[0]!;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (json?.csrfToken) api.csrf = json.csrfToken;
    return { status: res.status, body: json };
  }
  return api;
}

export interface Stack {
  rt: Runtime;
  url: string;
  dataDir: string;
  api: Api;
  evo: FakeEvolutionGo;
  cw: FakeChatwoot;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function startEvoBridge(dataDir: string, port = 0): Promise<{ rt: Runtime; url: string }> {
  const config = loadConfig({
    DATA_DIR: dataDir,
    ENCRYPTION_KEY: KEY,
    ALLOW_PRIVATE_NETWORKS: 'true',
    LOG_LEVEL: 'silent',
    WEB_DIR: path.join(dataDir, 'no-web'),
    NODE_ENV: 'test',
    PORT: String(port || 3000),
  });
  const rt = await boot(config);
  const url = await rt.app.listen({ port, host: '127.0.0.1' });
  return { rt, url };
}

/** EvoBridge on a real port + fake providers, admin signed in and public URL set. */
export async function startStack(): Promise<Stack> {
  setBackoffBase(20);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evobridge-test-'));
  const evo = new FakeEvolutionGo();
  const cw = new FakeChatwoot();
  await evo.start();
  await cw.start();
  let { rt, url } = await startEvoBridge(dataDir);
  const api = client(url);
  await api.post('/api/auth/setup', { name: 'Admin', email: 'admin@example.com', password: 'Secret#123' });
  await api.put('/api/settings', { publicUrl: url });

  const stack: Stack = {
    rt,
    url,
    dataDir,
    api,
    evo,
    cw,
    async restart() {
      const port = Number(new URL(stack.url).port);
      await stack.rt.close();
      ({ rt, url } = await startEvoBridge(dataDir, port));
      stack.rt = rt;
      stack.url = url;
    },
    async close() {
      await stack.rt.close().catch(() => undefined);
      await evo.stop();
      await cw.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return stack;
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; message?: string } = {}): Promise<NonNullable<T>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out${opts.message ? `: ${opts.message}` : ''} (last: ${JSON.stringify(last)})`);
}

/** Waits until the queue has no queued/running jobs. */
export async function settle(stack: Stack, timeoutMs = 8000): Promise<void> {
  await waitFor(
    async () => {
      const row = await stack.rt.ctx.db
        .selectFrom('jobs')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirstOrThrow();
      return Number(row.n) === 0;
    },
    { timeoutMs, message: 'queue did not settle' },
  );
  // Let in-flight webhook deliveries triggered by the last job land.
  await new Promise((r) => setTimeout(r, 60));
  await waitFor(
    async () => {
      const row = await stack.rt.ctx.db
        .selectFrom('jobs')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirstOrThrow();
      return Number(row.n) === 0;
    },
    { timeoutMs, message: 'queue did not settle' },
  );
}

/** Registers both providers and creates a connection with a new inbox. */
export async function connect(stack: Stack, opts: { instance?: string; replace?: boolean; options?: Record<string, unknown> } = {}) {
  const inst = stack.evo.instances.find((i) => i.name === (opts.instance ?? 'shop')) ?? stack.evo.addInstance({ name: opts.instance ?? 'shop' });
  const evoP = await stack.api.post('/api/providers', { kind: 'evolution_go', baseUrl: stack.evo.url, secret: stack.evo.globalKey });
  const cwP = await stack.api.post('/api/providers', { kind: 'chatwoot', baseUrl: stack.cw.url, secret: 'admin-token' });
  if (evoP.status !== 200 || cwP.status !== 200) throw new Error(`provider setup failed: ${JSON.stringify([evoP.body, cwP.body])}`);
  const res = await stack.api.post('/api/connections', {
    evolutionProviderId: evoP.body.provider.id,
    instanceName: inst.name,
    chatwootProviderId: cwP.body.provider.id,
    accountId: 1,
    inbox: { mode: 'create', inboxName: 'WhatsApp' },
    replaceExistingWebhooks: opts.replace ?? false,
    options: opts.options,
  });
  return { inst, connection: res.body, status: res.status, evoProviderId: evoP.body.provider.id as string, cwProviderId: cwP.body.provider.id as string };
}
