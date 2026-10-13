import { randomBytes } from 'node:crypto';
import type { ProviderCheck } from '@evobridge/shared';
import { ProviderError } from '../../lib/errors.js';
import type { FormData, HttpClient, HttpResponse } from '../../lib/http.js';
import { statusError } from '../../lib/http.js';
import type { EvoConnectBody, EvoContact, EvoEnvelope, EvoInstance, EvoMediaType, EvoSendResult, EvoSendTextBody, WaMessage } from './types.js';

const NAME = 'Evolution Go';

const NOT_ACTIVATED_HINT =
  'Open the Evolution Go Manager (/manager/login), sign in with the global API key and finish the license activation. The API answers 503 to every call until then.';

/**
 * Generates a WhatsApp message id in whatsmeow's format ("3EB0" + 18 hex chars).
 * EvoBridge picks the id before sending, so the echo webhook can be recognized even when
 * it arrives before the HTTP response (Evolution Go fires it first).
 */
export function generateWaMessageId(): string {
  return `3EB0${randomBytes(9).toString('hex').toUpperCase()}`;
}

export class EvolutionGoClient {
  constructor(
    private readonly http: HttpClient,
    readonly baseUrl: string,
    /** GLOBAL_API_KEY: admin routes only. */
    private readonly globalKey: string,
  ) {}

