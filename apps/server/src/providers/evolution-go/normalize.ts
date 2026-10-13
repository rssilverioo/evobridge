import type { EvoMessageData, EvoReceiptData, EvoWebhook, WaContextInfo, WaMessage } from './types.js';

export type WaContentKind = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'unsupported';

export interface WaContent {
  kind: WaContentKind;
  /** Text body, or caption for media. */
  text: string;
  fileName?: string;
  mimetype?: string;
  ptt?: boolean;
  /** Inline media from Evolution Go (WEBHOOK_FILES): raw base64 or a presigned URL. */
  inline?: { base64?: string; url?: string; mimetype?: string };
  /** The raw protobuf message, kept so media can be downloaded through /message/downloadmedia. */
  raw?: WaMessage;
  /** Human label for types EvoBridge can't render natively. */
  label?: string;
}

/** A chat address after resolving LID vs phone number. */
export interface WaChatRef {
  /** Key used to group a chat: phone JID when known, otherwise the @lid, or the @g.us group. */
  chatJid: string;
  phone: string | null;
  lid: string | null;
  isGroup: boolean;
}

export type WaEvent =
  | {
      type: 'message';
      id: string;
      fromMe: boolean;
      /** Sent through the Evolution Go API (SendMessage event), not typed on the phone. */
      viaApi: boolean;
      chat: WaChatRef;
      /** Group participant that sent it (groups only). */
      participant: { jid: string; phone: string | null } | null;
      pushName: string | null;
      timestamp: string | null;
      content: WaContent;
      quotedId: string | null;
      forwarded: boolean;
    }
  | { type: 'revoke'; id: string; targetId: string; chat: WaChatRef; fromMe: boolean }
  | { type: 'edit'; id: string; targetId: string; chat: WaChatRef; fromMe: boolean; text: string }
  | { type: 'reaction'; id: string; targetId: string; chat: WaChatRef; fromMe: boolean; emoji: string }
  | { type: 'receipt'; chatJid: string; messageIds: string[]; state: 'delivered' | 'read' }
  | { type: 'connection'; event: string; detail: string | null }
  | { type: 'ignored'; reason: string };

const PN_SUFFIX = '@s.whatsapp.net';

/** "5511999999999:12@s.whatsapp.net" -> "5511999999999@s.whatsapp.net" */
export function stripDevice(jid: string | undefined | null): string {
  if (!jid) return '';
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0] ?? '';
  return `${user}${jid.slice(at)}`;
}

export const isPn = (jid: string) => jid.endsWith(PN_SUFFIX);
export const isLid = (jid: string) => jid.endsWith('@lid');
export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
export const phoneOf = (jid: string) => (isPn(jid) ? jid.slice(0, -PN_SUFFIX.length) : null);

/**
 * Resolves the chat counterpart. Evolution Go swaps LID/PN for incoming DMs (Chat becomes the
 * phone JID), but not for messages sent from the phone: there Chat may stay `@lid` and the phone
 * comes in RecipientAlt. A phone number is never invented when the payload doesn't carry one.
 */
export function resolveChat(info: EvoMessageData['Info']): WaChatRef {
  const chat = stripDevice(info.Chat);
  if (info.IsGroup || isGroupJid(chat)) return { chatJid: chat, phone: null, lid: null, isGroup: true };

  const alt = stripDevice(info.IsFromMe ? info.RecipientAlt || info.DeviceSentMeta?.DestinationJID : info.SenderAlt);
  let pn: string | null = isPn(chat) ? chat : null;
  let lid: string | null = isLid(chat) ? chat : null;
  if (alt && isPn(alt) && !pn) pn = alt;
  if (alt && isLid(alt) && !lid) lid = alt;
  if (!pn && !info.IsFromMe) {
    const sender = stripDevice(info.Sender);
    if (isPn(sender)) pn = sender;
  }
  return { chatJid: pn ?? lid ?? chat, phone: pn ? phoneOf(pn) : null, lid, isGroup: false };
}

/** Peels wrappers WhatsApp nests content in. */
export function unwrap(msg: WaMessage | undefined): WaMessage {
  let m: WaMessage = msg ?? {};
  for (let i = 0; i < 5; i++) {
    const inner =
      m.ephemeralMessage?.message ??
      m.viewOnceMessage?.message ??
      m.viewOnceMessageV2?.message ??
      m.viewOnceMessageV2Extension?.message ??
      m.documentWithCaptionMessage?.message ??
      m.editedMessage?.message;
    if (!inner) break;
    // Evolution Go injects base64/mediaUrl/mimetype at the outer level; keep them.
    m = { ...inner, base64: m.base64 ?? inner.base64, mediaUrl: m.mediaUrl ?? inner.mediaUrl, mimetype: m.mimetype ?? inner.mimetype };
  }
  return m;
}

function contextOf(m: WaMessage): WaContextInfo | undefined {
  return (
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.audioMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.stickerMessage?.contextInfo
  );
}

