import type { Ctx } from '../context.js';
import type { Selectable } from 'kysely';
import type { ContactsTable } from '../db/schema.js';
import { ProviderError } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { WaChatRef } from '../providers/evolution-go/normalize.js';
import type { EvoContact } from '../providers/evolution-go/types.js';
import type { Bridge } from '../services/connections.js';
import { brazilVariants } from './format.js';

type ContactRow = Selectable<ContactsTable>;

export interface Thread {
  rowId: number;
  contactId: number;
  conversationId: number;
  sourceId: string;
}

/**
 * Finds the local contact row for a chat, merging what we learn about LID <-> phone.
 * A message typed on the phone in a LID chat only carries the @lid; the phone-keyed row
 * learned from an earlier incoming message (SenderAlt) is the one to use.
 */
export async function findOrLearnContact(ctx: Pick<Ctx, 'db'>, connectionId: string, chat: WaChatRef, pushName: string | null): Promise<ContactRow | undefined> {
  const at = nowIso();
  let row = await ctx.db.selectFrom('contacts').selectAll().where('connection_id', '=', connectionId).where('chat_jid', '=', chat.chatJid).executeTakeFirst();
  if (!row && chat.lid) {
    row = await ctx.db.selectFrom('contacts').selectAll().where('connection_id', '=', connectionId).where('lid', '=', chat.lid).executeTakeFirst();
  }
  if (row) {
    const patch: Partial<Omit<ContactRow, 'id'>> = {};
    if (chat.lid && !row.lid) patch.lid = chat.lid;
    if (pushName && !chat.isGroup && row.push_name !== pushName) patch.push_name = pushName;
    if (Object.keys(patch).length) {
      await ctx.db.updateTable('contacts').set({ ...patch, updated_at: at }).where('id', '=', row.id).execute();
      row = { ...row, ...patch };
    }
  }
  return row;
}

function sourceIdFor(chat: WaChatRef): string {
  // Digits for 1:1 phone chats keep Chatwoot campaigns working (they look up by digits);
  // full JID for groups and LID-only chats, which have no phone.
  return chat.phone ?? chat.chatJid;
}

function displayName(chat: WaChatRef, pushName: string | null, groupName?: string | null): string {
  if (chat.isGroup) return groupName ? `${groupName} (group)` : `Group ${chat.chatJid.split('@')[0]}`;
  if (pushName) return pushName;
  if (chat.phone) return `+${chat.phone}`;
  return `WhatsApp ${chat.chatJid.split('@')[0]?.slice(-6)}`;
}

/**
 * Returns the Chatwoot contact + conversation for a WhatsApp chat, creating what's missing.
 * Callers run one job per chat at a time (queue ordering key), so this never races itself.
 */
