import type {
  ChatwootAccountDto,
  ChatwootInboxDto,
  EvolutionInstanceDto,
  ProviderCheck,
  ProviderCreateInput,
  ProviderDto,
  ProviderKind,
  ProviderTestInput,
  ProviderUpdateInput,
} from '@evobridge/shared';
import { PROVIDER_LABELS } from '@evobridge/shared';
import type { Ctx } from '../context.js';
import type { ProvidersTable } from '../db/schema.js';
import { maskSecret } from '../lib/crypto.js';
import { AppError, ProviderError, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { ChatwootClient } from '../providers/chatwoot/client.js';
import { EvolutionGoClient } from '../providers/evolution-go/client.js';
import { phoneOf, stripDevice } from '../providers/evolution-go/normalize.js';

type ProviderRow = ProvidersTable;

export function evolutionClient(ctx: Pick<Ctx, 'http' | 'box'>, row: ProviderRow): EvolutionGoClient {
  return new EvolutionGoClient(ctx.http, row.base_url, ctx.box.decrypt(row.secret_enc));
}

export function chatwootClient(ctx: Pick<Ctx, 'http' | 'box'>, row: ProviderRow): ChatwootClient {
  return new ChatwootClient(ctx.http, row.base_url, ctx.box.decrypt(row.secret_enc));
}

function clientFor(ctx: Pick<Ctx, 'http'>, kind: ProviderKind, baseUrl: string, secret: string) {
  return kind === 'evolution_go' ? new EvolutionGoClient(ctx.http, baseUrl, secret) : new ChatwootClient(ctx.http, baseUrl, secret);
}

export async function testProvider(ctx: Pick<Ctx, 'http'>, input: ProviderTestInput): Promise<ProviderCheck> {
  return clientFor(ctx, input.kind, input.baseUrl, input.secret).check();
}

export async function getProviderRow(ctx: Pick<Ctx, 'db'>, id: string, kind?: ProviderKind): Promise<ProviderRow> {
  const row = await ctx.db.selectFrom('providers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row || (kind && row.kind !== kind)) throw notFound(kind ? PROVIDER_LABELS[kind] : 'Provider');
  return row;
}

async function toDto(ctx: Pick<Ctx, 'db'>, row: ProviderRow): Promise<ProviderDto> {
  const column = row.kind === 'evolution_go' ? 'evolution_provider_id' : 'chatwoot_provider_id';
  const count = await ctx.db
    .selectFrom('connections')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where(column, '=', row.id)
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    secretPreview: row.secret_preview,
    status: row.status as ProviderDto['status'],
    statusMessage: row.status_message,
    lastCheckedAt: row.last_checked_at,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    connectionCount: Number(count.n),
    createdAt: row.created_at,
  };
}

export async function listProviders(ctx: Pick<Ctx, 'db'>): Promise<ProviderDto[]> {
  const rows = await ctx.db.selectFrom('providers').selectAll().orderBy('created_at', 'asc').execute();
  return Promise.all(rows.map((r) => toDto(ctx, r)));
}

export async function getProvider(ctx: Pick<Ctx, 'db'>, id: string): Promise<ProviderDto> {
  return toDto(ctx, await getProviderRow(ctx, id));
}

function defaultName(kind: ProviderKind, baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return PROVIDER_LABELS[kind];
  }
}

