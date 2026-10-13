import type { EvolutionInstanceDto, PairingState } from '@evobridge/shared';
import type { Ctx } from '../context.js';
import { randomToken } from '../lib/crypto.js';
import { AppError, ProviderError, conflict, notFound } from '../lib/errors.js';
import { phoneOf, stripDevice } from '../providers/evolution-go/normalize.js';
import { evolutionClient, getProviderRow } from './providers.js';

/**
 * Creating and pairing WhatsApp instances from the dashboard, so nobody needs the Evolution Go
 * Manager. Instance tokens are read with the global key on each call and never leave the server.
 */
async function instanceContext(ctx: Ctx, providerId: string, instanceId: string) {
  const evo = evolutionClient(ctx, await getProviderRow(ctx, providerId, 'evolution_go'));
  const instance = (await evo.listInstances()).find((i) => i.id === instanceId);
  if (!instance) throw notFound('Instance');
  return { evo, instance };
}

export async function createInstance(ctx: Ctx, providerId: string, name: string): Promise<EvolutionInstanceDto> {
  const evo = evolutionClient(ctx, await getProviderRow(ctx, providerId, 'evolution_go'));
  if ((await evo.listInstances()).some((i) => i.name.toLowerCase() === name.toLowerCase())) {
    throw conflict(`An instance named "${name}" already exists`);
  }
  const created = await evo.createInstance(name, randomToken(24));
  return { id: created.id, name: created.name, connected: false, phone: null, profileName: null, webhookUrl: null };
}

export async function pairingState(ctx: Ctx, providerId: string, instanceId: string): Promise<PairingState> {
  const { evo, instance } = await instanceContext(ctx, providerId, instanceId);
  const status = await evo.instanceStatus(instance.token).catch(() => null);
  if (status?.LoggedIn) {
    const jid = stripDevice((await evo.getInstance(instance.id).catch(() => instance)).jid);
    return { status: 'logged_in', phone: jid ? phoneOf(jid) : null };
  }
  try {
    const qr = await evo.getQr(instance.token);
    if (qr.passkeyOpenUrl) return { status: 'passkey', openUrl: qr.passkeyOpenUrl, stage: qr.passkeyStage ?? '' };
    if (qr.qrcode?.startsWith('data:image/')) return { status: 'qr', qr: qr.qrcode };
    return { status: 'waiting', message: 'Generating the QR code' };
  } catch (err) {
    if (err instanceof ProviderError && /already logged in/i.test(err.message)) return { status: 'logged_in', phone: null };
    if (err instanceof ProviderError && (err.kind === 'server_error' || err.kind === 'timeout')) {
      return { status: 'waiting', message: 'Generating the QR code' };
    }
    throw err;
  }
}

export async function pairWithPhone(ctx: Ctx, providerId: string, instanceId: string, phone: string): Promise<{ code: string }> {
  const { evo, instance } = await instanceContext(ctx, providerId, instanceId);
  const status = await evo.instanceStatus(instance.token).catch(() => null);
  if (status?.LoggedIn) throw new AppError(409, 'already_connected', 'This instance is already connected to WhatsApp');
  return { code: await evo.pairPhone(instance.token, phone) };
}
