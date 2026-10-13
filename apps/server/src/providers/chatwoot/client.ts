import { createHmac } from 'node:crypto';
import type { ProviderCheck } from '@evobridge/shared';
import { safeEqual } from '../../lib/crypto.js';
import { ProviderError } from '../../lib/errors.js';
import { FormData, type HttpClient, type HttpResponse, statusError } from '../../lib/http.js';
import { checkFromError } from '../evolution-go/client.js';
import type { CwContact, CwConversation, CwInbox, CwMessage, CwProfile } from './types.js';

const NAME = 'Chatwoot';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ChatwootClient {
  constructor(
    private readonly http: HttpClient,
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: Method, path: string, init: { json?: unknown; form?: FormData; timeoutMs?: number } = {}): Promise<T> {
    const res = await this.http.request(`${this.baseUrl}${path}`, {
      method,
      headers: { api_access_token: this.token },
      json: init.json,
      form: init.form,
      timeoutMs: init.timeoutMs,
    });
    return this.unwrap<T>(res);
  }

  private unwrap<T>(res: HttpResponse): T {
    if (res.status >= 200 && res.status < 300) {
      return (res.body.length ? res.json<T>() : undefined) as T;
    }
    let detail: string | undefined;
    try {
      const b = res.json<{ error?: string; message?: string; errors?: string[] }>();
      detail = b.message ?? b.error ?? b.errors?.join(', ');
    } catch {
      /* non-JSON */
    }
    // Chatwoot answers 401 both for a bad token and for an agent hitting an admin-only route.
    if (res.status === 401 && detail?.includes('not authorized to do this action')) {
      throw new ProviderError('forbidden', 'This Chatwoot user is not an administrator of the account', 401, 'Use an access token from a user with the Administrator role.');
    }
    throw statusError(res.status, NAME, detail, res.headers.get('retry-after'));
  }

  async check(): Promise<ProviderCheck> {
    try {
      const profile = await this.profile();
      const accounts = profile.accounts.filter((a) => !a.status || a.status === 'active');
      if (!accounts.length) {
        return { ok: false, status: 'error', message: 'This user has no active Chatwoot account', hint: 'Invite the user to an account first.' };
      }
      return {
        ok: true,
        status: 'ok',
        message: `Signed in as ${profile.name}. ${accounts.length} account${accounts.length === 1 ? '' : 's'} available.`,
        details: { userName: profile.name, accounts: accounts.map((a) => ({ id: a.id, name: a.name, role: a.role })) },
      };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'unauthorized') {
        return {
          ok: false,
          status: 'unauthorized',
          message: 'Chatwoot rejected the access token',
          hint: 'Copy the token from Profile settings → Access Token. Agent bot tokens are not supported.',
        };
      }
      return checkFromError(err);
    }
  }

  profile(): Promise<CwProfile> {
    return this.call('GET', '/api/v1/profile');
  }

  /** Account details; `locale` (e.g. "pt_BR") picks the language of EvoBridge notices. */
  getAccount(accountId: number): Promise<{ id: number; name: string; locale?: string }> {
    return this.call('GET', `/api/v1/accounts/${accountId}`);
  }

  updateContact(accountId: number, contactId: number, patch: { name?: string; phone_number?: string; avatar_url?: string }): Promise<unknown> {
    return this.call('PATCH', `/api/v1/accounts/${accountId}/contacts/${contactId}`, { json: patch });
  }

  async listInboxes(accountId: number): Promise<CwInbox[]> {
    const out = await this.call<{ payload: CwInbox[] }>('GET', `/api/v1/accounts/${accountId}/inboxes`);
    return out.payload ?? [];
  }

  getInbox(accountId: number, inboxId: number): Promise<CwInbox> {
    return this.call('GET', `/api/v1/accounts/${accountId}/inboxes/${inboxId}`);
  }

  createApiInbox(accountId: number, name: string, webhookUrl: string): Promise<CwInbox> {
    return this.call('POST', `/api/v1/accounts/${accountId}/inboxes`, {
      json: {
        name,
        channel: { type: 'api', webhook_url: webhookUrl },
        // Agents can keep replying after a conversation is resolved, like on WhatsApp.
        allow_messages_after_resolved: true,
      },
    });
  }

  setInboxWebhook(accountId: number, inboxId: number, webhookUrl: string): Promise<CwInbox> {
    return this.call('PATCH', `/api/v1/accounts/${accountId}/inboxes/${inboxId}`, { json: { channel: { webhook_url: webhookUrl } } });
  }

  /** Exact lookup by the bridge's own key. Returns null on 404. */
  async findContactBySource(accountId: number, inboxId: number, sourceId: string): Promise<CwContact | null> {
    try {
      return await this.call<CwContact>('POST', `/api/v1/accounts/${accountId}/contact_inboxes/filter`, { json: { inbox_id: inboxId, source_id: sourceId } });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async filterContacts(accountId: number, attribute: 'phone_number' | 'identifier', values: string[]): Promise<CwContact[]> {
    const out = await this.call<{ payload: CwContact[] }>('POST', `/api/v1/accounts/${accountId}/contacts/filter`, {
      json: { payload: [{ attribute_key: attribute, filter_operator: 'equal_to', values, query_operator: null }] },
    });
    return out.payload ?? [];
  }

  async createContact(
    accountId: number,
    input: { inboxId: number; sourceId: string; name: string; phoneNumber?: string | null; identifier?: string | null; avatarUrl?: string | null },
  ): Promise<{ contactId: number; sourceId: string }> {
    const out = await this.call<{ payload: { contact: CwContact; contact_inbox?: { source_id: string } } }>('POST', `/api/v1/accounts/${accountId}/contacts`, {
      json: {
        inbox_id: input.inboxId,
        source_id: input.sourceId,
        name: input.name,
        ...(input.phoneNumber ? { phone_number: input.phoneNumber } : {}),
        ...(input.identifier ? { identifier: input.identifier } : {}),
        ...(input.avatarUrl ? { avatar_url: input.avatarUrl } : {}),
      },
    });
    return { contactId: out.payload.contact.id, sourceId: out.payload.contact_inbox?.source_id ?? input.sourceId };
  }

  attachContactToInbox(accountId: number, contactId: number, inboxId: number, sourceId: string): Promise<{ source_id: string }> {
    return this.call('POST', `/api/v1/accounts/${accountId}/contacts/${contactId}/contact_inboxes`, { json: { inbox_id: inboxId, source_id: sourceId } });
  }

  async contactConversations(accountId: number, contactId: number): Promise<CwConversation[]> {
    const out = await this.call<{ payload: CwConversation[] }>('GET', `/api/v1/accounts/${accountId}/contacts/${contactId}/conversations`);
    return out.payload ?? [];
  }

  getConversation(accountId: number, conversationId: number): Promise<CwConversation> {
    return this.call('GET', `/api/v1/accounts/${accountId}/conversations/${conversationId}`);
  }

  createConversation(accountId: number, input: { inboxId: number; contactId: number; sourceId: string; status: 'open' | 'pending' }): Promise<CwConversation> {
    return this.call('POST', `/api/v1/accounts/${accountId}/conversations`, {
      json: { inbox_id: input.inboxId, contact_id: input.contactId, source_id: input.sourceId, status: input.status },
    });
  }

  toggleStatus(accountId: number, conversationId: number, status: 'open' | 'pending'): Promise<unknown> {
    return this.call('POST', `/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`, { json: { status } });
  }

  async createMessage(
    accountId: number,
    conversationId: number,
    input: {
      content: string;
      messageType: 'incoming' | 'outgoing';
      sourceId: string;
      /** Private note: visible to agents only, never sent to the channel. */
      private?: boolean;
      inReplyToSourceId?: string | null;
      attachment?: { data: Buffer; fileName: string; mimetype: string; voice?: boolean };
    },
  ): Promise<CwMessage> {
    const path = `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const contentAttributes = input.inReplyToSourceId ? { in_reply_to_external_id: input.inReplyToSourceId } : undefined;
    if (!input.attachment) {
      return this.call('POST', path, {
        json: {
          content: input.content,
          message_type: input.messageType,
          private: Boolean(input.private),
          source_id: input.sourceId,
          ...(contentAttributes ? { content_attributes: contentAttributes } : {}),
        },
      });
    }
    const form = new FormData();
    form.set('content', input.content);
    form.set('message_type', input.messageType);
    form.set('private', input.private ? 'true' : 'false');
    form.set('source_id', input.sourceId);
    if (contentAttributes) form.set('content_attributes', JSON.stringify(contentAttributes));
    if (input.attachment.voice) form.set('is_voice_message', 'true');
    form.append('attachments[]', new Blob([new Uint8Array(input.attachment.data)], { type: input.attachment.mimetype }), input.attachment.fileName);
    return this.call('POST', path, { form, timeoutMs: 120_000 });
  }

  /** API inboxes only. Forward-only transitions, except to/from failed. */
  updateMessageStatus(accountId: number, conversationId: number, messageId: number, status: 'sent' | 'delivered' | 'read' | 'failed', externalError?: string): Promise<unknown> {
    return this.call('PATCH', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages/${messageId}`, {
      json: { status, ...(status === 'failed' && externalError ? { external_error: externalError.slice(0, 500) } : {}) },
    });
  }

  deleteMessage(accountId: number, conversationId: number, messageId: number): Promise<unknown> {
    return this.call('DELETE', `/api/v1/accounts/${accountId}/conversations/${conversationId}/messages/${messageId}`);
  }

  /** Downloads an attachment `data_url` (a Rails redirect to storage). Credentials are not forwarded past the redirect. */
  async downloadAttachment(dataUrl: string): Promise<{ data: Buffer; mimetype: string | null }> {
    const res = await this.http.request(dataUrl, {
      headers: { api_access_token: this.token, accept: '*/*' },
      followRedirects: true,
      timeoutMs: 120_000,
      maxBytes: 100 * 1024 * 1024,
    });
    if (res.status !== 200) throw statusError(res.status, `${NAME} storage`);
    return { data: res.body, mimetype: res.headers.get('content-type') };
  }
}

/**
 * Verifies `X-Chatwoot-Signature: sha256=HMAC_SHA256(secret, "<timestamp>.<raw body>")`
 * (lib/webhooks/trigger.rb, Chatwoot >= 4.13). Rejects timestamps older than 5 minutes.
 */
export function verifyChatwootSignature(secret: string, rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, nowMs = Date.now()): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
  return safeEqual(expected, signature);
}
