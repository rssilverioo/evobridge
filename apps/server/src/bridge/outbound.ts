import type { Ctx } from '../context.js';
import { PermanentError, ProviderError } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { CwAttachment, CwWebhook } from '../providers/chatwoot/types.js';
import { generateWaMessageId } from '../providers/evolution-go/client.js';
import { isGroupJid, isLid, isPn } from '../providers/evolution-go/normalize.js';
import type { EvoMediaType } from '../providers/evolution-go/types.js';
import type { Bridge } from '../services/connections.js';
import { extensionFor, markdownToWhatsApp } from './format.js';
import { SYSTEM_CHAT, SYSTEM_SOURCE } from './notices.js';
import type { HandlerResult } from './inbound.js';

/**
 * The same rule Chatwoot applies before sending to a native channel
 * (Base::SendOnChannelService): outgoing or template, not a private note, not created by a
 * channel (source_id set), not a voice call.
 */
export function shouldSend(p: CwWebhook): { send: boolean; reason?: string } {
  if (p.event !== 'message_created') return { send: false, reason: `event ${p.event}` };
  if (p.message_type !== 'outgoing' && p.message_type !== 'template') return { send: false, reason: `${p.message_type ?? 'unknown'} message` };
  if (p.private) return { send: false, reason: 'private note' };
  if (p.source_id) return { send: false, reason: 'message created by a channel (has source_id)' };
  if (p.content_type === 'voice_call') return { send: false, reason: 'voice call' };
  return { send: true };
}

export const isDeletion = (p: CwWebhook) => p.event === 'message_updated' && p.content_attributes?.deleted === true;

/** Chatwoot -> WhatsApp. */
export async function handleChatwootEvent(ctx: Ctx, b: Bridge, p: CwWebhook): Promise<HandlerResult> {
  if (p.inbox?.id && p.inbox.id !== b.inboxId) return { status: 'ignored', type: p.event, reason: `event from inbox #${p.inbox.id}` };
  if (isDeletion(p)) return handleDeletion(ctx, b, p);
  const decision = shouldSend(p);
  if (!decision.send) return { status: 'ignored', type: p.event, reason: decision.reason, refs: { cwMessageId: p.id } };
  return sendAgentMessage(ctx, b, p);
}

/** WhatsApp address for a Chatwoot conversation. Never guesses a number that isn't there. */
export async function resolveTarget(ctx: Pick<Ctx, 'db'>, b: Bridge, p: CwWebhook): Promise<string> {
  const conv = p.conversation;
  if (conv?.id) {
    const byConv = await ctx.db
      .selectFrom('contacts')
      .select('chat_jid')
      .where('connection_id', '=', b.row.id)
      .where('cw_conversation_id', '=', conv.id)
      .executeTakeFirst();
    if (byConv) return byConv.chat_jid;
  }
  const source = conv?.contact_inbox?.source_id?.trim();
  if (source === SYSTEM_SOURCE) return SYSTEM_CHAT;
  if (source) {
    const bySource = await ctx.db
      .selectFrom('contacts')
      .select('chat_jid')
      .where('connection_id', '=', b.row.id)
      .where('cw_source_id', '=', source)
      .executeTakeFirst();
    if (bySource) return bySource.chat_jid;
    if (/^\d{8,15}$/.test(source)) return `${source}@s.whatsapp.net`;
    if (isPn(source) || isLid(source) || isGroupJid(source)) return source;
  }
  // A conversation an agent started for a contact created by hand: use the contact's phone.
  const phone = conv?.meta?.sender?.phone_number?.replace(/\D/g, '');
  if (phone && phone.length >= 8) return `${phone}@s.whatsapp.net`;
  throw new PermanentError('This Chatwoot contact has no WhatsApp number or chat id');
}

