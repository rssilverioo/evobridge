import type { Ctx } from '../context.js';
import { ProviderError } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { WaContent, WaEvent } from '../providers/evolution-go/normalize.js';
import { type Bridge, setConnectionState } from '../services/connections.js';
import { extensionFor, waid, whatsAppToMarkdown } from './format.js';
import { instancePhone, postNotice } from './notices.js';
import { dropConversation, ensureThread } from './threads.js';

export interface HandlerResult {
  status: 'processed' | 'ignored';
  type: string;
  reason?: string;
  refs?: Record<string, string | number | null | undefined>;
  detail?: Record<string, unknown>;
}

const MEDIA_FALLBACK_AFTER = 3;

/** WhatsApp -> Chatwoot. `attempt` starts at 1; media falls back to a placeholder after a few tries. */
export async function handleEvolutionEvent(ctx: Ctx, b: Bridge, event: WaEvent, attempt: number): Promise<HandlerResult> {
  switch (event.type) {
    case 'message':
      return handleMessage(ctx, b, event, attempt);
    case 'revoke':
      return handleRevoke(ctx, b, event);
    case 'edit':
      return handleAnnotation(ctx, b, event, `✏️ ${event.text}`, 'message.edit');
    case 'reaction':
      if (!event.emoji) return { status: 'ignored', type: 'message.reaction', reason: 'reaction removed' };
      return handleAnnotation(ctx, b, event, event.emoji, 'message.reaction');
    case 'receipt':
      return handleReceipt(ctx, b, event);
    case 'connection':
      return handleConnection(ctx, b, event);
    case 'ignored':
      return { status: 'ignored', type: 'event', reason: event.reason };
  }
}

type MessageEvent = Extract<WaEvent, { type: 'message' }>;

