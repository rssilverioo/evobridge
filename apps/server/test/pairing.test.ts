import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './harness.js';

describe('creating and pairing instances from EvoBridge', () => {
  let s: Stack;
  let providerId: string;
  beforeAll(async () => {
    s = await startStack();
    providerId = (await s.api.post('/api/providers', { kind: 'evolution_go', baseUrl: s.evo.url, secret: s.evo.globalKey })).body.provider.id;
  });
  afterAll(async () => {
    await s.close();
  });

  it('creates an instance with a random token that never reaches the browser', async () => {
    const res = await s.api.post(`/api/providers/${providerId}/instances`, { name: 'vendas' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'vendas', connected: false });
    const inst = s.evo.instances.find((i) => i.name === 'vendas')!;
    expect(inst.token.length).toBeGreaterThan(20);
    expect(JSON.stringify(res.body)).not.toContain(inst.token);
    expect((await s.api.post(`/api/providers/${providerId}/instances`, { name: 'vendas' })).status).toBe(409);
    expect((await s.api.post(`/api/providers/${providerId}/instances`, { name: 'bad name!' })).status).toBe(400);
  });

  it('serves the QR code until the phone scans it, then reports the number', async () => {
    const inst = s.evo.instances.find((i) => i.name === 'vendas')!;
    const qr = await s.api.get(`/api/providers/${providerId}/instances/${inst.id}/pairing`);
    expect(qr.body.status).toBe('qr');
    expect(qr.body.qr).toMatch(/^data:image\/png;base64,/);
    s.evo.scan('vendas', '5511955554444');
    const done = await s.api.get(`/api/providers/${providerId}/instances/${inst.id}/pairing`);
    expect(done.body).toEqual({ status: 'logged_in', phone: '5511955554444' });
  });

  it('pairs with a phone number code', async () => {
    const created = await s.api.post(`/api/providers/${providerId}/instances`, { name: 'suporte' });
    const res = await s.api.post(`/api/providers/${providerId}/instances/${created.body.id}/pair`, { phone: '+55 (11) 98765-4321' });
    expect(res.body).toEqual({ code: 'ABCD-1234' });
    expect(s.evo.pairedPhone).toBe('5511987654321');
    const bad = await s.api.post(`/api/providers/${providerId}/instances/${created.body.id}/pair`, { phone: '123' });
    expect(bad.status).toBe(400);
  });
});