export async function ensureThread(
  ctx: Pick<Ctx, 'db' | 'log'>,
  b: Bridge,
  chat: WaChatRef,
  opts: { pushName: string | null; groupName?: string | null; allowCreateConversation?: boolean },
): Promise<Thread> {
  const at = nowIso();
  let row = await findOrLearnContact(ctx, b.row.id, chat, opts.pushName);
  if (!row) {
    await ctx.db
      .insertInto('contacts')
      .values({
        connection_id: b.row.id,
        chat_jid: chat.chatJid,
        lid: chat.lid,
        phone: chat.phone,
        push_name: chat.isGroup ? null : opts.pushName,
        cw_contact_id: null,
        cw_source_id: null,
        cw_conversation_id: null,
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) => oc.columns(['connection_id', 'chat_jid']).doNothing())
      .execute();
    row = await findOrLearnContact(ctx, b.row.id, chat, opts.pushName);
    if (!row) throw new Error('Could not store contact');
  }

  let contactId = row.cw_contact_id;
  let sourceId = row.cw_source_id;
  if (!contactId || !sourceId) {
    sourceId = sourceIdFor(chat);
    const name = chat.isGroup ? null : (opts.pushName ?? (await storedName(b, chat)));
    const avatarUrl = chat.isGroup ? null : await b.evo.getAvatarUrl(b.instanceToken, chat.lid ?? chat.chatJid);
    contactId = await resolveChatwootContact(b, chat, sourceId, name ?? displayName(chat, null, opts.groupName), avatarUrl);
    await ctx.db
      .updateTable('contacts')
      .set({ cw_contact_id: contactId, cw_source_id: sourceId, cw_name_placeholder: name || chat.isGroup || chat.phone ? 0 : 1, updated_at: nowIso() })
      .where('id', '=', row.id)
      .execute();
  } else if (!chat.isGroup) {
    await enrichContact(ctx, b, row, chat, opts.pushName);
  }

  let conversationId = row.cw_conversation_id;
  if (conversationId && !b.options.reopenConversation) {
    // Without reopening, a resolved conversation is left closed and a new one starts.
    const conv = await b.cw.getConversation(b.accountId, conversationId).catch((err) => {
      if (err instanceof ProviderError && err.kind === 'not_found') return null;
      throw err;
    });
    if (!conv || conv.status === 'resolved') conversationId = null;
  }
  if (!conversationId) {
    conversationId = await pickConversation(b, contactId, sourceId);
    await ctx.db.updateTable('contacts').set({ cw_conversation_id: conversationId, updated_at: nowIso() }).where('id', '=', row.id).execute();
  }
  return { rowId: row.id, contactId, conversationId, sourceId };
}

/** Forgets the cached conversation (deleted in Chatwoot), so the next message makes a new one. */
export async function dropConversation(ctx: Pick<Ctx, 'db'>, rowId: number): Promise<void> {
  await ctx.db.updateTable('contacts').set({ cw_conversation_id: null, updated_at: nowIso() }).where('id', '=', rowId).execute();
}

async function pickConversation(b: Bridge, contactId: number, sourceId: string): Promise<number> {
  const conversations = (await b.cw.contactConversations(b.accountId, contactId))
    .filter((c) => c.inbox_id === b.inboxId)
    .sort((a, b2) => b2.id - a.id);
  const latest = conversations[0];
  if (latest && (b.options.reopenConversation || latest.status !== 'resolved')) return latest.id;
  const created = await b.cw.createConversation(b.accountId, {
    inboxId: b.inboxId,
    contactId,
    sourceId,
    status: b.options.pendingConversations ? 'pending' : 'open',
  });
  return created.id;
}

/**
 * Chatwoot keeps phone_number and identifier unique per account, so the contact may already
 * exist from another inbox. Order: our own source_id in this inbox, then the phone (both
 * Brazilian forms), then the identifier, then create.
 */
async function resolveChatwootContact(b: Bridge, chat: WaChatRef, sourceId: string, name: string, avatarUrl: string | null): Promise<number> {
  const bySource = await b.cw.findContactBySource(b.accountId, b.inboxId, sourceId);
  if (bySource) return bySource.id;

  const identifier = chat.phone ? null : chat.chatJid;
  const existing = await findExisting(b, chat, identifier);
  if (existing) {
    await b.cw.attachContactToInbox(b.accountId, existing, b.inboxId, sourceId);
    return existing;
  }
  try {
    const created = await b.cw.createContact(b.accountId, {
      inboxId: b.inboxId,
      sourceId,
      name,
      phoneNumber: chat.phone ? `+${chat.phone}` : null,
      identifier,
      avatarUrl,
    });
    return created.contactId;
  } catch (err) {
    // Lost a race with someone creating the same contact, or the filter missed it.
    if (err instanceof ProviderError && err.status === 422) {
      const again = await findExisting(b, chat, identifier);
      if (again) {
        await b.cw.attachContactToInbox(b.accountId, again, b.inboxId, sourceId);
        return again;
      }
    }
    throw err;
  }
}

