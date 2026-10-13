import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context.js';
import { errorMessage } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { Bridge } from '../services/connections.js';
import { recordEvent } from '../services/events.js';

/**
 * Connection status notes posted in Chatwoot, like Evolution API's bot conversation.
 * They live in one conversation with an "EvoBridge" contact, always as private notes, so
 * nothing there can ever reach WhatsApp.
 */
export const SYSTEM_CHAT = 'evobridge:system';
export const SYSTEM_SOURCE = 'evobridge-system';

export type NoticeKind = 'connected' | 'reconnected' | 'not_logged_in' | 'disconnected' | 'logged_out' | 'banned';

/** Notices that describe the same state; a new one is only posted when the state changes. */
const STATE_OF: Record<NoticeKind, string> = {
  connected: 'up',
  reconnected: 'up',
  not_logged_in: 'down',
  disconnected: 'down',
  logged_out: 'down',
  banned: 'down',
};

const TEXT: Record<'pt' | 'en', Record<NoticeKind, (v: { instance: string; phone: string | null; detail?: string }) => string>> = {
  pt: {
    connected: (v) => `EvoBridge: WhatsApp conectado${v.phone ? ` (+${v.phone})` : ''}, instância ${v.instance}. As mensagens deste número chegam nesta caixa de entrada.`,
    reconnected: (v) => `EvoBridge: WhatsApp reconectado${v.phone ? ` (+${v.phone})` : ''}, instância ${v.instance}.`,
    not_logged_in: (v) => `EvoBridge está configurado, mas o WhatsApp não está conectado na instância ${v.instance}. Leia o QR code no Evolution Go.`,
    disconnected: (v) => `EvoBridge: WhatsApp desconectado na instância ${v.instance}${v.detail ? ` (${v.detail})` : ''}. As mensagens voltam a chegar quando ele reconectar.`,
    logged_out: (v) => `EvoBridge: o WhatsApp da instância ${v.instance} foi deslogado. Leia o QR code novamente no Evolution Go.`,
    banned: (v) => `EvoBridge: o WhatsApp bloqueou temporariamente o número da instância ${v.instance}.`,
  },
  en: {
    connected: (v) => `EvoBridge: WhatsApp connected${v.phone ? ` (+${v.phone})` : ''}, instance ${v.instance}. Messages to this number arrive in this inbox.`,
    reconnected: (v) => `EvoBridge: WhatsApp reconnected${v.phone ? ` (+${v.phone})` : ''}, instance ${v.instance}.`,
    not_logged_in: (v) => `EvoBridge is set up, but WhatsApp is not logged in on instance ${v.instance}. Scan the QR code in Evolution Go.`,
    disconnected: (v) => `EvoBridge: WhatsApp disconnected on instance ${v.instance}${v.detail ? ` (${v.detail})` : ''}. Messages resume when it reconnects.`,
    logged_out: (v) => `EvoBridge: WhatsApp on instance ${v.instance} was logged out. Scan the QR code again in Evolution Go.`,
    banned: (v) => `EvoBridge: WhatsApp temporarily banned the number on instance ${v.instance}.`,
  },
};

const localeCache = new Map<string, { lang: 'pt' | 'en'; at: number }>();

async function languageFor(b: Bridge): Promise<'pt' | 'en'> {
  const key = `${b.row.chatwoot_provider_id}:${b.accountId}`;
  const hit = localeCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.lang;
  const account = await b.cw.getAccount(b.accountId).catch(() => null);
  const lang = account?.locale?.toLowerCase().startsWith('pt') ? 'pt' : 'en';
  localeCache.set(key, { lang, at: Date.now() });
  return lang;
}

