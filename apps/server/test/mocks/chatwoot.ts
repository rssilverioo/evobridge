import { createHmac } from 'node:crypto';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * In-memory Chatwoot 4.18 Application API, limited to what EvoBridge uses. Shapes and
 * validation rules follow docs/research/chatwoot.md.
 */
interface Inbox {
  id: number;
  account_id: number;
  name: string;
  channel_type: string;
  webhook_url: string | null;
  secret: string;
}
interface Contact {
  id: number;
  account_id: number;
  name: string;
  phone_number: string | null;
  identifier: string | null;
}
interface ContactInbox {
  contact_id: number;
  inbox_id: number;
  source_id: string;
}
interface Conversation {
  id: number;
  account_id: number;
  inbox_id: number;
  contact_id: number;
  source_id: string;
  status: 'open' | 'resolved' | 'pending';
}
export interface FakeMessage {
  id: number;
  conversation_id: number;
  content: string;
  message_type: 'incoming' | 'outgoing' | 'template';
  private: boolean;
  source_id: string | null;
  status: string;
  content_attributes: Record<string, unknown>;
  attachments: Array<{ id: number; file_type: string; content_type: string; file_name: string; size: number }>;
  deleted?: boolean;
}

export class FakeChatwoot {
  app: FastifyInstance;
  url = '';
  tokens: Record<string, { name: string; role: 'administrator' | 'agent' }> = { 'admin-token': { name: 'Ana Admin', role: 'administrator' } };
  accountId = 1;
  inboxes: Inbox[] = [];
  contacts: Contact[] = [];
  contactInboxes: ContactInbox[] = [];
  conversations: Conversation[] = [];
  messages: FakeMessage[] = [];
  files = new Map<number, { data: Buffer; mimetype: string; name: string }>();
  /** Webhook deliveries Chatwoot made, with the HTTP status EvoBridge answered. */
  deliveries: Array<{ url: string; status: number; event: string }> = [];
  signWebhooks = true;
  private seq = 100;

