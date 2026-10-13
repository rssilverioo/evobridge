import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeInstance } from './mocks/evolution-go.js';
import { type Stack, connect, settle, startStack, waitFor } from './harness.js';

const PHONE = '5511987654321';
const LID = '123456789012345@lid';

describe('message bridge', () => {
  let s: Stack;
  let inst: FakeInstance;
  let connectionId: string;
  let inboxId: number;

  beforeAll(async () => {
    s = await startStack();
    const res = await connect(s);
    inst = res.inst;
    connectionId = res.connection.id;
    inboxId = s.cw.inboxes.find((i) => i.name === 'WhatsApp')!.id;
  });
  afterAll(async () => {
    await s.close();
  });
  beforeEach(() => {
    s.evo.failSends = 0;
  });

  const incoming = (id: string, text: string, extra: Partial<Parameters<typeof s.evo.incomingText>[1]> = {}) =>
    s.evo.emit(inst, s.evo.incomingText(inst, { id, from: PHONE, text, lid: LID, ...extra }));
  const cwMessages = () => s.cw.messages.filter((m) => !m.deleted);
  const conversationFor = () => s.cw.conversations.find((c) => c.inbox_id === inboxId)!;

  it('delivers an incoming WhatsApp message into Chatwoot', async () => {
    expect(await incoming('MSG1', 'Oi, *tudo bem*?')).toBe(200);
    await settle(s);
    const contact = s.cw.contacts.find((c) => c.phone_number === `+${PHONE}`)!;
    expect(contact.name).toBe('Maria');
    expect(s.cw.contactInboxes.find((ci) => ci.contact_id === contact.id)!.source_id).toBe(PHONE);
    const msg = cwMessages().find((m) => m.source_id === 'WAID:MSG1')!;
    expect(msg).toMatchObject({ message_type: 'incoming', content: 'Oi, **tudo bem**?' });
  });

  it('ignores duplicate deliveries of the same event', async () => {
    await incoming('MSG1', 'Oi, *tudo bem*?');
    await incoming('MSG1', 'Oi, *tudo bem*?');
    await settle(s);
    expect(cwMessages().filter((m) => m.source_id === 'WAID:MSG1')).toHaveLength(1);
  });

  it('acknowledges Chatwoot webhooks immediately and ignores its own copies', async () => {
    // Every bridge-created message comes back as message_created; all must be answered 2xx.
    expect(s.cw.deliveries.length).toBeGreaterThan(0);
    expect(s.cw.deliveries.every((d) => d.status === 200)).toBe(true);
    expect(s.evo.sent).toHaveLength(0);
  });

  it('sends an agent reply to WhatsApp without echoing it back', async () => {
    const conv = conversationFor();
    const before = cwMessages().length;
    await s.cw.agentReply(conv.id, 'Tudo **ótimo**!');
    await settle(s);
    expect(s.evo.sent).toHaveLength(1);
    const sent = s.evo.sent[0]!;
    expect(sent).toMatchObject({ route: 'text', number: `${PHONE}@s.whatsapp.net`, text: '*Ana:*\nTudo *ótimo*!' });
    expect(sent.id).toMatch(/^3EB0[0-9A-F]{18}$/);
    // The SendMessage echo was fired before /send/text answered; it must not reach Chatwoot.
    await settle(s);
    expect(cwMessages().length).toBe(before + 1);
    const link = await s.rt.ctx.db.selectFrom('message_links').selectAll().where('wa_message_id', '=', sent.id).executeTakeFirstOrThrow();
    expect(link).toMatchObject({ origin: 'cw_to_wa', wa_status: 'sent' });
  });

  it('never sends private notes', async () => {
    await s.cw.agentReply(conversationFor().id, 'internal: VIP customer', { private: true });
    await settle(s);
    expect(s.evo.sent).toHaveLength(1);
  });

  it('mirrors messages typed on the phone as outgoing, without sending them again', async () => {
    const body = s.evo.incomingText(inst, { id: 'PHONE1', from: PHONE, text: 'Mandei pelo celular' });
    body.data.Info.IsFromMe = true;
    body.data.Info.Chat = LID; // phone-sent DMs in LID chats keep the @lid
    body.data.Info.Sender = inst.jid;
    body.data.Info.RecipientAlt = `${PHONE}@s.whatsapp.net`;
    await s.evo.emit(inst, body);
    await settle(s);
    const msg = cwMessages().find((m) => m.source_id === 'WAID:PHONE1')!;
    expect(msg.message_type).toBe('outgoing');
    expect(msg.conversation_id).toBe(conversationFor().id);
    expect(s.evo.sent).toHaveLength(1);
    expect(s.cw.contacts.filter((c) => c.phone_number === `+${PHONE}`)).toHaveLength(1);
  });

  it('maps replies in both directions', async () => {
    await incoming('MSG2', 'respondendo', { quotedId: s.evo.sent[0]!.id });
    await settle(s);
    const reply = cwMessages().find((m) => m.source_id === 'WAID:MSG2')!;
    expect(reply.content_attributes.in_reply_to_external_id).toBe(`WAID:${s.evo.sent[0]!.id}`);

    const original = cwMessages().find((m) => m.source_id === 'WAID:MSG1')!;
    await s.cw.agentReply(conversationFor().id, 'sobre isso', { inReplyTo: original.id });
    await settle(s);
    const sent = s.evo.sent.at(-1)!;
    expect(sent.quoted).toEqual({ messageId: 'MSG1', participant: `${PHONE}@s.whatsapp.net` });
  });

  it('turns WhatsApp receipts into Chatwoot statuses, forward only', async () => {
    const sent = s.evo.sent[0]!;
    const receipt = (state: string) => ({
      event: 'Receipt',
      state,
      data: { Chat: `${PHONE}@s.whatsapp.net`, Sender: `${PHONE}@s.whatsapp.net`, IsFromMe: false, IsGroup: false, MessageIDs: [sent.id] },
      instanceId: inst.id,
      instanceToken: inst.token,
      instanceName: inst.name,
    });
    await s.evo.emit(inst, receipt('Read'));
    await settle(s);
    await s.evo.emit(inst, receipt('Delivered'));
    await settle(s);
    const link = await s.rt.ctx.db.selectFrom('message_links').selectAll().where('wa_message_id', '=', sent.id).executeTakeFirstOrThrow();
    const cwMsg = s.cw.messages.find((m) => m.id === link.cw_message_id)!;
    expect(cwMsg.status).toBe('read');
  });

  it('relays incoming media as a Chatwoot attachment', async () => {
    const body = s.evo.incomingText(inst, { id: 'IMG1', from: PHONE, text: '' });
    body.data.Message = { imageMessage: { caption: 'foto', mimetype: 'image/jpeg' }, base64: Buffer.from('fake-jpeg-bytes').toString('base64'), mimetype: 'image/jpeg' } as never;
    body.data.Info.Type = 'media';
    await s.evo.emit(inst, body);
    await settle(s);
    const msg = cwMessages().find((m) => m.source_id === 'WAID:IMG1')!;
    expect(msg.content).toBe('foto');
    expect(msg.attachments[0]).toMatchObject({ content_type: 'image/jpeg', size: 15 });
  });

  it('falls back to Evolution Go download, then to a placeholder, never dropping media', async () => {
    const withUrl = s.evo.incomingText(inst, { id: 'IMG2', from: PHONE, text: '' });
    withUrl.data.Message = { imageMessage: { URL: 'https://mmg.whatsapp.net/x', mimetype: 'image/jpeg' } } as never;
    s.evo.media.set('https://mmg.whatsapp.net/x', { mimetype: 'image/jpeg', base64: Buffer.from('downloaded').toString('base64') });
    await s.evo.emit(inst, withUrl);
    const missing = s.evo.incomingText(inst, { id: 'IMG3', from: PHONE, text: '' });
    missing.data.Message = { imageMessage: { URL: 'https://mmg.whatsapp.net/gone', mimetype: 'image/jpeg', caption: 'perdida' } } as never;
    await s.evo.emit(inst, missing);
    await settle(s, 15000);
    expect(cwMessages().find((m) => m.source_id === 'WAID:IMG2')!.attachments[0]!.size).toBe(10);
    const placeholder = cwMessages().find((m) => m.source_id === 'WAID:IMG3')!;
    expect(placeholder.attachments).toHaveLength(0);
    expect(placeholder.content).toMatch(/could not be downloaded/);
    expect(placeholder.content).toMatch(/perdida/);
  });

  it('sends agent attachments to WhatsApp as media with the exact caption', async () => {
    await s.cw.agentReply(conversationFor().id, 'segue o catálogo', { attachment: { data: Buffer.from('%PDF-1.4 fake'), mimetype: 'application/pdf', name: 'catalogo.pdf' } });
    await settle(s);
    const sent = s.evo.sent.at(-1)!;
    expect(sent).toMatchObject({ route: 'media', type: 'document', fileName: 'catalogo.pdf', caption: '*Ana:*\nsegue o catálogo', size: 13 });
  });

  it('retries transient failures with backoff', async () => {
    s.evo.failSends = 2;
    const before = s.evo.sent.length;
    await s.cw.agentReply(conversationFor().id, 'tentativa');
    await settle(s, 15000);
    expect(s.evo.sent.length).toBe(before + 1);
    const ev = await s.rt.ctx.db.selectFrom('events').selectAll().where('type', '=', 'message.outgoing').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(ev.status).toBe('processed');
    expect(ev.attempts).toBe(3);
  });

  it('dead-letters after max attempts, marks the Chatwoot message failed, and can replay', async () => {
    s.evo.failSends = 1000;
    const msg = await s.cw.agentReply(conversationFor().id, 'vai falhar');
    await settle(s, 20000);
    const job = await waitFor(() => s.rt.ctx.db.selectFrom('jobs').selectAll().where('status', '=', 'dead').executeTakeFirst());
    expect(job.attempts).toBe(10);
    await waitFor(() => s.cw.messages.find((m) => m.id === msg.id)!.status === 'failed');

    s.evo.failSends = 0;
    const ev = await s.rt.ctx.db.selectFrom('events').select('id').where('job_id', '=', job.id).executeTakeFirstOrThrow();
    const replay = await s.api.post(`/api/events/${ev.id}/replay`);
    expect(replay.status).toBe(200);
    await settle(s);
    expect(s.evo.sent.at(-1)!.text).toBe('*Ana:*\nvai falhar');
  });

  it('deletes for everyone when an agent deletes their message', async () => {
    const reply = await s.cw.agentReply(conversationFor().id, 'oops');
    await settle(s);
    const waId = s.evo.sent.at(-1)!.id;
    await s.cw.agentDelete(reply.id);
    await settle(s);
    expect(s.evo.deleted).toContainEqual({ chat: `${PHONE}@s.whatsapp.net`, messageId: waId });
  });

  it('deletes the Chatwoot copy when the customer revokes a message', async () => {
    await incoming('MSG9', 'mensagem errada');
    await settle(s);
    const revoke = s.evo.incomingText(inst, { id: 'REV1', from: PHONE, text: '' });
    revoke.data.Message = { protocolMessage: { type: 0, key: { ID: 'MSG9' } } } as never;
    revoke.data.Info.Edit = '7';
    await s.evo.emit(inst, revoke);
    await settle(s);
    expect(s.cw.messages.find((m) => m.source_id === 'WAID:MSG9')!.deleted).toBe(true);
  });

  it('keeps a burst from one contact in order, in one conversation', async () => {
    const other = '5521912345678';
    await Promise.all(Array.from({ length: 15 }, (_, i) => s.evo.emit(inst, s.evo.incomingText(inst, { id: `BURST${i}`, from: other, text: `m${i}`, pushName: 'João' }))));
    await settle(s, 15000);
    expect(s.cw.contacts.filter((c) => c.phone_number === `+${other}`)).toHaveLength(1);
    const contact = s.cw.contacts.find((c) => c.phone_number === `+${other}`)!;
    expect(s.cw.conversations.filter((c) => c.contact_id === contact.id)).toHaveLength(1);
    expect(cwMessages().filter((m) => m.source_id?.startsWith('WAID:BURST'))).toHaveLength(15);
  });

  it('reuses a contact that already exists in another inbox (Brazilian 9th digit included)', async () => {
    const existing = s.cw.addContact('+5531987654321', 'Cliente antigo');
    await s.evo.emit(inst, s.evo.incomingText(inst, { id: 'OLD1', from: '553187654321', text: 'oi de novo' }));
    await settle(s);
    expect(s.cw.contacts.filter((c) => c.phone_number?.includes('87654321') && c.phone_number?.startsWith('+5531'))).toHaveLength(1);
    expect(s.cw.contactInboxes.some((ci) => ci.contact_id === existing.id && ci.inbox_id === inboxId)).toBe(true);
  });

  it('rejects forged webhooks', async () => {
    const goodEvo = inst.webhook;
    const wrongSecret = goodEvo.replace(/[^/]+$/, 'not-the-secret');
    expect((await fetch(wrongSecret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"Message"}' })).status).toBe(404);
    const otherInstance = { ...s.evo.incomingText(inst, { id: 'X', from: PHONE, text: 'x' }), instanceToken: 'someone-else' };
    expect((await fetch(goodEvo, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otherInstance) })).status).toBe(403);
    const inbox = s.cw.inboxes.find((i) => i.id === inboxId)!;
    const unsigned = await fetch(inbox.webhook_url!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'message_created', id: 1 }) });
    expect(unsigned.status).toBe(401);
  });

  it('ignores traffic while paused and resumes cleanly', async () => {
    await s.api.post(`/api/connections/${connectionId}/pause`);
    await incoming('PAUSED1', 'durante a pausa');
    await settle(s);
    expect(cwMessages().some((m) => m.source_id === 'WAID:PAUSED1')).toBe(false);
    const resumed = await s.api.post(`/api/connections/${connectionId}/resume`);
    expect(resumed.body.state).toBe('connected');
    await incoming('AFTER1', 'depois');
    await settle(s);
    expect(cwMessages().some((m) => m.source_id === 'WAID:AFTER1')).toBe(true);
  });

  it('keeps configuration and pending work across a restart', async () => {
    await s.restart();
    const conns = await s.api.get('/api/connections');
    expect(conns.status).toBe(200); // session survived too
    expect(conns.body[0].id).toBe(connectionId);
    await incoming('RESTART1', 'depois do restart');
    await settle(s);
    expect(cwMessages().some((m) => m.source_id === 'WAID:RESTART1')).toBe(true);
  });

  it('records events without message content by default', async () => {
    const page = await s.api.get(`/api/events?connectionId=${connectionId}&limit=200`);
    expect(page.body.items.length).toBeGreaterThan(10);
    expect(JSON.stringify(page.body)).not.toContain('tudo bem');
    expect(JSON.stringify(page.body)).not.toContain(inst.token);
    const overview = await s.api.get('/api/overview');
    expect(overview.body.connections).toMatchObject({ total: 1, active: 1 });
    expect(overview.body.messages.processed24h).toBeGreaterThan(10);
  });
});
