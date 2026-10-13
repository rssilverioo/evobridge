import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { enqueue } from '../bridge/queue.js';
import { isDeletion, shouldSend } from '../bridge/outbound.js';
import { answerPing } from '../bridge/selfcheck.js';
import type { Ctx } from '../context.js';
import { safeEqual, sha256 } from '../lib/crypto.js';
import { verifyChatwootSignature } from '../providers/chatwoot/client.js';
import type { CwWebhook } from '../providers/chatwoot/types.js';
import { normalizeEvolutionEvent } from '../providers/evolution-go/normalize.js';
import type { EvoWebhook } from '../providers/evolution-go/types.js';
import { recordEvent } from '../services/events.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface HookParams {
  connectionId: string;
  secret: string;
}

/**
 * Provider callbacks. They only authenticate, de-duplicate and enqueue, then answer 200 right
 * away: Chatwoot gives up after 5 s and never retries, Evolution Go retries 5 times.
 */
export async function hookRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  // Keep the raw bytes: Chatwoot signs them, and forwarding must not re-serialize.
  app.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'buffer', bodyLimit: 150 * 1024 * 1024 }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {});
    } catch {
      const err = new Error('Invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.get<{ Params: { nonce: string } }>('/hooks/ping/:nonce', async (req) => answerPing(req.params.nonce));

  async function authorize(req: FastifyRequest<{ Params: HookParams }>, reply: FastifyReply) {
    const row = await ctx.db.selectFrom('connections').selectAll().where('id', '=', req.params.connectionId).executeTakeFirst();
    if (!row || !safeEqual(ctx.box.decrypt(row.hook_secret_enc), req.params.secret)) {
      await reply.code(404).send({ error: 'not found' });
      return null;
    }
    return row;
  }

  app.post<{ Params: HookParams; Body: EvoWebhook }>('/hooks/evolution/:connectionId/:secret', async (req, reply) => {
    const row = await authorize(req, reply);
    if (!row) return reply;
    const body = req.body;
    if (!body || typeof body.event !== 'string') return reply.code(400).send({ error: 'not an Evolution Go event' });
    // Evolution Go has no signature; every payload carries the instance token, so check it too.
    if (row.instance_token_enc && body.instanceToken && !safeEqual(ctx.box.decrypt(row.instance_token_enc), body.instanceToken)) {
      return reply.code(403).send({ error: 'event from a different instance' });
    }

    if (row.previous_evo_webhook_url && req.rawBody) {
      await enqueue(ctx, {
        connectionId: row.id,
        kind: 'forward_webhook',
        dedupeKey: `fwd:evo:${row.id}:${sha256(req.rawBody.toString('utf8'))}`,
        orderingKey: `fwd:${row.id}`,
        payload: { url: row.previous_evo_webhook_url, body: req.rawBody.toString('utf8'), headers: {} },
        maxAttempts: 5,
      });
    }

    const event = normalizeEvolutionEvent(body);
    if (event.type === 'ignored') {
      ctx.notifyQueue();
      return { ok: true, ignored: event.reason };
    }
    if (row.paused) {
      await recordEvent(ctx, { connectionId: row.id, source: 'evolution_go', direction: 'inbound', type: body.event, status: 'ignored', detail: { reason: 'connection paused' } });
      return { ok: true, ignored: 'paused' };
    }

    // Echo of a message EvoBridge itself sent (its id was reserved before sending): acknowledge
    // quietly instead of logging an "ignored" line after every agent reply.
    if (event.type === 'message') {
      const echo = await ctx.db
        .selectFrom('message_links')
        .select('id')
        .where('connection_id', '=', row.id)
        .where('wa_message_id', '=', event.id)
        .where('origin', '=', 'cw_to_wa')
        .executeTakeFirst();
      if (echo) return { ok: true, ignored: 'echo' };
    }

    let dedupeKey: string;
    let orderingKey: string;
    let refs: Record<string, string> = {};
    switch (event.type) {
      case 'message':
      case 'revoke':
      case 'edit':
      case 'reaction':
        // Keyed by WhatsApp id: Message and SendMessage for the same id are one event.
        dedupeKey = `evo:${row.id}:${event.id}`;
        orderingKey = `chat:${row.id}:${event.chat.chatJid}`;
        refs = { waMessageId: event.id, chat: event.chat.chatJid };
        break;
      case 'receipt':
        dedupeKey = `evo:${row.id}:receipt:${event.state}:${[...event.messageIds].sort().join(',')}`;
        orderingKey = `chat:${row.id}:${event.chatJid}`;
        refs = { waMessageId: event.messageIds.join(','), chat: event.chatJid };
        break;
      case 'connection':
        dedupeKey = `evo:${row.id}:conn:${sha256(req.rawBody?.toString('utf8') ?? JSON.stringify(body))}`;
        orderingKey = `conn:${row.id}`;
        break;
    }
    const jobId = await enqueue(ctx, { connectionId: row.id, kind: 'evolution_event', dedupeKey, orderingKey, payload: body });
    if (jobId) {
      await recordEvent(ctx, { connectionId: row.id, jobId, source: 'evolution_go', direction: 'inbound', type: `${event.type}`, status: 'received', refs });
      ctx.notifyQueue();
    }
    return { ok: true, duplicate: !jobId };
  });

  app.post<{ Params: HookParams; Body: CwWebhook }>('/hooks/chatwoot/:connectionId/:secret', async (req, reply) => {
    const row = await authorize(req, reply);
    if (!row) return reply;
    if (row.chatwoot_hmac_enc && req.rawBody) {
      const ok = verifyChatwootSignature(
        ctx.box.decrypt(row.chatwoot_hmac_enc),
        req.rawBody,
        header(req, 'x-chatwoot-timestamp'),
        header(req, 'x-chatwoot-signature'),
      );
      if (!ok) return reply.code(401).send({ error: 'invalid signature' });
    }
    const body = req.body;
    if (!body || typeof body.event !== 'string') return reply.code(400).send({ error: 'not a Chatwoot event' });

    if (row.previous_cw_webhook_url && req.rawBody) {
      // Same bytes, same signature headers: the previous consumer can still verify them.
      const headers: Record<string, string> = {};
      for (const h of ['x-chatwoot-signature', 'x-chatwoot-timestamp', 'x-chatwoot-delivery']) {
        const v = header(req, h);
        if (v) headers[h] = v;
      }
      await enqueue(ctx, {
        connectionId: row.id,
        kind: 'forward_webhook',
        dedupeKey: `fwd:cw:${row.id}:${header(req, 'x-chatwoot-delivery') ?? sha256(req.rawBody.toString('utf8'))}`,
        orderingKey: `fwd:${row.id}`,
        payload: { url: row.previous_cw_webhook_url, body: req.rawBody.toString('utf8'), headers },
        maxAttempts: 5,
      });
    }

    const relevant = body.event === 'message_created' || isDeletion(body);
    if (!relevant) {
      ctx.notifyQueue();
      return { ok: true, ignored: body.event };
    }
    const decision = shouldSend(body);
    if (!isDeletion(body) && !decision.send) {
      // Bridge-created copies, notes and the like: acknowledged, not queued, not logged
      // (each WhatsApp message would otherwise produce a second, noisy log line).
      return { ok: true, ignored: decision.reason };
    }
    if (row.paused) {
      await recordEvent(ctx, { connectionId: row.id, source: 'chatwoot', direction: 'outbound', type: body.event, status: 'ignored', detail: { reason: 'connection paused' } });
      return { ok: true, ignored: 'paused' };
    }

    const conversationId = body.conversation?.id;
    const contact = conversationId
      ? await ctx.db.selectFrom('contacts').select('chat_jid').where('connection_id', '=', row.id).where('cw_conversation_id', '=', conversationId).executeTakeFirst()
      : undefined;
    const orderingKey = contact ? `chat:${row.id}:${contact.chat_jid}` : `cwconv:${row.id}:${conversationId ?? 'none'}`;
    const kind = isDeletion(body) ? 'deleted' : 'created';
    const jobId = await enqueue(ctx, {
      connectionId: row.id,
      kind: 'chatwoot_event',
      dedupeKey: `cw:${row.id}:${kind}:${body.id ?? header(req, 'x-chatwoot-delivery') ?? sha256(JSON.stringify(body))}`,
      orderingKey,
      payload: body,
    });
    if (jobId) {
      await recordEvent(ctx, {
        connectionId: row.id,
        jobId,
        source: 'chatwoot',
        direction: 'outbound',
        type: kind === 'deleted' ? 'message.deleted' : 'message.outgoing',
        status: 'received',
        refs: { cwMessageId: body.id, cwConversationId: conversationId },
      });
      ctx.notifyQueue();
    }
    return { ok: true, duplicate: !jobId };
  });
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