/** The "EvoBridge" contact and its conversation in the connection's inbox. */
export async function ensureSystemConversation(ctx: Pick<Ctx, 'db'>, b: Bridge): Promise<number> {
  const at = nowIso();
  let row = await ctx.db.selectFrom('contacts').selectAll().where('connection_id', '=', b.row.id).where('chat_jid', '=', SYSTEM_CHAT).executeTakeFirst();
  if (row?.cw_conversation_id) return row.cw_conversation_id;

  let contactId = row?.cw_contact_id ?? (await b.cw.findContactBySource(b.accountId, b.inboxId, SYSTEM_SOURCE))?.id;
  if (!contactId) {
    contactId = (
      await b.cw.createContact(b.accountId, { inboxId: b.inboxId, sourceId: SYSTEM_SOURCE, name: 'EvoBridge', identifier: `evobridge:${b.inboxId}` }).catch(async (err) => {
        // Identifier left over from an earlier connection on this inbox: reuse that contact.
        const [found] = await b.cw.filterContacts(b.accountId, 'identifier', [`evobridge:${b.inboxId}`]);
        if (!found) throw err;
        await b.cw.attachContactToInbox(b.accountId, found.id, b.inboxId, SYSTEM_SOURCE);
        return { contactId: found.id, sourceId: SYSTEM_SOURCE };
      })
    ).contactId;
  }
  const existing = (await b.cw.contactConversations(b.accountId, contactId)).filter((c) => c.inbox_id === b.inboxId).sort((x, y) => y.id - x.id)[0];
  const conversationId = existing?.id ?? (await b.cw.createConversation(b.accountId, { inboxId: b.inboxId, contactId, sourceId: SYSTEM_SOURCE, status: 'open' })).id;

  if (row) {
    await ctx.db.updateTable('contacts').set({ cw_contact_id: contactId, cw_source_id: SYSTEM_SOURCE, cw_conversation_id: conversationId, updated_at: at }).where('id', '=', row.id).execute();
  } else {
    await ctx.db
      .insertInto('contacts')
      .values({
        connection_id: b.row.id,
        chat_jid: SYSTEM_CHAT,
        lid: null,
        phone: null,
        push_name: 'EvoBridge',
        cw_contact_id: contactId,
        cw_source_id: SYSTEM_SOURCE,
        cw_conversation_id: conversationId,
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) => oc.columns(['connection_id', 'chat_jid']).doNothing())
      .execute();
    row = await ctx.db.selectFrom('contacts').selectAll().where('connection_id', '=', b.row.id).where('chat_jid', '=', SYSTEM_CHAT).executeTakeFirst();
  }
  return conversationId;
}

/**
 * Posts a status note unless it would repeat the last one (a flapping connection posts one
 * note per real change, not one per event). Never throws: a notice must not break sync.
 */
export async function postNotice(ctx: Ctx, b: Bridge, kind: NoticeKind, vars: { phone?: string | null; detail?: string } = {}): Promise<boolean> {
  if (!b.options.connectionNotices || b.row.paused) return false;
  try {
    const last = await ctx.db
      .selectFrom('events')
      .select('type')
      .where('connection_id', '=', b.row.id)
      .where('type', 'like', 'notice.%')
      .where('status', '=', 'processed')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const lastKind = last?.type.slice('notice.'.length) as NoticeKind | undefined;
    if (lastKind && STATE_OF[lastKind] === STATE_OF[kind] && kind !== 'logged_out' && kind !== 'banned') return false;
    if (lastKind === kind) return false;
    // "Reconnected" only makes sense after a down notice; the first one says "connected".
    const effective: NoticeKind = kind === 'reconnected' && (!lastKind || lastKind === 'not_logged_in') ? 'connected' : kind;

    const lang = await languageFor(b);
    const content = TEXT[lang][effective]({ instance: b.row.instance_name, phone: vars.phone ?? null, detail: vars.detail });
    const conversationId = await ensureSystemConversation(ctx, b);
    await b.cw.createMessage(b.accountId, conversationId, { content, messageType: 'outgoing', private: true, sourceId: `evobridge:notice:${randomUUID()}` });
    await recordEvent(ctx, { connectionId: b.row.id, source: 'evobridge', direction: 'system', type: `notice.${effective}`, status: 'processed', refs: { cwConversationId: conversationId } });
    return true;
  } catch (err) {
    ctx.log.warn({ connectionId: b.row.id, kind, err: errorMessage(err) }, 'could not post connection notice');
    return false;
  }
}

/** The own number of the instance, from its JID ("5511…:7@s.whatsapp.net"). */
export async function instancePhone(b: Bridge): Promise<string | null> {
  if (!b.row.instance_id) return null;
  const inst = await b.evo.getInstance(b.row.instance_id).catch(() => null);
  const user = inst?.jid?.split('@')[0]?.split(':')[0];
  return user && /^\d+$/.test(user) ? user : null;
}
