import type { Ctx } from '../context.js';
import type { Selectable } from 'kysely';
import type { ContactsTable } from '../db/schema.js';
import { ProviderError } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { WaChatRef } from '../providers/evolution-go/normalize.js';
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
    if (chat.phone && !row.phone) patch.phone = chat.phone;
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
    contactId = await resolveChatwootContact(b, chat, sourceId, displayName(chat, opts.pushName, opts.groupName));
    await ctx.db.updateTable('contacts').set({ cw_contact_id: contactId, cw_source_id: sourceId, updated_at: nowIso() }).where('id', '=', row.id).execute();
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
async function resolveChatwootContact(b: Bridge, chat: WaChatRef, sourceId: string, name: string): Promise<number> {
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