  private async call<T>(path: string, key: string, init: { method?: 'GET' | 'POST' | 'DELETE'; json?: unknown; form?: FormData; timeoutMs?: number; maxBytes?: number } = {}): Promise<T> {
    const res = await this.http.request(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { apikey: key },
      json: init.json,
      form: init.form,
      timeoutMs: init.timeoutMs,
      maxBytes: init.maxBytes,
    });
    return this.unwrap<T>(res);
  }

  private unwrap<T>(res: HttpResponse): T {
    if (res.status >= 200 && res.status < 300) return res.json<EvoEnvelope<T>>().data;
    let body: { error?: string; code?: string; register_url?: string; message?: string } = {};
    try {
      body = res.json();
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 503 && body.code === 'LICENSE_REQUIRED') {
      throw new ProviderError('not_activated', 'Evolution Go is not activated yet', 503, NOT_ACTIVATED_HINT);
    }
    throw statusError(res.status, NAME, body.error ?? body.message, res.headers.get('retry-after'));
  }

  /** Reachability (no auth), activation (no auth) and the global key, in that order. */
  async check(): Promise<ProviderCheck> {
    try {
      const ok = await this.http.request(`${this.baseUrl}/server/ok`, { timeoutMs: 10_000 });
      if (ok.status !== 200) {
        return {
          ok: false,
          status: 'error',
          message: `${this.baseUrl} answered ${ok.status} on /server/ok`,
          hint: 'This does not look like an Evolution Go server. Evolution API (Node) is a different product and is not supported.',
        };
      }
      const license = await this.http.request(`${this.baseUrl}/license/status`, { timeoutMs: 10_000 });
      if (license.status === 200) {
        const l = license.json<{ status?: string }>();
        if (l.status && l.status !== 'active') {
          return { ok: false, status: 'not_activated', message: 'Evolution Go is not activated yet', hint: NOT_ACTIVATED_HINT };
        }
      }
      const instances = await this.listInstances();
      return {
        ok: true,
        status: 'ok',
        message: `Connected. ${instances.length} instance${instances.length === 1 ? '' : 's'} found.`,
        details: { instanceCount: instances.length },
      };
    } catch (err) {
      return checkFromError(err);
    }
  }

  listInstances(): Promise<EvoInstance[]> {
    return this.call<EvoInstance[]>('/instance/all', this.globalKey).then((d) => d ?? []);
  }

  getInstance(instanceId: string): Promise<EvoInstance> {
    return this.call<EvoInstance>(`/instance/info/${encodeURIComponent(instanceId)}`, this.globalKey);
  }

  /** Creates an instance (global key). The caller picks the instance token. */
  createInstance(name: string, token: string): Promise<EvoInstance> {
    return this.call<EvoInstance>('/instance/create', this.globalKey, { method: 'POST', json: { name, token } });
  }

  /**
   * Current pairing QR. Starts the WhatsApp client when needed. Never call it on a logged-in
   * instance: Evolution Go restarts the client in that case.
   */
  getQr(instanceToken: string): Promise<{ qrcode?: string; code?: string; passkeyStage?: string; passkeyOpenUrl?: string }> {
    return this.call('/instance/qr', instanceToken, { timeoutMs: 20_000 });
  }

  /** Phone-number pairing: returns the 8-character code typed on the phone. */
  async pairPhone(instanceToken: string, phoneDigits: string): Promise<string> {
    const out = await this.call<{ PairingCode?: string }>('/instance/pair', instanceToken, { method: 'POST', json: { phone: phoneDigits, subscribe: [] }, timeoutMs: 30_000 });
    if (!out?.PairingCode) throw new ProviderError('bad_response', 'Evolution Go did not return a pairing code');
    return out.PairingCode;
  }

  /** Overwrites webhook URL, subscriptions and the three channel flags of the instance. */
  configureInstance(instanceToken: string, body: EvoConnectBody): Promise<{ webhookUrl?: string; eventString?: string }> {
    return this.call('/instance/connect', instanceToken, { method: 'POST', json: body });
  }

  instanceStatus(instanceToken: string): Promise<{ Connected: boolean; LoggedIn: boolean; Name?: string }> {
    return this.call('/instance/status', instanceToken);
  }

  sendText(instanceToken: string, body: EvoSendTextBody): Promise<EvoSendResult> {
    return this.call('/send/text', instanceToken, { method: 'POST', json: body, timeoutMs: 60_000 });
  }

  /**
   * Uploads the file inline as raw base64 (Evolution Go decodes any non-http `url` as base64),
   * so it never needs to reach Chatwoot's storage. JSON rather than multipart: multipart
   * rewrites newlines in the caption to CRLF.
   */
  sendMedia(
    instanceToken: string,
    input: { number: string; type: EvoMediaType; file: Buffer; fileName: string; mimetype: string; caption?: string; id: string; quoted?: { messageId: string; participant: string } },
  ): Promise<EvoSendResult> {
    return this.call('/send/media', instanceToken, {
      method: 'POST',
      json: {
        number: input.number,
        type: input.type,
        url: input.file.toString('base64'),
        id: input.id,
        ...(input.caption ? { caption: input.caption } : {}),
        ...(input.type === 'document' ? { filename: input.fileName } : {}),
        ...(input.quoted ? { quoted: input.quoted } : {}),
      },
      timeoutMs: 120_000,
    });
  }

  /** Decrypts media of a received message. Returns a data URL. */
  async downloadMedia(instanceToken: string, message: WaMessage): Promise<{ mimetype: string; data: Buffer }> {
    const out = await this.call<{ base64: string }>('/message/downloadmedia', instanceToken, {
      method: 'POST',
      json: { message },
      timeoutMs: 120_000,
      maxBytes: 150 * 1024 * 1024,
    });
    const match = /^data:([^;]+);base64,(.*)$/s.exec(out.base64 ?? '');
    if (!match?.[1] || match[2] === undefined) throw new ProviderError('bad_response', 'Evolution Go returned media in an unexpected format');
    return { mimetype: match[1], data: Buffer.from(match[2], 'base64') };
  }

  /** Contacts whatsmeow knows: saved name (FullName) and WhatsApp profile name (PushName), keyed by JID. */
  listContacts(instanceToken: string): Promise<EvoContact[]> {
    return this.call<EvoContact[] | null>('/user/contacts', instanceToken, { timeoutMs: 30_000, maxBytes: 20 * 1024 * 1024 }).then((d) => d ?? []);
  }

  /** Profile picture URL on WhatsApp's CDN, or null when hidden or absent. */
  async getAvatarUrl(instanceToken: string, jid: string): Promise<string | null> {
    try {
      const pic = await this.call<{ url?: string } | null>('/user/avatar', instanceToken, { method: 'POST', json: { number: jid, preview: false }, timeoutMs: 15_000 });
      return pic?.url || null;
    } catch {
      return null;
    }
  }

  markRead(instanceToken: string, chatJid: string, ids: string[]): Promise<unknown> {
    return this.call('/message/markread', instanceToken, { method: 'POST', json: { number: chatJid, id: ids } });
  }

  deleteForEveryone(instanceToken: string, chatJid: string, messageId: string): Promise<unknown> {
    return this.call('/message/delete', instanceToken, { method: 'POST', json: { chat: chatJid, messageId } });
  }
}

export function checkFromError(err: unknown): ProviderCheck {
  if (err instanceof ProviderError) {
    const status =
      err.kind === 'unauthorized' || err.kind === 'forbidden'
        ? 'unauthorized'
        : err.kind === 'not_activated'
          ? 'not_activated'
          : err.kind === 'unreachable' || err.kind === 'timeout' || err.kind === 'blocked_url'
            ? 'unreachable'
            : 'error';
    return { ok: false, status, message: err.message, hint: err.hint };
  }
  return { ok: false, status: 'error', message: err instanceof Error ? err.message : String(err) };
}
