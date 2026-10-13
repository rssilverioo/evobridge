import {
  type ConnectionCreateInput,
  type ConnectionDto,
  PROVISION_STEPS,
  type ProvisionStep,
  type ProvisionStepId,
  connectionOptionsSchema,
} from '@evobridge/shared';
import { checkPublicUrl } from '../bridge/selfcheck.js';
import type { Ctx } from '../context.js';
import { randomToken } from '../lib/crypto.js';
import { AppError, ProviderError, conflict, errorMessage } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import type { CwInbox } from '../providers/chatwoot/types.js';
import { REQUIRED_EVENTS } from '../providers/evolution-go/types.js';
import { type ConnectionRow, getConnection, getConnectionRow, webhookUrls } from './connections.js';
import { recordEvent } from './events.js';
import { chatwootClient, evolutionClient, getProviderRow } from './providers.js';
import { resolvePublicUrl } from './settings.js';

type StepResult = Omit<ProvisionStep, 'id' | 'at'>;

const isOurs = (url: string | null | undefined, connectionId: string) => Boolean(url?.includes(`/hooks/evolution/${connectionId}/`) || url?.includes(`/hooks/chatwoot/${connectionId}/`));
const isEvoBridgeUrl = (url: string | null | undefined) => Boolean(url && /\/hooks\/(evolution|chatwoot)\/con_[a-z0-9]+\//.test(url));
const hasWebhook = (url: string | null | undefined) => Boolean(url && url !== 'disabled');

/** Creates the connection row, then provisions it. Returns the connection with per-step results. */
export async function createConnection(ctx: Ctx, input: ConnectionCreateInput): Promise<ConnectionDto> {
  const evoRow = await getProviderRow(ctx, input.evolutionProviderId, 'evolution_go');
  await getProviderRow(ctx, input.chatwootProviderId, 'chatwoot');

  const existing = await ctx.db
    .selectFrom('connections')
    .select('name')
    .where('evolution_provider_id', '=', input.evolutionProviderId)
    .where('instance_name', '=', input.instanceName)
    .executeTakeFirst();
  if (existing) throw conflict(`Instance ${input.instanceName} is already bridged by "${existing.name}"`, 'One instance can feed only one inbox; otherwise every message would be delivered twice.');
  if (input.inbox.mode === 'existing') {
    const inboxId = input.inbox.inboxId;
    const used = await ctx.db
      .selectFrom('connections')
      .select('name')
      .where('chatwoot_provider_id', '=', input.chatwootProviderId)
      .where('account_id', '=', input.accountId)
      .where('inbox_id', '=', inboxId)
      .executeTakeFirst();
    if (used) throw conflict(`That inbox is already used by "${used.name}"`);
  }

  const at = nowIso();
  const id = newId('con');
  const options = connectionOptionsSchema.parse(input.options ?? {});
  await ctx.db
    .insertInto('connections')
    .values({
      id,
      name: input.name?.trim() || `${input.instanceName} → ${input.inbox.mode === 'create' ? input.inbox.inboxName : 'Chatwoot'}`,
      evolution_provider_id: evoRow.id,
      instance_id: null,
      instance_name: input.instanceName,
      instance_token_enc: null,
      chatwoot_provider_id: input.chatwootProviderId,
      account_id: input.accountId,
      inbox_id: input.inbox.mode === 'existing' ? input.inbox.inboxId : null,
      inbox_name: input.inbox.mode === 'create' ? input.inbox.inboxName : null,
      hook_secret_enc: ctx.box.encrypt(randomToken(32)),
      chatwoot_hmac_enc: null,
      previous_evo_webhook_url: null,
      previous_cw_webhook_url: null,
      state: 'configuring',
      state_reason: 'Provisioning',
      paused: 0,
      options: JSON.stringify(options),
      provision: JSON.stringify(PROVISION_STEPS.map((s) => ({ id: s, status: 'pending' }))),
      last_activity_at: null,
      last_checked_at: null,
      created_at: at,
      updated_at: at,
    })
    .execute();

  await provisionConnection(ctx, id, { replaceExistingWebhooks: input.replaceExistingWebhooks });
  return getConnection(ctx, id);
}

/**
 * Runs every provisioning step in order. Each step is idempotent, so this is also how a
 * failed setup is resumed and how "Reconfigure webhooks" works. Stops at the first step that
 * fails or needs the user.
 */
export async function provisionConnection(ctx: Ctx, id: string, opts: { replaceExistingWebhooks: boolean }): Promise<ProvisionStep[]> {
  const steps: ProvisionStep[] = PROVISION_STEPS.map((s) => ({ id: s, status: 'pending' }));
  const save = async (state?: { state: string; reason: string | null }) => {
    await ctx.db
      .updateTable('connections')
      .set({ provision: JSON.stringify(steps), updated_at: nowIso(), ...(state ? { state: state.state, state_reason: state.reason } : {}) })
      .where('id', '=', id)
      .execute();
  };
  await save({ state: 'configuring', reason: 'Provisioning' });

  const run: Record<ProvisionStepId, () => Promise<StepResult>> = {
    validate: () => stepValidate(ctx, id),
    register: async () => ({ status: 'done', message: 'Connection saved' }),
    chatwoot_inbox: () => stepChatwootInbox(ctx, id),
    evolution_webhook: () => stepEvolutionWebhook(ctx, id, opts.replaceExistingWebhooks),
    chatwoot_callback: () => stepChatwootCallback(ctx, id, opts.replaceExistingWebhooks),
    reachability: () => stepReachability(ctx),
    health: () => stepHealth(ctx, id),
    activate: () => stepActivate(ctx, id),
  };

  for (const step of steps) {
    step.status = 'running';
    step.at = nowIso();
    await save();
    let result: StepResult;
    try {
      result = await run[step.id]();
    } catch (err) {
      result = { status: 'failed', message: errorMessage(err), ...(err instanceof ProviderError && err.hint ? { instructions: [err.hint] } : {}) };
    }
    Object.assign(step, result, { at: nowIso() });
    const outcome = result.status;
    if (outcome === 'failed' || outcome === 'action_required') {
      const reason = step.message ?? 'Setup could not finish';
      await save({ state: outcome === 'failed' ? 'error' : 'configuring', reason });
      await recordEvent(ctx, {
        connectionId: id,
        source: 'evobridge',
        direction: 'system',
        type: `provision.${step.id}`,
        status: 'failed',
        error: reason,
      });
      return steps;
    }
    await save();
  }
  await recordEvent(ctx, { connectionId: id, source: 'evobridge', direction: 'system', type: 'provision.completed', status: 'processed' });
  return steps;
}

async function stepValidate(ctx: Ctx, id: string): Promise<StepResult> {
  const row = await getConnectionRow(ctx, id);
  const { url } = await resolvePublicUrl(ctx);
  if (!url) {
    return {
      status: 'action_required',
      message: 'EvoBridge needs a public URL so Evolution Go and Chatwoot can reach it',
      instructions: ['Open Settings and set the Public URL (for example https://evobridge.example.com), or set PUBLIC_URL in the container.'],
    };
  }
  const evo = evolutionClient(ctx, await getProviderRow(ctx, row.evolution_provider_id));
  const cw = chatwootClient(ctx, await getProviderRow(ctx, row.chatwoot_provider_id));
  const instances = await evo.listInstances();
  if (!instances.some((i) => i.name === row.instance_name)) {
    return { status: 'failed', message: `Instance "${row.instance_name}" was not found on Evolution Go` };
  }
  const profile = await cw.profile();
  const account = profile.accounts.find((a) => a.id === row.account_id);
  if (!account) return { status: 'failed', message: `This Chatwoot user has no access to account #${row.account_id}` };
  if (account.role !== 'administrator') {
    return {
      status: 'action_required',
      message: `${profile.name} is an agent on "${account.name}"; creating inboxes and webhooks needs an administrator`,
      instructions: ['In Chatwoot, use the access token of a user with the Administrator role, then update the Chatwoot provider in EvoBridge.'],
    };
  }
  return { status: 'done', message: 'Evolution Go, Chatwoot and the public URL are ready' };
}

async function stepChatwootInbox(ctx: Ctx, id: string): Promise<StepResult> {
  const row = await getConnectionRow(ctx, id);
  const cw = chatwootClient(ctx, await getProviderRow(ctx, row.chatwoot_provider_id));
  const { url } = await resolvePublicUrl(ctx);
  const urls = webhookUrls(url, id, ctx.box.decrypt(row.hook_secret_enc));
  let inbox: CwInbox;
  let created = false;
  if (row.inbox_id) {
    try {
      inbox = await cw.getInbox(row.account_id, row.inbox_id);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return { status: 'failed', message: `Inbox #${row.inbox_id} no longer exists in Chatwoot` };
      throw err;
    }
    if (inbox.channel_type !== 'Channel::Api') {
      return {
        status: 'failed',
        message: `"${inbox.name}" is a ${inbox.channel_type.replace('Channel::', '')} inbox; only API inboxes can be bridged`,
        instructions: ['Choose an API inbox, or let EvoBridge create one.'],
      };
    }
  } else {
    inbox = await cw.createApiInbox(row.account_id, row.inbox_name ?? row.instance_name, urls.chatwoot);
    created = true;
  }
  await ctx.db
    .updateTable('connections')
    .set({
      inbox_id: inbox.id,
      inbox_name: inbox.name,
      chatwoot_hmac_enc: inbox.secret ? ctx.box.encrypt(inbox.secret) : null,
      updated_at: nowIso(),
    })
    .where('id', '=', id)
    .execute();
  const signing = inbox.secret ? 'Webhook signatures will be verified.' : 'This Chatwoot version does not sign webhooks; the secret URL protects it.';
  return { status: 'done', message: `${created ? 'Created' : 'Using'} inbox "${inbox.name}". ${signing}` };
}

async function stepEvolutionWebhook(ctx: Ctx, id: string, replace: boolean): Promise<StepResult> {
  const row = await getConnectionRow(ctx, id);
  const evo = evolutionClient(ctx, await getProviderRow(ctx, row.evolution_provider_id));
  const { url } = await resolvePublicUrl(ctx);
  const target = webhookUrls(url, id, ctx.box.decrypt(row.hook_secret_enc)).evolution;
  const instance = (await evo.listInstances()).find((i) => i.name === row.instance_name);
  if (!instance) return { status: 'failed', message: `Instance "${row.instance_name}" was not found on Evolution Go` };

  let previous = row.previous_evo_webhook_url;
  if (hasWebhook(instance.webhook) && instance.webhook !== target && !isOurs(instance.webhook, id)) {
    if (isEvoBridgeUrl(instance.webhook)) {
      return { status: 'failed', message: 'This instance is already bridged by another EvoBridge connection or installation' };
    }
    if (!replace) {
      return {
        status: 'action_required',
        message: `The instance already sends events to ${instance.webhook}`,
        instructions: [
          'Evolution Go supports a single webhook per instance.',
          'Confirm to let EvoBridge take over. It will forward every event to that URL, so the other service keeps working.',
        ],
      };
    }
    previous = instance.webhook;
  }

  const existingEvents = instance.events.split(',').map((e) => e.trim()).filter(Boolean);
  const subscribe = existingEvents.includes('ALL') ? ['ALL'] : [...new Set([...existingEvents, ...REQUIRED_EVENTS])];
  // Every field is overwritten by this call, so the other channels are sent back unchanged.
  await evo.configureInstance(instance.token, {
    webhookUrl: target,
    subscribe,
    rabbitmqEnable: instance.rabbitmqEnable ?? '',
    websocketEnable: instance.websocketEnable ?? '',
    natsEnable: instance.natsEnable ?? '',
  });
  const after = await evo.getInstance(instance.id);
  if (after.webhook !== target) {
    return { status: 'failed', message: 'Evolution Go accepted the request, but the instance webhook did not change' };
  }
  await ctx.db
    .updateTable('connections')
    .set({ instance_id: instance.id, instance_token_enc: ctx.box.encrypt(instance.token), previous_evo_webhook_url: previous, updated_at: nowIso() })
    .where('id', '=', id)
    .execute();
  const forward = previous ? ` Events are also forwarded to ${previous}.` : '';
  return { status: 'done', message: `Instance webhook set, subscribed to ${subscribe.join(', ')}.${forward}` };
}

async function stepChatwootCallback(ctx: Ctx, id: string, replace: boolean): Promise<StepResult> {
  const row = await getConnectionRow(ctx, id);
  if (!row.inbox_id) return { status: 'failed', message: 'No inbox selected' };
  const cw = chatwootClient(ctx, await getProviderRow(ctx, row.chatwoot_provider_id));
  const { url } = await resolvePublicUrl(ctx);
  const target = webhookUrls(url, id, ctx.box.decrypt(row.hook_secret_enc)).chatwoot;
  const inbox = await cw.getInbox(row.account_id, row.inbox_id);
  let previous = row.previous_cw_webhook_url;
  if (inbox.webhook_url !== target) {
    if (inbox.webhook_url && !isOurs(inbox.webhook_url, id)) {
      if (isEvoBridgeUrl(inbox.webhook_url)) return { status: 'failed', message: 'This inbox is already bridged by another EvoBridge connection or installation' };
      if (!replace) {
        return {
          status: 'action_required',
          message: `The inbox already sends events to ${inbox.webhook_url}`,
          instructions: ['A Chatwoot API inbox has a single webhook URL.', 'Confirm to let EvoBridge take over and forward events to that URL.'],
        };
      }
      previous = inbox.webhook_url;
    }
    await cw.setInboxWebhook(row.account_id, row.inbox_id, target);
  }
  const after = await cw.getInbox(row.account_id, row.inbox_id);
  if (after.webhook_url !== target) return { status: 'failed', message: 'Chatwoot accepted the request, but the inbox webhook did not change' };
  await ctx.db
    .updateTable('connections')
    .set({ previous_cw_webhook_url: previous, chatwoot_hmac_enc: after.secret ? ctx.box.encrypt(after.secret) : row.chatwoot_hmac_enc, updated_at: nowIso() })
    .where('id', '=', id)
    .execute();
  return { status: 'done', message: `Agent replies in "${after.name}" are delivered to EvoBridge` };
}

async function stepReachability(ctx: Ctx): Promise<StepResult> {
  const { url } = await resolvePublicUrl(ctx);
  const res = await checkPublicUrl(ctx.http, url);
  if (res.ok) return { status: 'done', message: res.message };
  if (res.privateAddress) {
    return {
      status: 'done',
      message: `${res.message}. That works only if Evolution Go and Chatwoot are on the same network.`,
      instructions: ['Chatwoot 4.14+ only calls private addresses when SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true is set on its rails and sidekiq containers.'],
    };
  }
  return {
    status: 'action_required',
    message: res.message,
    instructions: ['Check that the Public URL in Settings is the address this EvoBridge is served on, and that your proxy forwards /hooks/* to it.'],
  };
}

async function stepHealth(ctx: Ctx, id: string): Promise<StepResult> {
  const row = await getConnectionRow(ctx, id);
  const evo = evolutionClient(ctx, await getProviderRow(ctx, row.evolution_provider_id));
  if (!row.instance_token_enc) return { status: 'failed', message: 'Instance token missing' };
  const status = await evo.instanceStatus(ctx.box.decrypt(row.instance_token_enc));
  if (!status.LoggedIn) {
    return {
      status: 'done',
      message: 'Webhooks are in place, but the WhatsApp number is not logged in on this instance yet',
      instructions: ['Open the Evolution Go Manager and scan the QR code for this instance. Messages start flowing as soon as it connects.'],
    };
  }
  return { status: 'done', message: status.Connected ? 'WhatsApp is connected' : 'WhatsApp is logged in and reconnecting' };
}

async function stepActivate(ctx: Ctx, id: string): Promise<StepResult> {
  const row = await getConnectionRow(ctx, id);
  const evo = evolutionClient(ctx, await getProviderRow(ctx, row.evolution_provider_id));
  const status = row.instance_token_enc ? await evo.instanceStatus(ctx.box.decrypt(row.instance_token_enc)).catch(() => null) : null;
  const state = row.paused ? 'paused' : status?.LoggedIn ? 'connected' : 'disconnected';
  const reason = row.paused ? 'Paused by an administrator' : status?.LoggedIn ? null : 'WhatsApp number not logged in on Evolution Go';
  await ctx.db.updateTable('connections').set({ state, state_reason: reason, last_checked_at: nowIso(), updated_at: nowIso() }).where('id', '=', id).execute();
  return { status: 'done', message: row.paused ? 'Ready; resume the connection to start syncing' : 'Two-way sync is active' };
}

/**
 * Deletes the connection. Remote webhooks are only touched when explicitly asked, and then
 * restored to what they were before EvoBridge (or cleared) without changing anything else.
 */
export async function deleteConnection(ctx: Ctx, id: string, opts: { removeRemoteWebhooks: boolean }): Promise<{ warnings: string[] }> {
  const row = await getConnectionRow(ctx, id);
  const warnings: string[] = [];
  if (opts.removeRemoteWebhooks) {
    await restoreEvolutionWebhook(ctx, row).catch((err) => warnings.push(`Evolution Go: ${errorMessage(err)}`));
    await restoreChatwootWebhook(ctx, row).catch((err) => warnings.push(`Chatwoot: ${errorMessage(err)}`));
  }
  await ctx.db.deleteFrom('connections').where('id', '=', id).execute();
  return { warnings };
}

async function restoreEvolutionWebhook(ctx: Ctx, row: ConnectionRow): Promise<void> {
  if (!row.instance_id) return;
  const evo = evolutionClient(ctx, await getProviderRow(ctx, row.evolution_provider_id));
  const instance = await evo.getInstance(row.instance_id);
  if (!isOurs(instance.webhook, row.id)) return; // someone else changed it since; leave it alone
  await evo.configureInstance(instance.token, {
    webhookUrl: row.previous_evo_webhook_url ?? '',
    subscribe: instance.events.split(',').map((e) => e.trim()).filter(Boolean),
    rabbitmqEnable: instance.rabbitmqEnable ?? '',
    websocketEnable: instance.websocketEnable ?? '',
    natsEnable: instance.natsEnable ?? '',
  });
}

async function restoreChatwootWebhook(ctx: Ctx, row: ConnectionRow): Promise<void> {
  if (!row.inbox_id) return;
  const cw = chatwootClient(ctx, await getProviderRow(ctx, row.chatwoot_provider_id));
  const inbox = await cw.getInbox(row.account_id, row.inbox_id);
  if (!isOurs(inbox.webhook_url, row.id)) return;
  await cw.setInboxWebhook(row.account_id, row.inbox_id, row.previous_cw_webhook_url ?? '');
}

export function assertProvisioned(row: ConnectionRow): void {
  if (!row.instance_token_enc || !row.inbox_id) throw new AppError(409, 'not_provisioned', 'This connection has not finished provisioning');
}