async function sendAgentMessage(ctx: Ctx, b: Bridge, p: CwWebhook): Promise<HandlerResult> {
  const cwMessageId = p.id;
  const conversationId = p.conversation?.id;
  if (!cwMessageId || !conversationId) throw new PermanentError('Chatwoot payload without message or conversation id');
  const target = await resolveTarget(ctx, b, p);
  if (target === SYSTEM_CHAT || p.conversation?.contact_inbox?.source_id === SYSTEM_SOURCE) {
    return { status: 'ignored', type: 'message.outgoing', reason: 'reply in the EvoBridge notices conversation', refs: { cwMessageId } };
  }
  const refs: Record<string, string | number> = { cwMessageId, cwConversationId: conversationId, chat: target };

  const existing = await ctx.db
    .selectFrom('message_links')
    .selectAll()
    .where('connection_id', '=', b.row.id)
    .where('cw_message_id', '=', cwMessageId)
    .where('origin', '=', 'cw_to_wa')
    .orderBy('id', 'asc')
    .execute();
  if (existing.length && existing.every((l) => l.wa_status !== 'pending' && l.wa_status !== 'failed')) {
    return { status: 'ignored', type: 'message.outgoing', reason: 'already sent', refs };
  }

  let text = markdownToWhatsApp(p.content ?? '');
  const isAgent = p.sender?.type === 'user';
  const agentName = p.sender?.available_name || p.sender?.name;
  if (b.options.signAgentName && isAgent && agentName && text) text = `*${agentName}:*\n${text}`;

  const quoted = await quotedFor(ctx, b, p, target);
  const attachments = (p.attachments ?? []).filter((a) => a.data_url || a.file_type === 'location');
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'attachment'; attachment: CwAttachment; caption?: string }> = [];
  if (!attachments.length) {
    if (!text) return { status: 'ignored', type: 'message.outgoing', reason: 'empty message', refs };
    parts.push({ kind: 'text', text });
  } else {
    attachments.forEach((a, i) => parts.push({ kind: 'attachment', attachment: a, caption: i === 0 ? text : undefined }));
    // Captions only fit images, videos and documents; otherwise the text goes first, on its own.
    const first = attachments[0];
    if (text && first && first.file_type === 'audio') {
      parts.unshift({ kind: 'text', text });
      const p0 = parts[1];
      if (p0?.kind === 'attachment') p0.caption = undefined;
    }
  }

  const waIds: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // One reserved WhatsApp id per part, reused across retries, written before sending so the
    // echo webhook (which can beat the HTTP response) is recognized.
    let link = existing[i];
    if (!link) {
      const id = generateWaMessageId();
      await ctx.db
        .insertInto('message_links')
        .values({
          connection_id: b.row.id,
          wa_message_id: id,
          wa_chat_jid: target,
          wa_from_me: 1,
          wa_participant: null,
          cw_message_id: cwMessageId,
          cw_conversation_id: conversationId,
          origin: 'cw_to_wa',
          wa_status: 'pending',
          created_at: nowIso(),
        })
        .execute();
      link = await ctx.db.selectFrom('message_links').selectAll().where('connection_id', '=', b.row.id).where('wa_message_id', '=', id).executeTakeFirstOrThrow();
    }
    waIds.push(link.wa_message_id);
    if (link.wa_status !== 'pending' && link.wa_status !== 'failed') continue;

    if (part.kind === 'text') {
      await b.evo.sendText(b.instanceToken, { number: target, text: part.text, id: link.wa_message_id, ...(i === 0 && quoted ? { quoted } : {}) });
    } else if (part.attachment.file_type === 'location') {
      const a = part.attachment;
      const t = `📍 ${a.fallback_title ?? 'Location'}\nhttps://maps.google.com/?q=${a.coordinates_lat},${a.coordinates_long}`;
      await b.evo.sendText(b.instanceToken, { number: target, text: t, id: link.wa_message_id });
    } else {
      const file = await downloadAttachment(b, part.attachment);
      await b.evo.sendMedia(b.instanceToken, {
        number: target,
        type: file.type,
        file: file.data,
        fileName: file.fileName,
        mimetype: file.mimetype,
        caption: file.type === 'audio' ? undefined : part.caption,
        id: link.wa_message_id,
        ...(i === 0 && quoted ? { quoted } : {}),
      });
    }
    await ctx.db.updateTable('message_links').set({ wa_status: 'sent' }).where('id', '=', link.id).execute();
  }

  return { status: 'processed', type: attachments.length ? 'message.outgoing.media' : 'message.outgoing', refs: { ...refs, waMessageId: waIds.join(',') } };
}

