import {
  type AuthState,
  type OverviewDto,
  changePasswordSchema,
  connectionCreateSchema,
  connectionDeleteSchema,
  connectionUpdateSchema,
  eventQuerySchema,
  instanceCreateSchema,
  pairPhoneSchema,
  loginSchema,
  providerCreateSchema,
  providerTestSchema,
  providerUpdateSchema,
  settingsSchema,
  setupSchema,
} from '@evobridge/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import fs from 'node:fs';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  type SessionInfo,
  authenticate,
  changePassword,
  createAdmin,
  createSession,
  destroySession,
  isSetupRequired,
  resolveSession,
} from '../auth/auth.js';
import { queueStats, replayJob } from '../bridge/queue.js';
import { checkConnection } from '../bridge/health.js';
import type { Ctx } from '../context.js';
import { AppError, notFound } from '../lib/errors.js';
import {
  getConnection,
  getConnectionRow,
  listConnections,
  setPaused,
  updateConnection,
} from '../services/connections.js';
import { eventCounts, queryEvents, recordEvent } from '../services/events.js';
import { createInstance, pairWithPhone, pairingState } from '../services/pairing.js';
import { createConnection, deleteConnection, provisionConnection } from '../services/provisioner.js';
import {
  createProvider,
  deleteProvider,
  getProvider,
  listChatwootAccounts,
  listChatwootInboxes,
  listEvolutionInstances,
  listProviders,
  recheckProvider,
  testProvider,
  updateProvider,
} from '../services/providers.js';
import { getSettings, resolvePublicUrl, saveSettings } from '../services/settings.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionInfo;
  }
}

const PUBLIC_API = new Set(['/api/auth/state', '/api/auth/setup', '/api/auth/login']);
const idParams = z.object({ id: z.string().min(1).max(64) });