async function findExisting(b: Bridge, chat: WaChatRef, identifier: string | null): Promise<number | null> {
  if (chat.phone) {
    const phones = brazilVariants(chat.phone).map((d) => `+${d}`);
    const found = await b.cw.filterContacts(b.accountId, 'phone_number', phones);
    if (found[0]) return found[0].id;
    // Contacts created by Evolution API's Chatwoot integration use the JID as identifier.
    const byJid = await b.cw.filterContacts(b.accountId, 'identifier', brazilVariants(chat.phone).map((d) => `${d}@s.whatsapp.net`));
    if (byJid[0]) return byJid[0].id;
  }
  if (identifier) {
    const found = await b.cw.filterContacts(b.accountId, 'identifier', [identifier]);
    if (found[0]) return found[0].id;
  }
  return null;
}

/**
 * Names whatsmeow knows for a chat: the name saved in the phone's address book, or the
 * WhatsApp profile name. Cached per connection; refreshed at most once a minute on a miss.
 */
const contactCache = new Map<string, { at: number; byJid: Map<string, EvoContact> }>();

async function storedName(b: Bridge, chat: WaChatRef): Promise<string | null> {
  const lookup = (byJid: Map<string, EvoContact>) => {
    for (const jid of [chat.lid, chat.chatJid, chat.phone ? `${chat.phone}@s.whatsapp.net` : null]) {
      const c = jid ? byJid.get(jid) : undefined;
      const name = c && (c.FullName || c.FirstName || c.PushName || c.BusinessName);
      if (name?.trim()) return name.trim();
    }
    return null;
  };
  const cached = contactCache.get(b.row.id);
  if (cached) {
    const hit = lookup(cached.byJid);
    if (hit || Date.now() - cached.at < 60_000) return hit;
  }
  try {
    const list = await b.evo.listContacts(b.instanceToken);
    const byJid = new Map(list.map((c) => [c.Jid, c]));
    contactCache.set(b.row.id, { at: Date.now(), byJid });
    return lookup(byJid);
  } catch {
    contactCache.set(b.row.id, { at: Date.now(), byJid: cached?.byJid ?? new Map() });
    return null;
  }
}

/**
 * Fills in what was missing when the Chatwoot contact was created: a real name instead of the
 * placeholder, and the phone number once WhatsApp reveals it (SenderAlt/RecipientAlt).
 * Best effort: a failure here never blocks the message.
 */
async function enrichContact(ctx: Pick<Ctx, 'db' | 'log'>, b: Bridge, row: ContactRow, chat: WaChatRef, pushName: string | null): Promise<void> {
  if (!row.cw_contact_id) return;
  const patch: { name?: string; phone_number?: string } = {};
  if (row.cw_name_placeholder) {
    const name = pushName ?? (await storedName(b, chat));
    if (name) patch.name = name;
  }
  if (chat.phone && !row.phone) patch.phone_number = `+${chat.phone}`;
  if (!patch.name && !patch.phone_number) return;
  try {
    await b.cw.updateContact(b.accountId, row.cw_contact_id, patch);
  } catch (err) {
    // 422: that phone already belongs to another Chatwoot contact; keep the name update at least.
    if (patch.phone_number && err instanceof ProviderError && err.status === 422 && patch.name) {
      await b.cw.updateContact(b.accountId, row.cw_contact_id, { name: patch.name }).catch(() => undefined);
    } else {
      ctx.log.warn({ contact: row.cw_contact_id, err: err instanceof Error ? err.message : String(err) }, 'could not update Chatwoot contact');
      return;
    }
  }
  await ctx.db
    .updateTable('contacts')
    .set({ ...(patch.name ? { cw_name_placeholder: 0, push_name: patch.name } : {}), ...(chat.phone ? { phone: chat.phone } : {}), updated_at: nowIso() })
    .where('id', '=', row.id)
    .execute();
}