export function extractContent(msg: WaMessage | undefined): WaContent {
  const m = unwrap(msg);
  const inline = m.base64 || m.mediaUrl ? { base64: m.base64, url: m.mediaUrl, mimetype: m.mimetype } : undefined;

  if (typeof m.conversation === 'string') return { kind: 'text', text: m.conversation };
  if (m.extendedTextMessage) return { kind: 'text', text: m.extendedTextMessage.text ?? '' };
  if (m.imageMessage) return { kind: 'image', text: m.imageMessage.caption ?? '', mimetype: m.imageMessage.mimetype, inline, raw: m };
  if (m.videoMessage) return { kind: 'video', text: m.videoMessage.caption ?? '', mimetype: m.videoMessage.mimetype, inline, raw: m };
  if (m.audioMessage) return { kind: 'audio', text: '', mimetype: m.audioMessage.mimetype, ptt: Boolean(m.audioMessage.PTT), inline, raw: m };
  if (m.documentMessage) {
    return {
      kind: 'document',
      text: m.documentMessage.caption ?? '',
      fileName: m.documentMessage.fileName ?? m.documentMessage.title ?? undefined,
      mimetype: m.documentMessage.mimetype,
      inline,
      raw: m,
    };
  }
  if (m.stickerMessage) return { kind: 'sticker', text: '', mimetype: m.stickerMessage.mimetype, inline, raw: m };
  const loc = m.locationMessage ?? m.liveLocationMessage;
  if (loc && loc.degreesLatitude !== undefined && loc.degreesLongitude !== undefined) {
    const name = 'name' in loc && loc.name ? `${loc.name}\n` : '';
    return { kind: 'location', text: `${name}https://maps.google.com/?q=${loc.degreesLatitude},${loc.degreesLongitude}` };
  }
  if (m.contactMessage) return { kind: 'contact', text: formatVcard(m.contactMessage.displayName, m.contactMessage.vcard) };
  if (m.contactsArrayMessage?.contacts?.length) {
    return { kind: 'contact', text: m.contactsArrayMessage.contacts.map((c) => formatVcard(c.displayName, c.vcard)).join('\n\n') };
  }
  const reply = m.buttonsResponseMessage?.selectedDisplayText ?? m.listResponseMessage?.title ?? m.templateButtonReplyMessage?.selectedDisplayText;
  if (reply) return { kind: 'text', text: reply };
  const poll = m.pollCreationMessage ?? m.pollCreationMessageV3;
  if (poll) {
    const options = (poll.options ?? []).map((o) => `• ${o.optionName ?? ''}`).join('\n');
    return { kind: 'unsupported', text: `📊 ${poll.name ?? 'Poll'}\n${options}`, label: 'poll' };
  }
  return { kind: 'unsupported', text: '', label: Object.keys(m).filter((k) => !['base64', 'mediaUrl', 'mimetype', 'messageContextInfo'].includes(k))[0] ?? 'unknown' };
}

function formatVcard(name: string | undefined, vcard: string | undefined): string {
  const phones = [...(vcard ?? '').matchAll(/TEL[^:]*:([^\n\r]+)/gi)].map((m) => m[1]?.trim()).filter(Boolean);
  return `👤 ${name ?? 'Contact'}${phones.length ? `\n${phones.join('\n')}` : ''}`;
}

/** Turns an Evolution Go webhook body into one event EvoBridge understands. */
export function normalizeEvolutionEvent(body: EvoWebhook): WaEvent {
  const event = body.event;
  if (event === 'Message' || event === 'SendMessage') {
    const data = body.data as EvoMessageData | undefined;
    if (!data?.Info?.ID) return { type: 'ignored', reason: 'message without id' };
    if (data.UnavailableType) return { type: 'ignored', reason: `undecryptable ${data.UnavailableType}` };
    const info = data.Info;
    // Checked on the raw Chat: status posts carry the poster as Sender, which would otherwise
    // look like a 1:1 chat with them.
    if (/@(broadcast|newsletter)$/.test(info.Chat ?? '')) return { type: 'ignored', reason: 'status or newsletter' };
    const chat = resolveChat(info);
    const fromMe = Boolean(info.IsFromMe);
    const m = data.Message ?? {};

    const proto = m.protocolMessage;
    if (proto?.type === 0 && proto.key?.ID) return { type: 'revoke', id: info.ID, targetId: proto.key.ID, chat, fromMe };
    if ((proto?.type === 14 || data.IsEdit) && proto?.key?.ID) {
      const text = extractContent(proto.editedMessage).text;
      return { type: 'edit', id: info.ID, targetId: proto.key.ID, chat, fromMe, text };
    }
    if (proto) return { type: 'ignored', reason: `protocol message type ${proto.type ?? '?'}` };
    if (m.reactionMessage?.key?.ID) {
      return { type: 'reaction', id: info.ID, targetId: m.reactionMessage.key.ID, chat, fromMe, emoji: m.reactionMessage.text ?? '' };
    }

    const content = extractContent(m);
    const ctxInfo = contextOf(unwrap(m));
    const quotedId = data.quoted?.stanzaID || ctxInfo?.stanzaID || null;
    let participant: { jid: string; phone: string | null } | null = null;
    if (chat.isGroup) {
      const sender = stripDevice(info.Sender);
      participant = { jid: sender, phone: phoneOf(sender) };
    }
    return {
      type: 'message',
      id: info.ID,
      fromMe,
      viaApi: event === 'SendMessage',
      chat,
      participant,
      pushName: info.PushName || null,
      timestamp: info.Timestamp ?? null,
      content,
      quotedId,
      forwarded: Boolean(ctxInfo?.isForwarded),
    };
  }

  if (event === 'Receipt') {
    const data = body.data as EvoReceiptData | undefined;
    const state = (body.state ?? '').toLowerCase();
    if (!data?.MessageIDs?.length || (state !== 'delivered' && state !== 'read')) return { type: 'ignored', reason: `receipt ${state || 'unknown'}` };
    return { type: 'receipt', chatJid: stripDevice(data.Chat), messageIds: data.MessageIDs, state };
  }

  if (['Connected', 'Disconnected', 'LoggedOut', 'ConnectFailure', 'TemporaryBan', 'PairSuccess'].includes(event)) {
    const d = (body.data ?? {}) as { reason?: string; status?: string };
    return { type: 'connection', event, detail: d.reason ?? d.status ?? null };
  }

  return { type: 'ignored', reason: `event ${event}` };
}