/** Saves a provider only after its credentials work, so the wizard can't store a broken one. */
export async function createProvider(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, input: ProviderCreateInput): Promise<{ provider: ProviderDto; check: ProviderCheck }> {
  const check = await testProvider(ctx, input);
  if (!check.ok) throw new AppError(422, 'provider_check_failed', check.message, check.hint);
  const duplicate = await ctx.db
    .selectFrom('providers')
    .select('id')
    .where('kind', '=', input.kind)
    .where('base_url', '=', input.baseUrl)
    .executeTakeFirst();
  if (duplicate) {
    // Same server added twice: update credentials instead of creating a twin.
    const provider = await updateProvider(ctx, duplicate.id, { secret: input.secret, name: input.name });
    return { provider, check };
  }
  const at = nowIso();
  const id = newId('prv');
  await ctx.db
    .insertInto('providers')
    .values({
      id,
      kind: input.kind,
      name: input.name?.trim() || defaultName(input.kind, input.baseUrl),
      base_url: input.baseUrl,
      secret_enc: ctx.box.encrypt(input.secret),
      secret_preview: maskSecret(input.secret),
      status: check.status,
      status_message: check.message,
      meta: JSON.stringify(check.details ?? {}),
      last_checked_at: at,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return { provider: await getProvider(ctx, id), check };
}

export async function updateProvider(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, id: string, input: ProviderUpdateInput): Promise<ProviderDto> {
  const row = await getProviderRow(ctx, id);
  const baseUrl = input.baseUrl ?? row.base_url;
  const secret = input.secret?.trim() ? input.secret.trim() : ctx.box.decrypt(row.secret_enc);
  if (input.baseUrl || input.secret?.trim()) {
    const check = await testProvider(ctx, { kind: row.kind, baseUrl, secret });
    if (!check.ok) throw new AppError(422, 'provider_check_failed', check.message, check.hint);
  }
  await ctx.db
    .updateTable('providers')
    .set({
      name: input.name?.trim() || row.name,
      base_url: baseUrl,
      secret_enc: ctx.box.encrypt(secret),
      secret_preview: maskSecret(secret),
      updated_at: nowIso(),
    })
    .where('id', '=', id)
    .execute();
  return getProvider(ctx, id);
}

export async function deleteProvider(ctx: Pick<Ctx, 'db'>, id: string): Promise<void> {
  const dto = await getProvider(ctx, id);
  if (dto.connectionCount > 0) {
    throw new AppError(409, 'provider_in_use', `${dto.name} is used by ${dto.connectionCount} connection(s)`, 'Remove those connections first.');
  }
  await ctx.db.deleteFrom('providers').where('id', '=', id).execute();
}

/** Re-checks a stored provider and records the result (used by the dashboard and the health loop). */
export async function recheckProvider(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, id: string): Promise<ProviderCheck> {
  const row = await getProviderRow(ctx, id);
  const client = row.kind === 'evolution_go' ? evolutionClient(ctx, row) : chatwootClient(ctx, row);
  const check = await client.check();
  const meta = { ...(JSON.parse(row.meta) as Record<string, unknown>), ...(check.details ?? {}) };
  await ctx.db
    .updateTable('providers')
    .set({ status: check.status, status_message: check.message, meta: JSON.stringify(meta), last_checked_at: nowIso() })
    .where('id', '=', id)
    .execute();
  return check;
}

export async function listEvolutionInstances(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, providerId: string): Promise<EvolutionInstanceDto[]> {
  const row = await getProviderRow(ctx, providerId, 'evolution_go');
  const instances = await evolutionClient(ctx, row).listInstances();
  const used = await ctx.db.selectFrom('connections').select(['id', 'name', 'instance_name']).where('evolution_provider_id', '=', providerId).execute();
  return instances
    .map((i) => {
      const own = stripDevice(i.jid);
      return {
        id: i.id,
        name: i.name,
        connected: Boolean(i.connected),
        phone: own ? phoneOf(own) : null,
        profileName: null,
        webhookUrl: i.webhook && i.webhook !== 'disabled' ? i.webhook : null,
        usedBy: (() => {
          const c = used.find((u) => u.instance_name === i.name);
          return c ? { id: c.id, name: c.name } : null;
        })(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listChatwootAccounts(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, providerId: string): Promise<ChatwootAccountDto[]> {
  const row = await getProviderRow(ctx, providerId, 'chatwoot');
  const profile = await chatwootClient(ctx, row).profile();
  return profile.accounts.filter((a) => !a.status || a.status === 'active').map((a) => ({ id: a.id, name: a.name, role: a.role }));
}

export async function listChatwootInboxes(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, providerId: string, accountId: number): Promise<ChatwootInboxDto[]> {
  const row = await getProviderRow(ctx, providerId, 'chatwoot');
  try {
    const inboxes = await chatwootClient(ctx, row).listInboxes(accountId);
    return inboxes.map((i) => ({
      id: i.id,
      name: i.name,
      channelType: i.channel_type,
      bridgeable: i.channel_type === 'Channel::Api',
      webhookUrl: i.webhook_url ?? null,
    }));
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'not_found') throw notFound('Chatwoot account');
    throw err;
  }
}
