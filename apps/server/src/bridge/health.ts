import type { ConnectionState, ProvisionStep } from '@evobridge/shared';
import { purgeExpiredSessions } from '../auth/auth.js';
import type { Ctx } from '../context.js';
import { ProviderError, errorMessage } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import { getConnectionRow, loadBridge, webhookUrls } from '../services/connections.js';
import { instancePhone, postNotice } from './notices.js';
import { applyRetention } from '../services/events.js';
import { chatwootClient, evolutionClient, getProviderRow, recheckProvider } from '../services/providers.js';
import { getSettings, resolvePublicUrl } from '../services/settings.js';

const DEAD_WINDOW_MS = 60 * 60 * 1000;

/**
 * Derives a connection's state from real checks: provider credentials, WhatsApp login,
 * whether both webhooks still point to EvoBridge, and recent dead-lettered messages.
 */
export async function checkConnection(ctx: Ctx, id: string): Promise<ConnectionState> {
  const row = await getConnectionRow(ctx, id);
  const set = async (state: ConnectionState, reason: string | null) => {
    await ctx.db.updateTable('connections').set({ state, state_reason: reason, last_checked_at: nowIso() }).where('id', '=', id).execute();
    return state;
  };
  if (row.paused) return set('paused', 'Paused by an administrator');
  const provisioned = (JSON.parse(row.provision) as ProvisionStep[]).every((s) => s.status === 'done' || s.status === 'skipped');
  if (!provisioned || !row.instance_token_enc || !row.inbox_id || !row.instance_id) {
    return set(row.state === 'error' ? 'error' : 'configuring', row.state_reason ?? 'Setup has not finished');
  }

  const evo = evolutionClient(ctx, await getProviderRow(ctx, row.evolution_provider_id));
  const cw = chatwootClient(ctx, await getProviderRow(ctx, row.chatwoot_provider_id));
  const { url } = await resolvePublicUrl(ctx);
  const expected = webhookUrls(url, id, ctx.box.decrypt(row.hook_secret_enc));
  const problems: string[] = [];

  try {
    const instance = await evo.getInstance(row.instance_id);
    if (instance.webhook !== expected.evolution) problems.push('The Evolution Go webhook was changed outside EvoBridge. Use "Reconfigure webhooks".');
    if (!instance.connected) {
      await notify(ctx, id, 'disconnected', instance.disconnect_reason || undefined);
      return set('disconnected', instance.disconnect_reason ? `WhatsApp is not connected (${instance.disconnect_reason})` : 'WhatsApp is not connected on this instance. Scan the QR code in Evolution Go.');
    }
  } catch (err) {
    return set(stateForError(err), `Evolution Go: ${errorMessage(err)}`);
  }

  try {
    const inbox = await cw.getInbox(row.account_id, row.inbox_id);
    if (inbox.webhook_url !== expected.chatwoot) problems.push('The Chatwoot inbox webhook was changed outside EvoBridge. Use "Reconfigure webhooks".');
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'not_found') return set('error', 'The Chatwoot inbox was deleted');
    return set(stateForError(err), `Chatwoot: ${errorMessage(err)}`);
  }

  const since = new Date(Date.now() - DEAD_WINDOW_MS).toISOString();
  const dead = await ctx.db
    .selectFrom('jobs')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('connection_id', '=', id)
    .where('status', '=', 'dead')
    .where('finished_at', '>=', since)
    .executeTakeFirstOrThrow();
  if (Number(dead.n) > 0) problems.push(`${dead.n} event${Number(dead.n) === 1 ? '' : 's'} failed in the last hour. See Events & Logs.`);

  await notify(ctx, id, 'reconnected');
  return problems.length ? set('degraded', problems.join(' ')) : set('connected', null);
}

/** Connection notices from the health loop; postNotice skips anything that repeats the last state. */
async function notify(ctx: Ctx, id: string, kind: 'disconnected' | 'reconnected', detail?: string): Promise<void> {
  const b = await loadBridge(ctx, id).catch(() => null);
  if (!b) return;
  await postNotice(ctx, b, kind, { phone: kind === 'reconnected' ? await instancePhone(b) : null, detail });
}

function stateForError(err: unknown): ConnectionState {
  if (err instanceof ProviderError && (err.kind === 'unreachable' || err.kind === 'timeout' || err.kind === 'server_error')) return 'degraded';
  return 'error';
}

/** Background maintenance: provider and connection checks every minute, retention hourly. */
export class HealthLoop {
  #timer: NodeJS.Timeout | null = null;
  #lastRetention = 0;
  #busy = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    this.#timer = setInterval(() => void this.tick(), this.intervalMs);
    setTimeout(() => void this.tick(), 3_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const providers = await this.ctx.db.selectFrom('providers').select('id').execute();
      for (const p of providers) await recheckProvider(this.ctx, p.id).catch((err) => this.ctx.log.warn({ err: errorMessage(err) }, 'provider check failed'));
      const connections = await this.ctx.db.selectFrom('connections').select('id').execute();
      for (const c of connections) await checkConnection(this.ctx, c.id).catch((err) => this.ctx.log.warn({ err: errorMessage(err) }, 'connection check failed'));
      if (Date.now() - this.#lastRetention > 60 * 60 * 1000) {
        this.#lastRetention = Date.now();
        const { retentionDays } = await getSettings(this.ctx);
        await applyRetention(this.ctx, retentionDays);
        await purgeExpiredSessions(this.ctx);
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'health loop failed');
    } finally {
      this.#busy = false;
    }
  }
}
