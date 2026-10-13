import { randomToken } from '../lib/crypto.js';
import { ProviderError } from '../lib/errors.js';
import type { HttpClient } from '../lib/http.js';

/** Identifies this process, so a self-check proves the public URL reaches *this* EvoBridge. */
export const PROCESS_ID = randomToken(12);

const pending = new Set<string>();

export function answerPing(nonce: string): { ok: boolean; process: string } {
  return { ok: pending.has(nonce), process: PROCESS_ID };
}

export type ReachabilityResult =
  | { ok: true; message: string }
  | { ok: false; privateAddress: boolean; message: string };

/**
 * Calls `<publicUrl>/hooks/ping/<nonce>` through the normal (SSRF-guarded) client.
 * A private address is reported separately: it may still work when Evolution Go and
 * Chatwoot sit on the same network, so it's a warning, not a failure.
 */
export async function checkPublicUrl(http: HttpClient, publicUrl: string): Promise<ReachabilityResult> {
  const nonce = randomToken(16);
  pending.add(nonce);
  try {
    const res = await http.request(`${publicUrl}/hooks/ping/${nonce}`, { timeoutMs: 10_000, followRedirects: true });
    if (res.status !== 200) {
      return { ok: false, privateAddress: false, message: `${publicUrl} answered HTTP ${res.status} instead of reaching EvoBridge` };
    }
    let body: { ok?: boolean; process?: string } = {};
    try {
      body = res.json();
    } catch {
      /* not EvoBridge */
    }
    if (body.process !== PROCESS_ID || !body.ok) {
      return { ok: false, privateAddress: false, message: `${publicUrl} reaches a different server, not this EvoBridge` };
    }
    return { ok: true, message: `${publicUrl} reaches this EvoBridge` };
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'blocked_url') {
      return { ok: false, privateAddress: true, message: `${publicUrl} is a private address, so EvoBridge can't verify it from here` };
    }
    return { ok: false, privateAddress: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    pending.delete(nonce);
  }
}
