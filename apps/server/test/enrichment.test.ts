import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeInstance } from './mocks/evolution-go.js';
import { type Stack, connect, settle, startStack, waitFor } from './harness.js';

const LID = '228428003442925@lid';

/** A LID-only incoming message exactly as the real Evolution Go sent it: no phone, no PushName. */
function lidOnly(inst: FakeInstance, id: string, text: string, extra: Record<string, string> = {}) {
  return {
    event: 'Message',
    data: {
      Info: { AddressingMode: '', Chat: LID, Sender: LID, SenderAlt: '', RecipientAlt: '', IsFromMe: false, IsGroup: false, ID: id, PushName: '', Type: '', Timestamp: new Date().toISOString(), ...extra },
      Message: { conversation: text },
    },
    instanceId: inst.id,
    instanceToken: inst.token,
    instanceName: inst.name,
  };
}

describe('contact enrichment and connection notices', () => {
  let s: Stack;
  let inst: FakeInstance;
  let connectionId: string;

  beforeAll(async () => {
    s = await startStack();
    const res = await connect(s);
    inst = res.inst;
    connectionId = res.connection.id;
  });
  afterAll(async () => {
    await s.close();
  });

  const systemConversation = () => {
    const contact = s.cw.contacts.find((c) => c.name === 'EvoBridge')!;
    return s.cw.conversations.find((c) => c.contact_id === contact?.id);
  };

  it('posts a private "connected" note in the account language after setup', async () => {
    const conv = await waitFor(() => systemConversation());
    const notes = s.cw.messages.filter((m) => m.conversation_id === conv.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ private: true, message_type: 'outgoing' });
    expect(notes[0]!.content).toMatch(/WhatsApp conectado \(\+5511900000001\), instância shop/);
  });

  it('names a LID-only contact from the instance contact store and sets its photo', async () => {
    s.evo.contacts.push({ Jid: LID, PushName: 'Maria Souza', Found: true });
    s.evo.avatars.set(LID, 'https://pps.whatsapp.net/v/maria.jpg');
    await s.evo.emit(inst, lidOnly(inst, 'L1', 'Olá'));
    await settle(s);
    const contact = s.cw.contacts.find((c) => c.identifier === LID)!;
    expect(contact).toMatchObject({ name: 'Maria Souza', phone_number: null, avatar_url: 'https://pps.whatsapp.net/v/maria.jpg' });
  });

  it('keeps a placeholder when nothing is known, then fills name and phone when WhatsApp reveals them', async () => {
    const other = '111111111111111@lid';
    const body = lidOnly(inst, 'L2', 'oi');
    body.data.Info.Chat = other;
    body.data.Info.Sender = other;
    await s.evo.emit(inst, body);
    await settle(s);
    const contact = s.cw.contacts.find((c) => c.identifier === other)!;
    expect(contact.name).toBe('WhatsApp 111111');

    // Later Evolution Go delivers the same person with the phone (LID swap) and a profile name.
    await s.evo.emit(inst, s.evo.incomingText(inst, { id: 'L3', from: '5531988887777', text: 'sou eu', lid: other, pushName: 'João Lima' }));
    await settle(s);
    expect(contact).toMatchObject({ name: 'João Lima', phone_number: '+5531988887777' });
    // Same contact and conversation, not a duplicate.
    expect(s.cw.contacts.filter((c) => c.name === 'João Lima')).toHaveLength(1);
    const convs = s.cw.conversations.filter((c) => c.contact_id === contact.id);
    expect(convs).toHaveLength(1);
    expect(s.cw.messages.filter((m) => m.conversation_id === convs[0]!.id && m.source_id?.startsWith('WAID:L'))).toHaveLength(2);
  });

  it('notifies logouts once and reconnections once', async () => {
    const conv = systemConversation()!;
    const count = () => s.cw.messages.filter((m) => m.conversation_id === conv.id).length;
    const ev = (event: string) => ({ event, data: {}, instanceId: inst.id, instanceToken: inst.token, instanceName: inst.name });
    await s.evo.emit(inst, ev('LoggedOut'));
    await settle(s);
    expect(count()).toBe(2);
    expect(s.cw.messages.filter((m) => m.conversation_id === conv.id).at(-1)!.content).toMatch(/deslogado/);
    await s.evo.emit(inst, ev('Disconnected'));
    await settle(s);
    expect(count()).toBe(2);
    await s.evo.emit(inst, ev('Connected'));
    await s.evo.emit(inst, { ...ev('Connected'), data: { status: 'open', jid: 'x' } });
    await settle(s);
    expect(count()).toBe(3);
    expect(s.cw.messages.filter((m) => m.conversation_id === conv.id).at(-1)!.content).toMatch(/reconectado/);
  });

  it('never sends replies typed in the notices conversation to WhatsApp', async () => {
    const before = s.evo.sent.length;
    await s.cw.agentReply(systemConversation()!.id, 'testing');
    await settle(s);
    expect(s.evo.sent.length).toBe(before);
  });

  it('can turn notices off per connection', async () => {
    await s.api.patch(`/api/connections/${connectionId}`, { options: { connectionNotices: false } });
    const conv = systemConversation()!;
    const before = s.cw.messages.filter((m) => m.conversation_id === conv.id).length;
    await s.evo.emit(inst, { event: 'LoggedOut', data: {}, instanceId: inst.id, instanceToken: inst.token, instanceName: inst.name });
    await settle(s);
    expect(s.cw.messages.filter((m) => m.conversation_id === conv.id).length).toBe(before);
  });
});