async function handleMessage(ctx: Ctx, b: Bridge, e: MessageEvent, attempt: number): Promise<HandlerResult> {
  const type = `message.${e.content.kind}`;
  const refs = { waMessageId: e.id, chat: e.chat.chatJid };

  const link = await ctx.db
    .selectFrom('message_links')
    .select(['origin', 'cw_message_id'])
    .where('connection_id', '=', b.row.id)
    .where('wa_message_id', '=', e.id)
    .executeTakeFirst();
  if (link?.origin === 'cw_to_wa') return { status: 'ignored', type, reason: 'echo of a message EvoBridge sent', refs };
  if (link?.cw_message_id) return { status: 'ignored', type, reason: 'already in Chatwoot', refs: { ...refs, cwMessageId: link.cw_message_id } };

  if (e.chat.isGroup && !b.options.includeGroups) return { status: 'ignored', type, reason: 'group chats are off for this connection', refs };
  if (e.fromMe && !b.options.syncPhoneMessages) return { status: 'ignored', type, reason: 'messages sent from the phone are not synced', refs };
  if (!e.chat.isGroup && !e.chat.phone && !e.chat.lid) return { status: 'ignored', type, reason: 'chat address could not be resolved', refs };

  const thread = await ensureThread(ctx, b, e.chat, { pushName: e.fromMe ? null : e.pushName });
  let content = buildText(e);
  let attachment: { data: Buffer; fileName: string; mimetype: string; voice?: boolean } | undefined;
  let mediaNote: string | undefined;

  if (isMedia(e.content)) {
    try {
      attachment = await fetchMedia(ctx, b, e.id, e.content);
    } catch (err) {
      const retryable = !(err instanceof ProviderError) || err.retryable;
      if (retryable && attempt < MEDIA_FALLBACK_AFTER) throw err;
      // Never drop the message: post a visible placeholder instead.
      mediaNote = err instanceof Error ? err.message : String(err);
      content = [`📎 ${labelFor(e.content)} could not be downloaded from WhatsApp`, content].filter(Boolean).join('\n');
    }
  } else if (e.content.kind === 'unsupported' && !e.content.text) {
    content = `[Unsupported WhatsApp message: ${e.content.label ?? 'unknown'}]`;
  }

  const create = () =>
    b.cw.createMessage(b.accountId, thread.conversationId, {
      content,
      messageType: e.fromMe ? 'outgoing' : 'incoming',
      sourceId: waid(e.id),
      inReplyToSourceId: e.quotedId ? waid(e.quotedId) : null,
      attachment,
    });

  let message;
  try {
    message = await create();
  } catch (err) {
    // The conversation was deleted in Chatwoot: start a fresh one and retry once.
    if (err instanceof ProviderError && err.kind === 'not_found') {
      await dropConversation(ctx, thread.rowId);
      const fresh = await ensureThread(ctx, b, e.chat, { pushName: e.fromMe ? null : e.pushName });
      message = await b.cw.createMessage(b.accountId, fresh.conversationId, {
        content,
        messageType: e.fromMe ? 'outgoing' : 'incoming',
        sourceId: waid(e.id),
        inReplyToSourceId: e.quotedId ? waid(e.quotedId) : null,
        attachment,
      });
      thread.conversationId = fresh.conversationId;
    } else {
      throw err;
    }
  }

  await ctx.db
    .insertInto('message_links')
    .values({
      connection_id: b.row.id,
      wa_message_id: e.id,
      wa_chat_jid: e.chat.chatJid,
      wa_from_me: e.fromMe ? 1 : 0,
      wa_participant: e.participant?.jid ?? null,
      cw_message_id: message.id,
      cw_conversation_id: thread.conversationId,
      origin: 'wa_to_cw',
      wa_status: 'sent',
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.columns(['connection_id', 'wa_message_id']).doUpdateSet({ cw_message_id: message.id, cw_conversation_id: thread.conversationId }))
    .execute();

  return {
    status: 'processed',
    type: e.fromMe ? `${type}.from_phone` : type,
    refs: { ...refs, cwMessageId: message.id, cwConversationId: thread.conversationId },
    detail: mediaNote ? { mediaFallback: mediaNote } : undefined,
  };
}

function buildText(e: MessageEvent): string {
  const body = whatsAppToMarkdown(e.content.text);
  if (e.chat.isGroup && e.participant && !e.fromMe) {
    const who = [e.participant.phone ? `+${e.participant.phone}` : null, e.pushName].filter(Boolean).join(' - ');
    return `**${who || 'Participant'}:**\n${body}`;
  }
  return body;
}

const isMedia = (c: WaContent) => c.kind === 'image' || c.kind === 'video' || c.kind === 'audio' || c.kind === 'document' || c.kind === 'sticker';

function labelFor(c: WaContent): string {
  return { image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', sticker: 'Sticker' }[c.kind as string] ?? 'File';
}

/** Inline base64 (WEBHOOK_FILES), then a MinIO URL, then Evolution Go's download endpoint. */
async function fetchMedia(ctx: Ctx, b: Bridge, id: string, c: WaContent): Promise<{ data: Buffer; fileName: string; mimetype: string; voice?: boolean }> {
  let data: Buffer | null = null;
  let mimetype = c.inline?.mimetype ?? c.mimetype ?? 'application/octet-stream';
  if (c.inline?.base64) {
    data = Buffer.from(c.inline.base64, 'base64');
  } else if (c.inline?.url) {
    const res = await ctx.http.request(c.inline.url, { timeoutMs: 120_000, maxBytes: 100 * 1024 * 1024, followRedirects: true, headers: { accept: '*/*' } });
    if (res.status === 200) data = res.body;
  }
  if (!data && c.raw) {
    const out = await b.evo.downloadMedia(b.instanceToken, c.raw);
    data = out.data;
    mimetype = out.mimetype;
  }
  if (!data || data.length === 0) throw new ProviderError('bad_response', 'WhatsApp media was empty');

  const base = mimetype.split(';')[0]?.trim() || 'application/octet-stream';
  if (c.kind === 'audio') {
    // Voice notes are OGG/Opus; keeping the mime and extension consistent helps Chatwoot's player.
    const isOgg = base === 'audio/ogg' || base === 'audio/opus';
    return { data, fileName: `audio-${id}.${isOgg ? 'ogg' : extensionFor(base, 'ogg')}`, mimetype: isOgg ? 'audio/ogg' : base, voice: Boolean(c.ptt) };
  }
  if (c.kind === 'document') return { data, fileName: c.fileName || `document-${id}.${extensionFor(base)}`, mimetype: base };
  const prefix = c.kind === 'sticker' ? 'sticker' : c.kind;
  return { data, fileName: `${prefix}-${id}.${extensionFor(base, c.kind === 'video' ? 'mp4' : 'jpg')}`, mimetype: base };
}

async function handleRevoke(ctx: Ctx, b: Bridge, e: Extract<WaEvent, { type: 'revoke' }>): Promise<HandlerResult> {
  const link = await ctx.db
    .selectFrom('message_links')
    .selectAll()
    .where('connection_id', '=', b.row.id)
    .where('wa_message_id', '=', e.targetId)
    .executeTakeFirst();
  const refs = { waMessageId: e.targetId, chat: e.chat.chatJid };
  if (!link?.cw_message_id || !link.cw_conversation_id) return { status: 'ignored', type: 'message.revoke', reason: 'original message is not in Chatwoot', refs };
  try {
    await b.cw.deleteMessage(b.accountId, link.cw_conversation_id, link.cw_message_id);
  } catch (err) {
    if (!(err instanceof ProviderError && err.kind === 'not_found')) throw err;
  }
  return { status: 'processed', type: 'message.revoke', refs: { ...refs, cwMessageId: link.cw_message_id } };
}

/** Edits and reactions are posted as a reply to the original message. */
async function handleAnnotation(
  ctx: Ctx,
  b: Bridge,
  e: Extract<WaEvent, { type: 'edit' | 'reaction' }>,
  content: string,
  type: string,
): Promise<HandlerResult> {
  const refs = { waMessageId: e.id, target: e.targetId, chat: e.chat.chatJid };
  if (e.chat.isGroup && !b.options.includeGroups) return { status: 'ignored', type, reason: 'group chats are off for this connection', refs };
  if (e.fromMe && !b.options.syncPhoneMessages) return { status: 'ignored', type, reason: 'messages sent from the phone are not synced', refs };
  const already = await ctx.db
    .selectFrom('message_links')
    .select('cw_message_id')
    .where('connection_id', '=', b.row.id)
    .where('wa_message_id', '=', e.id)
    .executeTakeFirst();
  if (already?.cw_message_id) return { status: 'ignored', type, reason: 'already in Chatwoot', refs };
  const target = await ctx.db
    .selectFrom('message_links')
    .select(['cw_conversation_id'])
    .where('connection_id', '=', b.row.id)
    .where('wa_message_id', '=', e.targetId)
    .executeTakeFirst();
  if (!target?.cw_conversation_id) return { status: 'ignored', type, reason: 'original message is not in Chatwoot', refs };
  const message = await b.cw.createMessage(b.accountId, target.cw_conversation_id, {
    content: whatsAppToMarkdown(content),
    messageType: e.fromMe ? 'outgoing' : 'incoming',
    sourceId: waid(e.id),
    inReplyToSourceId: waid(e.targetId),
  });
  await ctx.db
    .insertInto('message_links')
    .values({
      connection_id: b.row.id,
      wa_message_id: e.id,
      wa_chat_jid: e.chat.chatJid,
      wa_from_me: e.fromMe ? 1 : 0,
      wa_participant: null,
      cw_message_id: message.id,
      cw_conversation_id: target.cw_conversation_id,
      origin: 'wa_to_cw',
      wa_status: 'sent',
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.columns(['connection_id', 'wa_message_id']).doNothing())
    .execute();
  return { status: 'processed', type, refs: { ...refs, cwMessageId: message.id } };
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };

/** WhatsApp ticks on agent messages become Chatwoot message statuses (forward-only). */
async function handleReceipt(ctx: Ctx, b: Bridge, e: Extract<WaEvent, { type: 'receipt' }>): Promise<HandlerResult> {
  const links = await ctx.db
    .selectFrom('message_links')
    .selectAll()
    .where('connection_id', '=', b.row.id)
    .where('origin', '=', 'cw_to_wa')
    .where('wa_message_id', 'in', e.messageIds)
    .execute();
  let updated = 0;
  for (const link of links) {
    if (!link.cw_message_id || !link.cw_conversation_id) continue;
    if ((STATUS_RANK[link.wa_status] ?? 0) >= (STATUS_RANK[e.state] ?? 0)) continue;
    try {
      await b.cw.updateMessageStatus(b.accountId, link.cw_conversation_id, link.cw_message_id, e.state);
    } catch (err) {
      if (!(err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'client_error'))) throw err;
    }
    await ctx.db.updateTable('message_links').set({ wa_status: e.state }).where('id', '=', link.id).execute();
    updated++;
  }
  if (!updated) return { status: 'ignored', type: `receipt.${e.state}`, reason: 'no agent message to update' };
  return { status: 'processed', type: `receipt.${e.state}`, refs: { waMessageId: e.messageIds.join(',') } };
}

async function handleConnection(ctx: Ctx, b: Bridge, e: Extract<WaEvent, { type: 'connection' }>): Promise<HandlerResult> {
  const type = `instance.${e.event}`;
  if (b.row.paused) return { status: 'processed', type };
  if (e.event === 'Connected' || e.event === 'PairSuccess') {
    await setConnectionState(ctx, b.row.id, 'connected', null);
    await postNotice(ctx, b, 'reconnected', { phone: await instancePhone(b) });
  } else if (e.event === 'TemporaryBan') {
    await setConnectionState(ctx, b.row.id, 'error', 'WhatsApp temporarily banned this number');
    await postNotice(ctx, b, 'banned');
  } else if (e.event === 'LoggedOut') {
    await setConnectionState(ctx, b.row.id, 'disconnected', 'The WhatsApp number was logged out. Scan the QR code again in Evolution Go.');
    await postNotice(ctx, b, 'logged_out');
  } else {
    // Short drops reconnect on their own; the health check posts a notice if it lasts.
    await setConnectionState(ctx, b.row.id, 'disconnected', `WhatsApp connection lost (${e.event}${e.detail ? `: ${e.detail}` : ''})`);
  }
  return { status: 'processed', type };
}