  constructor() {
    this.app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024 });
    void this.app.register(multipart, { limits: { fileSize: 60 * 1024 * 1024 } });
    this.routes();
  }

  async start(port = 0): Promise<string> {
    this.url = await this.app.listen({ port, host: '127.0.0.1' });
    return this.url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  private next() {
    return ++this.seq;
  }

  addInbox(name: string, channelType = 'Channel::Api', webhookUrl: string | null = null): Inbox {
    const inbox = { id: this.next(), account_id: this.accountId, name, channel_type: channelType, webhook_url: webhookUrl, secret: `secret-${name}` };
    this.inboxes.push(inbox);
    return inbox;
  }

  addContact(phone: string | null, name = 'Existing', identifier: string | null = null): Contact {
    const c = { id: this.next(), account_id: this.accountId, name, phone_number: phone, identifier };
    this.contacts.push(c);
    return c;
  }

  private auth(req: FastifyRequest, reply: FastifyReply) {
    const user = this.tokens[req.headers.api_access_token as string];
    if (!user) {
      void reply.code(401).send({ errors: ['Invalid Access Token'] });
      return null;
    }
    return user;
  }

  private adminOnly(req: FastifyRequest, reply: FastifyReply) {
    const user = this.auth(req, reply);
    if (!user) return null;
    if (user.role !== 'administrator') {
      void reply.code(401).send({ error: 'You are not authorized to do this action' });
      return null;
    }
    return user;
  }

  private inboxJson(i: Inbox, admin: boolean) {
    return { id: i.id, name: i.name, channel_type: i.channel_type, webhook_url: i.webhook_url, inbox_identifier: `ident-${i.id}`, ...(admin ? { secret: i.secret } : {}) };
  }

  private conversationJson(c: Conversation) {
    return { id: c.id, inbox_id: c.inbox_id, status: c.status, account_id: c.account_id, meta: { sender: { id: c.contact_id } } };
  }

  private routes() {
    const app = this.app;
    const base = '/api/v1/accounts/:accountId';

    app.get('/api/v1/profile', async (req, reply) => {
      const user = this.auth(req, reply);
      if (!user) return reply;
      return { id: 1, name: user.name, email: 'ana@example.com', role: user.role, accounts: [{ id: this.accountId, name: 'Acme', status: 'active', role: user.role }] };
    });

    app.get(`${base}/inboxes`, async (req, reply) => {
      const user = this.auth(req, reply);
      if (!user) return reply;
      return { payload: this.inboxes.map((i) => this.inboxJson(i, user.role === 'administrator')) };
    });
    app.get<{ Params: { id: string } }>(`${base}/inboxes/:id`, async (req, reply) => {
      const user = this.auth(req, reply);
      if (!user) return reply;
      const inbox = this.inboxes.find((i) => i.id === Number(req.params.id));
      if (!inbox) return reply.code(404).send({ error: 'Resource could not be found' });
      return this.inboxJson(inbox, user.role === 'administrator');
    });
    app.post<{ Body: { name: string; channel: { type: string; webhook_url?: string } } }>(`${base}/inboxes`, async (req, reply) => {
      if (!this.adminOnly(req, reply)) return reply;
      const inbox = this.addInbox(req.body.name, 'Channel::Api', req.body.channel.webhook_url ?? null);
      return this.inboxJson(inbox, true);
    });
    app.patch<{ Params: { id: string }; Body: { channel?: { webhook_url?: string } } }>(`${base}/inboxes/:id`, async (req, reply) => {
      if (!this.adminOnly(req, reply)) return reply;
      const inbox = this.inboxes.find((i) => i.id === Number(req.params.id));
      if (!inbox) return reply.code(404).send({ error: 'Resource could not be found' });
      if (req.body.channel?.webhook_url !== undefined) inbox.webhook_url = req.body.channel.webhook_url || null;
      return this.inboxJson(inbox, true);
    });

    app.post<{ Body: { inbox_id: number; source_id: string } }>(`${base}/contact_inboxes/filter`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const ci = this.contactInboxes.find((c) => c.inbox_id === req.body.inbox_id && c.source_id === req.body.source_id);
      if (!ci) return reply.code(404).send();
      const contact = this.contacts.find((c) => c.id === ci.contact_id)!;
      return { ...contact, contact_inboxes: this.contactInboxes.filter((x) => x.contact_id === contact.id).map((x) => ({ source_id: x.source_id, inbox: { id: x.inbox_id } })) };
    });
    app.post<{ Body: { payload: Array<{ attribute_key: string; values: string[] }> } }>(`${base}/contacts/filter`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const f = req.body.payload[0]!;
      const values = f.values.map((v) => (f.attribute_key === 'phone_number' ? `+${v.replace(/\D/g, '')}` : v.toLowerCase()));
      const found = this.contacts.filter((c) => (f.attribute_key === 'phone_number' ? values.includes(c.phone_number ?? '') : values.includes((c.identifier ?? '').toLowerCase())));
      return { meta: { count: found.length }, payload: found };
    });
    app.post<{ Body: { inbox_id: number; source_id?: string; name: string; phone_number?: string; identifier?: string } }>(`${base}/contacts`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const b = req.body;
      if (b.phone_number && !/^\+[1-9]\d{1,14}$/.test(b.phone_number)) return reply.code(422).send({ message: 'Phone number should be in e164 format', attributes: ['phone_number'] });
      if (b.phone_number && this.contacts.some((c) => c.phone_number === b.phone_number)) return reply.code(422).send({ message: 'Phone number has already been taken', attributes: ['phone_number'] });
      if (b.identifier && this.contacts.some((c) => c.identifier === b.identifier)) return reply.code(422).send({ message: 'Identifier has already been taken', attributes: ['identifier'] });
      const contact = this.addContact(b.phone_number ?? null, b.name, b.identifier ?? null);
      const sourceId = b.source_id ?? `uuid-${this.next()}`;
      this.contactInboxes.push({ contact_id: contact.id, inbox_id: b.inbox_id, source_id: sourceId });
      return { payload: { contact: { ...contact, contact_inboxes: [{ source_id: sourceId, inbox: { id: b.inbox_id } }] }, contact_inbox: { source_id: sourceId, inbox: { id: b.inbox_id } } } };
    });
    app.post<{ Params: { id: string }; Body: { inbox_id: number; source_id: string } }>(`${base}/contacts/:id/contact_inboxes`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const existing = this.contactInboxes.find((c) => c.contact_id === Number(req.params.id) && c.inbox_id === req.body.inbox_id && c.source_id === req.body.source_id);
      if (!existing) this.contactInboxes.push({ contact_id: Number(req.params.id), inbox_id: req.body.inbox_id, source_id: req.body.source_id });
      return { source_id: req.body.source_id, inbox: { id: req.body.inbox_id } };
    });
    app.get<{ Params: { id: string } }>(`${base}/contacts/:id/conversations`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      return { payload: this.conversations.filter((c) => c.contact_id === Number(req.params.id)).map((c) => this.conversationJson(c)) };
    });

    app.post<{ Body: { inbox_id: number; contact_id: number; source_id: string; status?: 'open' | 'pending' } }>(`${base}/conversations`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const conv: Conversation = { id: this.next(), account_id: this.accountId, inbox_id: req.body.inbox_id, contact_id: req.body.contact_id, source_id: req.body.source_id, status: req.body.status ?? 'open' };
      this.conversations.push(conv);
      return this.conversationJson(conv);
    });
    app.get<{ Params: { cid: string } }>(`${base}/conversations/:cid`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const conv = this.conversations.find((c) => c.id === Number(req.params.cid));
      if (!conv) return reply.code(404).send({ error: 'Resource could not be found' });
      return this.conversationJson(conv);
    });

    app.post<{ Params: { cid: string } }>(`${base}/conversations/:cid/messages`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const conv = this.conversations.find((c) => c.id === Number(req.params.cid));
      if (!conv) return reply.code(404).send({ error: 'Resource could not be found' });
      let fields: Record<string, unknown> = {};
      const attachments: FakeMessage['attachments'] = [];
      if (req.isMultipart()) {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            const data = await part.toBuffer();
            const id = this.next();
            this.files.set(id, { data, mimetype: part.mimetype, name: part.filename });
            attachments.push({ id, file_type: part.mimetype.startsWith('image/') ? 'image' : part.mimetype.startsWith('audio/') ? 'audio' : 'file', content_type: part.mimetype, file_name: part.filename, size: data.length });
          } else fields[part.fieldname] = part.value;
        }
        if (typeof fields.content_attributes === 'string') fields.content_attributes = JSON.parse(fields.content_attributes);
        fields.private = fields.private === 'true';
      } else fields = req.body as Record<string, unknown>;
      const msg: FakeMessage = {
        id: this.next(),
        conversation_id: conv.id,
        content: String(fields.content ?? ''),
        message_type: (fields.message_type as FakeMessage['message_type']) ?? 'outgoing',
        private: Boolean(fields.private),
        source_id: (fields.source_id as string) ?? null,
        status: 'sent',
        content_attributes: (fields.content_attributes as Record<string, unknown>) ?? {},
        attachments,
      };
      this.messages.push(msg);
      if (msg.message_type === 'incoming' && conv.status === 'resolved') conv.status = 'open';
      // Chatwoot fires message_created for everything, including what the bridge created.
      void this.deliver(conv, msg, 'message_created');
      return { id: msg.id, content: msg.content, conversation_id: conv.id, message_type: msg.message_type === 'incoming' ? 0 : 1, source_id: msg.source_id, status: 'sent' };
    });
    app.patch<{ Params: { cid: string; mid: string }; Body: { status: string } }>(`${base}/conversations/:cid/messages/:mid`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const msg = this.messages.find((m) => m.id === Number(req.params.mid));
      if (!msg) return reply.code(404).send({ error: 'Resource could not be found' });
      msg.status = req.body.status;
      return { id: msg.id, status: msg.status };
    });
    app.delete<{ Params: { cid: string; mid: string } }>(`${base}/conversations/:cid/messages/:mid`, async (req, reply) => {
      if (!this.auth(req, reply)) return reply;
      const msg = this.messages.find((m) => m.id === Number(req.params.mid));
      if (!msg) return reply.code(404).send({ error: 'Resource could not be found' });
      msg.deleted = true;
      msg.content = 'This message was deleted';
      return { id: msg.id };
    });

    app.get<{ Params: { id: string } }>('/rails/active_storage/blobs/redirect/:id/*', async (req, reply) => reply.redirect(`/storage/${req.params.id}`));
    app.get<{ Params: { id: string } }>('/storage/:id', async (req, reply) => {
      const f = this.files.get(Number(req.params.id));
      if (!f) return reply.code(404).send();
      return reply.header('content-type', f.mimetype).send(f.data);
    });
  }

  private payload(conv: Conversation, msg: FakeMessage, event: string, sender: Record<string, unknown> | null) {
    return {
      event,
      id: msg.id,
      content: msg.content,
      content_type: 'text',
      content_attributes: msg.deleted ? { deleted: true } : msg.content_attributes,
      message_type: msg.message_type,
      private: msg.private,
      source_id: msg.source_id,
      sender,
      inbox: { id: conv.inbox_id, name: 'inbox' },
      account: { id: conv.account_id, name: 'Acme' },
      conversation: { id: conv.id, inbox_id: conv.inbox_id, status: conv.status, contact_inbox: { source_id: conv.source_id }, meta: { sender: { id: conv.contact_id } } },
      ...(msg.attachments.length
        ? {
            attachments: msg.attachments.map((a) => ({
              id: a.id,
              file_type: a.file_type,
              content_type: a.content_type,
              file_size: a.size,
              data_url: `${this.url}/rails/active_storage/blobs/redirect/${a.id}/${encodeURIComponent(a.file_name)}`,
            })),
          }
        : {}),
      created_at: new Date().toISOString(),
    };
  }

  /** Signed delivery to the inbox webhook_url: one attempt, 5 s timeout, like Webhooks::Trigger. */
  async deliver(conv: Conversation, msg: FakeMessage, event: string, sender: Record<string, unknown> | null = null): Promise<number> {
    const inbox = this.inboxes.find((i) => i.id === conv.inbox_id);
    if (!inbox?.webhook_url) return 0;
    const body = JSON.stringify(this.payload(conv, msg, event, sender));
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-chatwoot-delivery': `d-${this.next()}` };
    if (this.signWebhooks) {
      const ts = String(Math.floor(Date.now() / 1000));
      headers['x-chatwoot-timestamp'] = ts;
      headers['x-chatwoot-signature'] = `sha256=${createHmac('sha256', inbox.secret).update(`${ts}.${body}`).digest('hex')}`;
    }
    try {
      const res = await fetch(inbox.webhook_url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      this.deliveries.push({ url: inbox.webhook_url, status: res.status, event });
      return res.status;
    } catch {
      this.deliveries.push({ url: inbox.webhook_url, status: 0, event });
      return 0;
    }
  }

  /** An agent typing a reply in the dashboard. */
  async agentReply(conversationId: number, content: string, opts: { private?: boolean; inReplyTo?: number; attachment?: { data: Buffer; mimetype: string; name: string } } = {}): Promise<FakeMessage> {
    const conv = this.conversations.find((c) => c.id === conversationId)!;
    const attachments: FakeMessage['attachments'] = [];
    if (opts.attachment) {
      const id = this.next();
      this.files.set(id, { data: opts.attachment.data, mimetype: opts.attachment.mimetype, name: opts.attachment.name });
      attachments.push({ id, file_type: opts.attachment.mimetype.startsWith('image/') ? 'image' : 'file', content_type: opts.attachment.mimetype, file_name: opts.attachment.name, size: opts.attachment.data.length });
    }
    const msg: FakeMessage = {
      id: this.next(),
      conversation_id: conv.id,
      content,
      message_type: 'outgoing',
      private: Boolean(opts.private),
      source_id: null,
      status: 'sent',
      content_attributes: opts.inReplyTo ? { in_reply_to: opts.inReplyTo } : {},
      attachments,
    };
    this.messages.push(msg);
    await this.deliver(conv, msg, 'message_created', { id: 1, name: 'Ana Admin', available_name: 'Ana', type: 'user' });
    return msg;
  }

  async agentDelete(messageId: number): Promise<void> {
    const msg = this.messages.find((m) => m.id === messageId)!;
    msg.deleted = true;
    msg.content = 'This message was deleted';
    const conv = this.conversations.find((c) => c.id === msg.conversation_id)!;
    await this.deliver(conv, msg, 'message_updated', { id: 1, name: 'Ana Admin', type: 'user' });
  }
}