export async function apiRoutes(root: FastifyInstance, ctx: Ctx): Promise<void> {
  const app = root.withTypeProvider<ZodTypeProvider>();

  app.addHook('onRequest', async (req, reply) => {
    // Cross-site requests are refused outright (complements SameSite cookies).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && safeHost(origin) !== req.headers.host) {
        return reply.code(403).send({ error: { code: 'bad_origin', message: 'Cross-site request refused' } });
      }
    }
    const path = req.url.split('?')[0] ?? '';
    const session = await resolveSession(ctx, req.cookies[SESSION_COOKIE]);
    if (session) req.session = session;
    if (PUBLIC_API.has(path)) return;
    if (!session) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Sign in to continue' } });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-csrf-token'] !== session.csrfToken) {
      return reply.code(403).send({ error: { code: 'csrf', message: 'Your session expired. Reload the page.' } });
    }
  });

  const setCookie = (req: FastifyRequest, reply: FastifyReply, token: string, expires: Date) => {
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      expires,
    });
  };

  // ---- auth ----

  app.get('/api/auth/state', async (req): Promise<AuthState & { csrfToken: string | null }> => ({
    setupRequired: await isSetupRequired(ctx),
    user: req.session?.user ?? null,
    version: ctx.config.version,
    csrfToken: req.session?.csrfToken ?? null,
  }));

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/api/auth/setup', { ...authLimit, schema: { body: setupSchema } }, async (req, reply) => {
    const user = await createAdmin(ctx, req.body);
    const s = await createSession(ctx, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(req, reply, s.token, s.expiresAt);
    await recordEvent(ctx, { connectionId: null, source: 'evobridge', direction: 'system', type: 'auth.setup', status: 'processed' });
    return { user, csrfToken: s.csrfToken };
  });

  app.post('/api/auth/login', { ...authLimit, schema: { body: loginSchema } }, async (req, reply) => {
    const user = await authenticate(ctx, req.body.email, req.body.password);
    if (!user) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    const s = await createSession(ctx, user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
    setCookie(req, reply, s.token, s.expiresAt);
    return { user, csrfToken: s.csrfToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) await destroySession(ctx, req.session.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', { ...authLimit, schema: { body: changePasswordSchema } }, async (req) => {
    const s = req.session!;
    await changePassword(ctx, s.user.id, req.body.currentPassword, req.body.newPassword, s.sessionId);
    return { ok: true };
  });

  // ---- overview ----

  app.get('/api/overview', async (): Promise<OverviewDto> => {
    const connections = await ctx.db.selectFrom('connections').select(['state', 'paused']).execute();
    const byState: Record<string, number> = {};
    for (const c of connections) byState[c.state] = (byState[c.state] ?? 0) + 1;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const counts = await eventCounts(ctx, since);
    const total = await ctx.db
      .selectFrom('events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', '=', 'processed')
      .where('direction', '!=', 'system')
      .executeTakeFirstOrThrow();
    const providers = await listProviders(ctx);
    const recent = await queryEvents(ctx, { limit: 8 });
    const q = await queueStats(ctx);
    return {
      connections: {
        total: connections.length,
        active: connections.filter((c) => c.state === 'connected').length,
        error: connections.filter((c) => c.state === 'error' || c.state === 'degraded' || c.state === 'disconnected').length,
        byState,
      },
      messages: { processed24h: counts.processed, failed24h: counts.failed, processedTotal: Number(total.n), queued: q.queued, dead: q.dead },
      providers: providers.map((p) => ({ id: p.id, kind: p.kind, name: p.name, status: p.status, lastCheckedAt: p.lastCheckedAt })),
      recentEvents: recent.items,
    };
  });

  // ---- providers ----

  app.get('/api/providers', async () => listProviders(ctx));
  app.post('/api/providers/test', { schema: { body: providerTestSchema } }, async (req) => testProvider(ctx, req.body));
  app.post('/api/providers', { schema: { body: providerCreateSchema } }, async (req) => createProvider(ctx, req.body));
  app.get('/api/providers/:id', { schema: { params: idParams } }, async (req) => getProvider(ctx, req.params.id));
  app.patch('/api/providers/:id', { schema: { params: idParams, body: providerUpdateSchema } }, async (req) => updateProvider(ctx, req.params.id, req.body));
  app.delete('/api/providers/:id', { schema: { params: idParams } }, async (req) => {
    await deleteProvider(ctx, req.params.id);
    return { ok: true };
  });
  app.post('/api/providers/:id/check', { schema: { params: idParams } }, async (req) => recheckProvider(ctx, req.params.id));
  app.get('/api/providers/:id/instances', { schema: { params: idParams } }, async (req) => listEvolutionInstances(ctx, req.params.id));
  app.post('/api/providers/:id/instances', { schema: { params: idParams, body: instanceCreateSchema } }, async (req) => createInstance(ctx, req.params.id, req.body.name));
  const instanceParams = idParams.extend({ instanceId: z.string().min(1).max(64) });
  app.get('/api/providers/:id/instances/:instanceId/pairing', { schema: { params: instanceParams } }, async (req) => {
    const state = await pairingState(ctx, req.params.id, req.params.instanceId);
    if (state.status === 'logged_in') {
      // A connection bridging this instance re-checks now: state and "connected" notice update at once.
      const conns = await ctx.db.selectFrom('connections').select('id').where('evolution_provider_id', '=', req.params.id).where('instance_id', '=', req.params.instanceId).execute();
      for (const c of conns) await checkConnection(ctx, c.id).catch(() => undefined);
    }
    return state;
  });
  app.post('/api/providers/:id/instances/:instanceId/pair', { schema: { params: instanceParams, body: pairPhoneSchema } }, async (req) =>
    pairWithPhone(ctx, req.params.id, req.params.instanceId, req.body.phone),
  );
  app.get('/api/providers/:id/accounts', { schema: { params: idParams } }, async (req) => listChatwootAccounts(ctx, req.params.id));
  app.get(
    '/api/providers/:id/accounts/:accountId/inboxes',
    { schema: { params: idParams.extend({ accountId: z.coerce.number().int().positive() }) } },
    async (req) => listChatwootInboxes(ctx, req.params.id, req.params.accountId),
  );

  // ---- connections ----

  app.get('/api/connections', async () => listConnections(ctx));
  app.post('/api/connections', { schema: { body: connectionCreateSchema } }, async (req) => createConnection(ctx, req.body));
  app.get('/api/connections/:id', { schema: { params: idParams } }, async (req) => getConnection(ctx, req.params.id));
  app.patch('/api/connections/:id', { schema: { params: idParams, body: connectionUpdateSchema } }, async (req) => updateConnection(ctx, req.params.id, req.body));
  app.post('/api/connections/:id/pause', { schema: { params: idParams } }, async (req) => setPaused(ctx, req.params.id, true));
  app.post('/api/connections/:id/resume', { schema: { params: idParams } }, async (req) => {
    const dto = await setPaused(ctx, req.params.id, false);
    await checkConnection(ctx, req.params.id).catch(() => undefined);
    ctx.notifyQueue();
    return getConnection(ctx, dto.id);
  });
  app.post(
    '/api/connections/:id/provision',
    { schema: { params: idParams, body: z.object({ replaceExistingWebhooks: z.boolean().default(false) }).default({ replaceExistingWebhooks: false }) } },
    async (req) => {
      await getConnectionRow(ctx, req.params.id);
      await provisionConnection(ctx, req.params.id, { replaceExistingWebhooks: req.body.replaceExistingWebhooks });
      return getConnection(ctx, req.params.id);
    },
  );
  app.post('/api/connections/:id/test', { schema: { params: idParams } }, async (req) => {
    await checkConnection(ctx, req.params.id);
    return getConnection(ctx, req.params.id);
  });
  app.delete('/api/connections/:id', { schema: { params: idParams, body: connectionDeleteSchema.optional() } }, async (req) => {
    return deleteConnection(ctx, req.params.id, { removeRemoteWebhooks: req.body?.removeRemoteWebhooks ?? false });
  });

  // ---- events ----

  app.get('/api/events', { schema: { querystring: eventQuerySchema } }, async (req) => queryEvents(ctx, req.query));
  app.post('/api/events/:id/replay', { schema: { params: idParams } }, async (req) => {
    const ev = await ctx.db.selectFrom('events').select(['job_id']).where('id', '=', req.params.id).executeTakeFirst();
    if (!ev) throw notFound('Event');
    if (!ev.job_id || !(await replayJob(ctx, ev.job_id))) {
      throw new AppError(409, 'not_replayable', 'This event can no longer be replayed', 'Its payload was removed by the retention policy, or it is still being processed.');
    }
    await ctx.db.updateTable('events').set({ status: 'received', error: null, updated_at: new Date().toISOString() }).where('id', '=', req.params.id).execute();
    ctx.notifyQueue();
    return { ok: true };
  });
  app.post('/api/events/replay-failed', { schema: { body: z.object({ connectionId: z.string().optional() }).default({}) } }, async (req) => {
    let q = ctx.db.selectFrom('jobs').select('id').where('status', '=', 'dead').where('payload_enc', 'is not', null);
    if (req.body.connectionId) q = q.where('connection_id', '=', req.body.connectionId);
    const jobs = await q.execute();
    let n = 0;
    for (const j of jobs) {
      if (await replayJob(ctx, j.id)) {
        n++;
        await ctx.db.updateTable('events').set({ status: 'received', error: null }).where('job_id', '=', j.id).execute();
      }
    }
    ctx.notifyQueue();
    return { replayed: n };
  });

  // ---- settings ----

  app.get('/api/settings', async () => getSettings(ctx));
  app.put('/api/settings', { schema: { body: settingsSchema.partial() } }, async (req) => saveSettings(ctx, req.body));
  app.get('/api/system', async () => {
    const pub = await resolvePublicUrl(ctx);
    const size = (() => {
      try {
        return fs.statSync(ctx.config.dbPath).size + (fs.existsSync(`${ctx.config.dbPath}-wal`) ? fs.statSync(`${ctx.config.dbPath}-wal`).size : 0);
      } catch {
        return 0;
      }
    })();
    const events = await ctx.db.selectFrom('events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    return {
      version: ctx.config.version,
      publicUrl: pub.url,
      publicUrlSource: pub.source,
      allowPrivateNetworks: ctx.config.allowPrivateNetworks,
      dataDir: ctx.config.dataDir,
      database: { sizeBytes: size, events: Number(events.n) },
    };
  });
}

function safeHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
