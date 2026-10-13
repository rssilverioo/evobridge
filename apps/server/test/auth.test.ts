import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/boot.js';
import { client, startEvoBridge } from './harness.js';

describe('authentication', () => {
  let rt: Runtime;
  let url: string;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evobridge-auth-'));
    ({ rt, url } = await startEvoBridge(dir));
  });
  afterAll(async () => {
    await rt.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('requires setup first and protects the API', async () => {
    const api = client(url);
    expect((await api.get('/api/auth/state')).body).toMatchObject({ setupRequired: true, user: null });
    expect((await api.get('/api/providers')).status).toBe(401);
  });

  it('enforces the password rule on setup', async () => {
    const res = await client(url).post('/api/auth/setup', { name: 'A', email: 'a@example.com', password: 'password' });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.password).toMatch(/number/);
  });

  it('creates the admin once; setup cannot be replayed', async () => {
    const api = client(url);
    const res = await api.post('/api/auth/setup', { name: 'Admin', email: 'Admin@Example.com', password: 'Secret#123' });
    expect(res.status).toBe(200);
    expect(api.cookie).toMatch(/^evobridge_session=/);
    const again = await client(url).post('/api/auth/setup', { name: 'Evil', email: 'evil@example.com', password: 'Secret#123' });
    expect(again.status).toBe(409);
  });

  it('stores only Argon2id hashes and hashed session ids', async () => {
    const user = await rt.ctx.db.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.email).toBe('admin@example.com');
    const session = await rt.ctx.db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('logs in, rejects bad passwords, requires CSRF on writes', async () => {
    const bad = await client(url).post('/api/auth/login', { email: 'admin@example.com', password: 'Wrong#123' });
    expect(bad.status).toBe(401);
    const api = client(url);
    expect((await api.post('/api/auth/login', { email: 'admin@example.com', password: 'Secret#123' })).status).toBe(200);
    expect((await api.get('/api/providers')).status).toBe(200);
    const csrf = api.csrf;
    api.csrf = '';
    expect((await api.put('/api/settings', { retentionDays: 3 })).status).toBe(403);
    api.csrf = csrf;
    expect((await api.put('/api/settings', { retentionDays: 3 })).status).toBe(200);
  });

  it('refuses cross-site requests', async () => {
    const res = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'Secret#123' }),
    });
    expect(res.status).toBe(403);
  });

  it('changing the password signs out other sessions', async () => {
    const a = client(url);
    const b = client(url);
    await a.post('/api/auth/login', { email: 'admin@example.com', password: 'Secret#123' });
    await b.post('/api/auth/login', { email: 'admin@example.com', password: 'Secret#123' });
    expect((await a.post('/api/auth/password', { currentPassword: 'Secret#123', newPassword: 'Newer#456' })).status).toBe(200);
    expect((await a.get('/api/providers')).status).toBe(200);
    expect((await b.get('/api/providers')).status).toBe(401);
    expect((await client(url).post('/api/auth/login', { email: 'admin@example.com', password: 'Newer#456' })).status).toBe(200);
  });

  it('logout ends the session', async () => {
    const api = client(url);
    await api.post('/api/auth/login', { email: 'admin@example.com', password: 'Newer#456' });
    await api.post('/api/auth/logout');
    expect((await api.get('/api/providers')).status).toBe(401);
  });

  it('serves a health check without auth', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
  });
});
