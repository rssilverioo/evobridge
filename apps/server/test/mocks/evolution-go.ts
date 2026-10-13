import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * In-memory Evolution Go v0.7.2. Routes, auth and payload shapes follow the audited source
 * (docs/research/evolution-go.md), not the published docs.
 */
export interface FakeInstance {
  id: string;
  name: string;
  token: string;
  webhook: string;
  events: string;
  rabbitmqEnable: string;
  websocketEnable: string;
  natsEnable: string;
  jid: string;
  connected: boolean;
}

export interface SentMessage {
  instance: string;
  route: 'text' | 'media';
  number: string;
  id: string;
  text?: string;
  type?: string;
  caption?: string;
  fileName?: string;
  size?: number;
  quoted?: { messageId: string; participant: string };
}

export class FakeEvolutionGo {
  app: FastifyInstance;
  url = '';
  globalKey = 'global-key-123';
  activated = true;
  instances: FakeInstance[] = [];
  sent: SentMessage[] = [];
  deleted: Array<{ chat: string; messageId: string }> = [];
  /** Emits the SendMessage echo before answering /send/*, as the real server does. */
  echoSends = true;
  failSends = 0;
  media = new Map<string, { mimetype: string; base64: string }>();

  constructor() {
    this.app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 });
    void this.app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    this.routes();
  }

  addInstance(partial: Partial<FakeInstance> & { name: string }): FakeInstance {
    const inst: FakeInstance = {
      id: `uuid-${partial.name}`,
      token: `token-${partial.name}`,
      webhook: '',
      events: 'MESSAGE',
      rabbitmqEnable: '',
      websocketEnable: '',
      natsEnable: '',
      jid: '5511900000001:7@s.whatsapp.net',
      connected: true,
      ...partial,
    };
    this.instances.push(inst);
    return inst;
  }

  async start(port = 0): Promise<string> {
    this.url = await this.app.listen({ port, host: '127.0.0.1' });
    return this.url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  private byToken(token: string | undefined) {
    return this.instances.find((i) => i.token === token);
  }

  private routes() {
    const app = this.app;
    app.addHook('onRequest', async (req, reply) => {
      const exempt = ['/server/ok', '/license/status', '/health'];
      if (!this.activated && !exempt.includes(req.url)) {
        return reply.code(503).send({
          error: 'service not activated',
          code: 'LICENSE_REQUIRED',
          register_url: `http://${req.headers.host}/manager/login`,
          message: 'License required. Open the manager to activate your license.',
        });
      }
    });
    const admin = (key: unknown) => key === this.globalKey;

    app.get('/server/ok', async () => ({ status: 'ok' }));
    app.get('/license/status', async () => ({ status: this.activated ? 'active' : 'inactive', instance_id: 'lic-1', api_key: 'abcd...wxyz' }));
    app.get('/instance/all', async (req, reply) => {
      if (!admin(req.headers.apikey)) return reply.code(401).send({ error: 'not authorized' });
      return { message: 'success', data: this.instances };
    });
    app.get<{ Params: { id: string } }>('/instance/info/:id', async (req, reply) => {
      if (!admin(req.headers.apikey)) return reply.code(401).send({ error: 'not authorized' });
      const inst = this.instances.find((i) => i.id === req.params.id);
      if (!inst) return reply.code(500).send({ error: 'instance not found' });
      return { message: 'success', data: inst };
    });
    app.post<{ Body: { webhookUrl?: string; subscribe?: string[]; rabbitmqEnable?: string; websocketEnable?: string; natsEnable?: string } }>(
      '/instance/connect',
      async (req, reply) => {
        const inst = this.byToken(req.headers.apikey as string);
        if (!inst) return reply.code(401).send({ error: 'not authorized' });
        const b = req.body ?? {};
        // Overwrites every field, like the real server.
        inst.webhook = b.webhookUrl ?? '';
        inst.events = (b.subscribe?.length ? b.subscribe : ['MESSAGE']).join(',');
        inst.rabbitmqEnable = b.rabbitmqEnable ?? '';
        inst.websocketEnable = b.websocketEnable ?? '';
        inst.natsEnable = b.natsEnable ?? '';
        return { message: 'success', data: { jid: inst.jid, webhookUrl: inst.webhook, eventString: inst.events } };
      },
    );
    app.get('/instance/status', async (req, reply) => {
      const inst = this.byToken(req.headers.apikey as string);
      if (!inst) return reply.code(401).send({ error: 'not authorized' });
      return { message: 'success', data: { Connected: inst.connected, LoggedIn: inst.connected, Name: 'Shop' } };
    });

    app.post<{ Body: { number: string; text: string; id?: string; quoted?: { messageId: string; participant: string } } }>('/send/text', async (req, reply) => {
      const inst = this.byToken(req.headers.apikey as string);
      if (!inst) return reply.code(401).send({ error: 'not authorized' });
      if (this.failSends > 0) {
        this.failSends--;
        return reply.code(500).send({ error: 'client disconnected' });
      }
      const id = req.body.id || `3EB0${Math.random().toString(16).slice(2, 20).toUpperCase()}`;
      this.sent.push({ instance: inst.name, route: 'text', number: req.body.number, id, text: req.body.text, quoted: req.body.quoted });
      if (this.echoSends) await this.emit(inst, this.sendMessageEvent(inst, req.body.number, id, { extendedTextMessage: { text: req.body.text } }));
      return { message: 'success', data: { Info: { ID: id, Timestamp: new Date().toISOString() } } };
    });

    app.post('/send/media', async (req, reply) => {
      const inst = this.byToken(req.headers.apikey as string);
      if (!inst) return reply.code(401).send({ error: 'not authorized' });
      const fields: Record<string, string> = {};
      let size = 0;
      let fileName = '';
      let quoted: { messageId: string; participant: string } | undefined;
      if (req.isMultipart()) {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            size = (await part.toBuffer()).length;
            fileName = part.filename;
          } else fields[part.fieldname] = String(part.value);
        }
      } else {
        const b = req.body as Record<string, unknown>;
        for (const [k, v] of Object.entries(b)) if (typeof v === 'string') fields[k] = v;
        if (fields.url?.startsWith('data:')) return reply.code(400).send({ error: 'invalid base64 encoding' });
        size = Buffer.from(fields.url ?? '', 'base64').length;
        fileName = fields.filename ?? '';
        quoted = b.quoted as typeof quoted;
      }
      if (fields['quoted.messageId']) quoted = { messageId: fields['quoted.messageId'], participant: fields['quoted.participant'] ?? '' };
      const id = fields.id || `3EB0${Math.random().toString(16).slice(2, 20).toUpperCase()}`;
      this.sent.push({
        instance: inst.name,
        route: 'media',
        number: fields.number ?? '',
        id,
        type: fields.type,
        caption: fields.caption,
        fileName,
        size,
        quoted,
      });
      if (this.echoSends) await this.emit(inst, this.sendMessageEvent(inst, fields.number ?? '', id, { imageMessage: { caption: fields.caption ?? '' } }));
      return { message: 'success', data: { Info: { ID: id } } };
    });

    app.post<{ Body: { message: { imageMessage?: { URL?: string } } } }>('/message/downloadmedia', async (req, reply) => {
      const inst = this.byToken(req.headers.apikey as string);
      if (!inst) return reply.code(401).send({ error: 'not authorized' });
      const key = req.body.message?.imageMessage?.URL ?? '';
      const m = this.media.get(key);
      if (!m) return reply.code(500).send({ error: 'failed to download media' });
      return { message: 'success', data: { base64: `data:${m.mimetype};base64,${m.base64}` } };
    });
    app.post<{ Body: { chat: string; messageId: string } }>('/message/delete', async (req, reply) => {
      const inst = this.byToken(req.headers.apikey as string);
      if (!inst) return reply.code(401).send({ error: 'not authorized' });
      this.deleted.push(req.body);
      return { message: 'success', data: { messageId: req.body.messageId } };
    });
  }

  private sendMessageEvent(inst: FakeInstance, number: string, id: string, message: unknown) {
    return {
      event: 'SendMessage',
      data: {
        Info: { Chat: number, Sender: inst.jid, IsFromMe: true, IsGroup: false, ID: id, Type: 'ExtendedTextMessage', Timestamp: new Date().toISOString() },
        Message: message,
      },
      instanceId: inst.id,
      instanceToken: inst.token,
      instanceName: inst.name,
    };
  }

  /** Delivers an event to the instance webhook (single attempt; the test controls retries). */
  async emit(inst: FakeInstance, body: unknown): Promise<number> {
    if (!inst.webhook) return 0;
    const res = await fetch(inst.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.status;
  }

  /** An incoming WhatsApp text, shaped like whatsmeow's events.Message after Evolution Go's LID swap. */
  incomingText(inst: FakeInstance, opts: { id: string; from: string; text: string; pushName?: string; lid?: string; quotedId?: string }) {
    return {
      event: 'Message',
      data: {
        Info: {
          Chat: `${opts.from}@s.whatsapp.net`,
          Sender: `${opts.from}@s.whatsapp.net`,
          SenderAlt: opts.lid ?? '',
          RecipientAlt: '',
          IsFromMe: false,
          IsGroup: false,
          AddressingMode: opts.lid ? 'lid' : 'pn',
          ID: opts.id,
          Type: 'text',
          PushName: opts.pushName ?? 'Maria',
          Timestamp: new Date().toISOString(),
          MediaType: '',
          Edit: '',
        },
        Message: opts.quotedId
          ? { extendedTextMessage: { text: opts.text, contextInfo: { stanzaID: opts.quotedId } } }
          : { conversation: opts.text },
        IsEdit: false,
        ...(opts.quotedId ? { isQuoted: true, quoted: { stanzaID: opts.quotedId } } : {}),
      },
      instanceId: inst.id,
      instanceToken: inst.token,
      instanceName: inst.name,
    };
  }
}