async function quotedFor(ctx: Ctx, b: Bridge, p: CwWebhook, target: string): Promise<{ messageId: string; participant: string } | null> {
  const replyTo = p.content_attributes?.in_reply_to;
  if (!replyTo) return null;
  const link = await ctx.db
    .selectFrom('message_links')
    .selectAll()
    .where('connection_id', '=', b.row.id)
    .where('cw_message_id', '=', replyTo)
    .orderBy('id', 'asc')
    .executeTakeFirst();
  if (!link) return null;
  // Quoting needs the original sender: the group participant, our own number, or the contact.
  const participant = link.wa_participant ?? (link.wa_from_me ? (await ownJid(ctx, b)) ?? target : target);
  return { messageId: link.wa_message_id, participant };
}

async function ownJid(ctx: Ctx, b: Bridge): Promise<string | null> {
  if (!b.row.instance_id) return null;
  try {
    const inst = await b.evo.getInstance(b.row.instance_id);
    return inst.jid ? inst.jid.replace(/:\d+@/, '@') : null;
  } catch {
    return null;
  }
}

async function downloadAttachment(b: Bridge, a: CwAttachment): Promise<{ type: EvoMediaType; data: Buffer; fileName: string; mimetype: string }> {
  if (!a.data_url) throw new PermanentError('Attachment has no download URL');
  const res = await b.cw.downloadAttachment(a.data_url);
  const mimetype = (a.content_type || res.mimetype || 'application/octet-stream').split(';')[0]!.trim();
  const fromUrl = decodeURIComponent(new URL(a.data_url).pathname.split('/').pop() ?? '');
  const fileName = fromUrl && fromUrl.includes('.') ? fromUrl : `file-${a.id}.${a.extension || extensionFor(mimetype)}`;
  // Evolution Go accepts only jpeg/png/webp images and mp4 video; anything else goes as a document.
  let type: EvoMediaType = 'document';
  if (a.file_type === 'image' && /^image\/(jpeg|jpg|png|webp)$/.test(mimetype)) type = 'image';
  else if (a.file_type === 'video' && mimetype === 'video/mp4') type = 'video';
  else if (a.file_type === 'audio') type = 'audio';
  return { type, data: res.data, fileName, mimetype };
}

async function handleDeletion(ctx: Ctx, b: Bridge, p: CwWebhook): Promise<HandlerResult> {
  const refs = { cwMessageId: p.id };
  if (!p.id) return { status: 'ignored', type: 'message.deleted', reason: 'no message id' };
  const links = await ctx.db
    .selectFrom('message_links')
    .selectAll()
    .where('connection_id', '=', b.row.id)
    .where('cw_message_id', '=', p.id)
    .execute();
  // Only messages EvoBridge sent can be deleted for everyone; deleting a customer's message in
  // Chatwoot can't remove it from their phone.
  const ours = links.filter((l) => l.origin === 'cw_to_wa' && l.wa_status !== 'pending' && l.wa_status !== 'failed');
  if (!ours.length) return { status: 'ignored', type: 'message.deleted', reason: 'not a message EvoBridge sent to WhatsApp', refs };
  for (const link of ours) {
    try {
      await b.evo.deleteForEveryone(b.instanceToken, link.wa_chat_jid, link.wa_message_id);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'client_error') continue;
      throw err;
    }
  }
  return { status: 'processed', type: 'message.deleted', refs: { ...refs, waMessageId: ours.map((l) => l.wa_message_id).join(',') } };
}

/** Called when an outgoing job is given up on, so the agent sees the failure in Chatwoot. */
export async function markChatwootFailed(b: Bridge, p: CwWebhook, error: string): Promise<void> {
  if (!p.id || !p.conversation?.id) return;
  await b.cw.updateMessageStatus(b.accountId, p.conversation.id, p.id, 'failed', error).catch(() => undefined);
}
