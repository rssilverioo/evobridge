import {
  type ConnectionDto,
  type ConnectionOptions,
  type ConnectionState,
  type ConnectionUpdateInput,
  type ProvisionStep,
  connectionOptionsSchema,
} from '@evobridge/shared';
import type { Ctx } from '../context.js';
import type { ConnectionsTable } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import type { ChatwootClient } from '../providers/chatwoot/client.js';
import type { EvolutionGoClient } from '../providers/evolution-go/client.js';
import { eventCounts } from './events.js';
import { chatwootClient, evolutionClient, getProviderRow } from './providers.js';
import { resolvePublicUrl } from './settings.js';

export type ConnectionRow = ConnectionsTable;

export function parseOptions(raw: string): ConnectionOptions {
  return connectionOptionsSchema.parse(JSON.parse(raw || '{}'));
}

export async function getConnectionRow(ctx: Pick<Ctx, 'db'>, id: string): Promise<ConnectionRow> {
  const row = await ctx.db.selectFrom('connections').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Connection');
  return row;
}

export function webhookUrls(publicUrl: string, connectionId: string, secret: string): { evolution: string; chatwoot: string } {
  return {
    evolution: `${publicUrl}/hooks/evolution/${connectionId}/${secret}`,
    chatwoot: `${publicUrl}/hooks/chatwoot/${connectionId}/${secret}`,
  };
}

export async function toConnectionDto(ctx: Pick<Ctx, 'db' | 'config'>, row: ConnectionRow): Promise<ConnectionDto> {
  const [evo, cw] = await Promise.all([getProviderRow(ctx, row.evolution_provider_id), getProviderRow(ctx, row.chatwoot_provider_id)]);
  const { url } = await resolvePublicUrl(ctx);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stats = await eventCounts(ctx, since, row.id);
  const base = url || '<public-url>';
  return {
    id: row.id,
    name: row.name,
    state: row.state as ConnectionState,
    stateReason: row.state_reason,
    paused: Boolean(row.paused),
    evolution: { providerId: evo.id, providerName: evo.name, instanceName: row.instance_name, instanceId: row.instance_id },
    chatwoot: { providerId: cw.id, providerName: cw.name, accountId: row.account_id, inboxId: row.inbox_id, inboxName: row.inbox_name },
    options: parseOptions(row.options),
    provision: JSON.parse(row.provision) as ProvisionStep[],
    // The secret segment is never sent to the browser.
    webhookUrls: { evolution: `${base}/hooks/evolution/${row.id}/••••`, chatwoot: `${base}/hooks/chatwoot/${row.id}/••••` },
    stats: { processed24h: stats.processed, failed24h: stats.failed },
    lastActivityAt: row.last_activity_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

export async function listConnections(ctx: Pick<Ctx, 'db' | 'config'>): Promise<ConnectionDto[]> {
  const rows = await ctx.db.selectFrom('connections').selectAll().orderBy('created_at', 'asc').execute();
  return Promise.all(rows.map((r) => toConnectionDto(ctx, r)));
}

export async function getConnection(ctx: Pick<Ctx, 'db' | 'config'>, id: string): Promise<ConnectionDto> {
  return toConnectionDto(ctx, await getConnectionRow(ctx, id));
}

export async function updateConnection(ctx: Pick<Ctx, 'db' | 'config'>, id: string, input: ConnectionUpdateInput): Promise<ConnectionDto> {
  const row = await getConnectionRow(ctx, id);
  const options = connectionOptionsSchema.parse({ ...parseOptions(row.options), ...(input.options ?? {}) });
  await ctx.db
    .updateTable('connections')
    .set({ name: input.name ?? row.name, options: JSON.stringify(options), updated_at: nowIso() })
    .where('id', '=', id)
    .execute();
  return getConnection(ctx, id);
}

export async function setConnectionState(ctx: Pick<Ctx, 'db'>, id: string, state: ConnectionState, reason: string | null): Promise<void> {
  await ctx.db.updateTable('connections').set({ state, state_reason: reason, updated_at: nowIso() }).where('id', '=', id).execute();
}

export async function setPaused(ctx: Pick<Ctx, 'db' | 'config'>, id: string, paused: boolean): Promise<ConnectionDto> {
  const row = await getConnectionRow(ctx, id);
  const provisioned = (JSON.parse(row.provision) as ProvisionStep[]).every((s) => s.status === 'done' || s.status === 'skipped');
  await ctx.db
    .updateTable('connections')
    .set({
      paused: paused ? 1 : 0,
      state: paused ? 'paused' : provisioned ? 'connected' : 'configuring',
      state_reason: paused ? 'Paused by an administrator' : null,
      updated_at: nowIso(),
    })
    .where('id', '=', id)
    .execute();
  return getConnection(ctx, id);
}

export async function touchActivity(ctx: Pick<Ctx, 'db'>, id: string): Promise<void> {
  await ctx.db.updateTable('connections').set({ last_activity_at: nowIso() }).where('id', '=', id).execute();
}

/** Everything a handler needs to move messages for one connection, with secrets decrypted. */
export interface Bridge {
  row: ConnectionRow;
  options: ConnectionOptions;
  evo: EvolutionGoClient;
  cw: ChatwootClient;
  instanceToken: string;
  accountId: number;
  inboxId: number;
}

export async function loadBridge(ctx: Pick<Ctx, 'db' | 'http' | 'box'>, id: string): Promise<Bridge> {
  const row = await getConnectionRow(ctx, id);
  const [evoRow, cwRow] = await Promise.all([getProviderRow(ctx, row.evolution_provider_id), getProviderRow(ctx, row.chatwoot_provider_id)]);
  if (!row.instance_token_enc || !row.inbox_id) throw new Error('Connection is not fully provisioned');
  return {
    row,
    options: parseOptions(row.options),
    evo: evolutionClient(ctx, evoRow),
    cw: chatwootClient(ctx, cwRow),
    instanceToken: ctx.box.decrypt(row.instance_token_enc),
    accountId: row.account_id,
    inboxId: row.inbox_id,
  };
}
