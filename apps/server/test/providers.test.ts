import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, connect, startStack } from './harness.js';

describe('providers and provisioning', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(async () => {
    await s.close();
  });

  it('tests Evolution Go credentials and explains failures', async () => {
    s.evo.addInstance({ name: 'shop' });
    const ok = await s.api.post('/api/providers/test', { kind: 'evolution_go', baseUrl: s.evo.url, secret: s.evo.globalKey });
    expect(ok.body).toMatchObject({ ok: true, status: 'ok', details: { instanceCount: 1 } });

    const bad = await s.api.post('/api/providers/test', { kind: 'evolution_go', baseUrl: s.evo.url, secret: 'nope' });
    expect(bad.body).toMatchObject({ ok: false, status: 'unauthorized' });

    s.evo.activated = false;
    const inactive = await s.api.post('/api/providers/test', { kind: 'evolution_go', baseUrl: s.evo.url, secret: s.evo.globalKey });
    expect(inactive.body).toMatchObject({ ok: false, status: 'not_activated' });
    expect(inactive.body.hint).toMatch(/manager/i);
    s.evo.activated = true;

    const down = await s.api.post('/api/providers/test', { kind: 'evolution_go', baseUrl: 'http://127.0.0.1:1', secret: 'x' });
    expect(down.body).toMatchObject({ ok: false, status: 'unreachable' });
  });

  it('tests Chatwoot credentials and lists accounts', async () => {
    const ok = await s.api.post('/api/providers/test', { kind: 'chatwoot', baseUrl: s.cw.url, secret: 'admin-token' });
    expect(ok.body).toMatchObject({ ok: true, details: { accounts: [{ id: 1, name: 'Acme', role: 'administrator' }] } });
    const bad = await s.api.post('/api/providers/test', { kind: 'chatwoot', baseUrl: s.cw.url, secret: 'wrong' });
    expect(bad.body).toMatchObject({ ok: false, status: 'unauthorized' });
  });

  it('never returns stored secrets to the browser', async () => {
    const created = await s.api.post('/api/providers', { kind: 'chatwoot', baseUrl: s.cw.url, secret: 'admin-token' });
    expect(created.status).toBe(200);
    const list = await s.api.get('/api/providers');
    expect(JSON.stringify(list.body)).not.toContain('admin-token');
    expect(list.body[0].secretPreview).toBe('admi••••oken');
    const row = await s.rt.ctx.db.selectFrom('providers').selectAll().executeTakeFirstOrThrow();
    expect(row.secret_enc).not.toContain('admin-token');
  });

  it('refuses to save a provider whose credentials fail', async () => {
    const res = await s.api.post('/api/providers', { kind: 'evolution_go', baseUrl: s.evo.url, secret: 'bad' });
    expect(res.status).toBe(422);
  });

  it('provisions a connection end to end and preserves other channels', async () => {
    const inst = s.evo.instances[0]!;
    inst.rabbitmqEnable = 'enabled';
    inst.events = 'MESSAGE,LABEL';
    const { connection, status } = await connect(s);
    expect(status).toBe(200);
    expect(connection.provision.map((p: { status: string }) => p.status)).toEqual(Array(8).fill('done'));
    expect(connection.state).toBe('connected');

    expect(inst.webhook).toMatch(new RegExp(`/hooks/evolution/${connection.id}/`));
    expect(inst.rabbitmqEnable).toBe('enabled');
    expect(inst.events.split(',').sort()).toEqual(['CONNECTION', 'LABEL', 'MESSAGE', 'READ_RECEIPT', 'SEND_MESSAGE']);
    const inbox = s.cw.inboxes.find((i) => i.name === 'WhatsApp')!;
    expect(inbox.webhook_url).toMatch(new RegExp(`/hooks/chatwoot/${connection.id}/`));
    expect(JSON.stringify(connection)).not.toContain(inst.webhook.split('/').pop()!);
  });

  it('does not let the same instance be bridged twice', async () => {
    const res = await connect(s);
    expect(res.status).toBe(409);
  });

  it('asks before replacing a webhook another service uses, then forwards to it', async () => {
    const other = s.evo.addInstance({ name: 'sales', token: 'token-sales', webhook: 'http://127.0.0.1:9/n8n-hook' });
    const first = await connect(s, { instance: 'sales' });
    const step = first.connection.provision.find((p: { id: string }) => p.id === 'evolution_webhook');
    expect(step.status).toBe('action_required');
    expect(other.webhook).toBe('http://127.0.0.1:9/n8n-hook');
    expect(first.connection.state).toBe('configuring');

    const retry = await s.api.post(`/api/connections/${first.connection.id}/provision`, { replaceExistingWebhooks: true });
    expect(retry.body.state).toBe('connected');
    const row = await s.rt.ctx.db.selectFrom('connections').selectAll().where('id', '=', first.connection.id).executeTakeFirstOrThrow();
    expect(row.previous_evo_webhook_url).toBe('http://127.0.0.1:9/n8n-hook');
  });

  it('explains when the Chatwoot user is not an administrator', async () => {
    s.cw.tokens['agent-token'] = { name: 'Bob Agent', role: 'agent' };
    const cwP = await s.api.post('/api/providers', { kind: 'chatwoot', baseUrl: s.cw.url, secret: 'agent-token' });
    // Same base URL: updates the stored provider's token instead of duplicating it.
    expect(cwP.status).toBe(200);
    s.evo.addInstance({ name: 'support', token: 'token-support' });
    const evoId = (await s.api.get('/api/providers')).body.find((p: { kind: string }) => p.kind === 'evolution_go').id;
    const res = await s.api.post('/api/connections', {
      evolutionProviderId: evoId,
      instanceName: 'support',
      chatwootProviderId: cwP.body.provider.id,
      accountId: 1,
      inbox: { mode: 'create', inboxName: 'Support' },
    });
    const step = res.body.provision.find((p: { id: string }) => p.id === 'validate');
    expect(step.status).toBe('action_required');
    expect(step.message).toMatch(/administrator/);
    await s.api.patch(`/api/providers/${cwP.body.provider.id}`, { secret: 'admin-token' });
  });

  it('removes a connection and, only when asked, restores the previous webhooks', async () => {
    const list = (await s.api.get('/api/connections')).body as Array<{ id: string; evolution: { instanceName: string } }>;
    const sales = list.find((c) => c.evolution.instanceName === 'sales')!;
    const res = await s.api.del(`/api/connections/${sales.id}`, { removeRemoteWebhooks: true });
    expect(res.status).toBe(200);
    expect(s.evo.instances.find((i) => i.name === 'sales')!.webhook).toBe('http://127.0.0.1:9/n8n-hook');

    const shop = list.find((c) => c.evolution.instanceName === 'shop')!;
    const before = s.evo.instances.find((i) => i.name === 'shop')!.webhook;
    await s.api.del(`/api/connections/${shop.id}`, { removeRemoteWebhooks: false });
    expect(s.evo.instances.find((i) => i.name === 'shop')!.webhook).toBe(before);
  });
});
