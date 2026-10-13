import type { Ctx } from '../context.js';
import type { JobsTable } from '../db/schema.js';
import { PermanentError, ProviderError, errorMessage } from '../lib/errors.js';
import { redactUrl } from '../lib/redact.js';
import type { CwWebhook } from '../providers/chatwoot/types.js';
import type { EvoWebhook } from '../providers/evolution-go/types.js';
import { loadBridge, touchActivity } from '../services/connections.js';
import { updateJobEvent } from '../services/events.js';
import { getSettings } from '../services/settings.js';
import { extractContent, normalizeEvolutionEvent } from '../providers/evolution-go/normalize.js';
import type { EvoMessageData } from '../providers/evolution-go/types.js';
import { type HandlerResult, handleEvolutionEvent } from './inbound.js';
import { handleChatwootEvent, markChatwootFailed } from './outbound.js';
import { claimJobs, completeJob, failJob, recoverExpiredLeases } from './queue.js';

export interface ForwardPayload {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Pulls jobs from the durable queue and runs them with bounded concurrency.
 * Ingress wakes it immediately; a slow poll picks up scheduled retries.
 */
export class Worker {
  #running = 0;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #inflight = new Set<Promise<void>>();
  #wakeRequested = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly concurrency: number,
    private readonly pollMs = 1000,
  ) {}

  start(): void {
    this.#stopped = false;
    this.#schedule(0);
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#running >= this.concurrency) {
      this.#wakeRequested = true;
      return;
    }
    this.#schedule(0);
  }

  /** Stops claiming and waits for in-flight jobs (graceful shutdown). */
  async stop(timeoutMs = 15_000): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await Promise.race([Promise.allSettled([...this.#inflight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Runs until the queue has nothing runnable now. Used by tests. */
  async drain(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const jobs = await claimJobs(this.ctx, this.concurrency);
      if (!jobs.length && !this.#inflight.size) return;
      await Promise.all(jobs.map((j) => this.#run(j)));
      await Promise.allSettled([...this.#inflight]);
    }
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#tick(), ms);
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    try {
      await recoverExpiredLeases(this.ctx);
      const free = this.concurrency - this.#running;
      const jobs = await claimJobs(this.ctx, free);
      for (const job of jobs) {
        const p = this.#run(job).finally(() => {
          this.#inflight.delete(p);
          // A finished job may unblock the next one of the same chat.
          this.#schedule(0);
        });
        this.#inflight.add(p);
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'worker tick failed');
    }
    const again = this.#wakeRequested;
    this.#wakeRequested = false;
    this.#schedule(again ? 0 : this.pollMs);
  }

  async #run(job: JobsTable): Promise<void> {
    this.#running++;
    const started = Date.now();
    try {
      const result = await this.#execute(job);
      if (result.status === 'processed' && (await getSettings(this.ctx)).logMessageContent) {
        const text = messageText(this.ctx, job);
        if (text) result.detail = { ...(result.detail ?? {}), text };
      }
      await completeJob(this.ctx, job.id, result.status === 'processed' ? 'done' : 'ignored');
      await updateJobEvent(this.ctx, job.id, {
        status: result.status,
        type: result.type,
        durationMs: Date.now() - started,
        attempts: job.attempts,
        refs: result.refs,
        detail: result.reason || result.detail ? { ...(result.reason ? { reason: result.reason } : {}), ...(result.detail ?? {}) } : undefined,
      });
      if (result.status === 'processed' && job.connection_id) await touchActivity(this.ctx, job.connection_id);
    } catch (err) {
      const message = errorMessage(err);
      const retryable = err instanceof PermanentError ? false : err instanceof ProviderError ? err.retryable : true;
      const outcome = await failJob(this.ctx, job, message, { retryable, retryAfterMs: err instanceof ProviderError ? err.retryAfterMs : undefined });
      await updateJobEvent(this.ctx, job.id, {
        status: outcome === 'dead' ? 'dead' : 'retrying',
        durationMs: Date.now() - started,
        error: message,
        attempts: job.attempts,
      });
      this.ctx.log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, outcome, err: message }, 'job failed');
      if (outcome === 'dead') await this.#onDead(job, message).catch(() => undefined);
    } finally {
      this.#running--;
    }
  }

  async #execute(job: JobsTable): Promise<HandlerResult> {
    if (!job.payload_enc) throw new PermanentError('Payload no longer retained');
    if (!job.connection_id) throw new PermanentError('Job without connection');
    const payload = this.ctx.box.decryptJson<unknown>(job.payload_enc);

    if (job.kind === 'forward_webhook') return this.#forward(payload as ForwardPayload);

    const bridge = await loadBridge(this.ctx, job.connection_id);
    if (bridge.row.paused) return { status: 'ignored', type: 'event', reason: 'connection paused' };
    if (job.kind === 'evolution_event') {
      return handleEvolutionEvent(this.ctx, bridge, normalizeEvolutionEvent(payload as EvoWebhook), job.attempts);
    }
    if (job.kind === 'chatwoot_event') return handleChatwootEvent(this.ctx, bridge, payload as CwWebhook);
    throw new PermanentError(`Unknown job kind ${job.kind}`);
  }

  /** Relays the original event to the webhook that was configured before EvoBridge took over. */
  async #forward(p: ForwardPayload): Promise<HandlerResult> {
    const res = await this.ctx.http.requestOnce(p.url, { method: 'POST', headers: { ...p.headers, 'content-type': 'application/json' }, rawBody: p.body, timeoutMs: 30_000 });
    if (res.status >= 500 || res.status === 429) throw new ProviderError(res.status === 429 ? 'rate_limited' : 'server_error', `Forward target answered ${res.status}`, res.status);
    if (res.status >= 400) throw new PermanentError(`Forward target answered ${res.status}`);
    return { status: 'processed', type: 'webhook.forward', refs: { target: redactUrl(p.url) } };
  }

  async #onDead(job: JobsTable, error: string): Promise<void> {
    if (job.kind !== 'chatwoot_event' || !job.connection_id || !job.payload_enc) return;
    const bridge = await loadBridge(this.ctx, job.connection_id);
    await markChatwootFailed(bridge, this.ctx.box.decryptJson<CwWebhook>(job.payload_enc), error);
  }
}

/** Message text for the opt-in "store message text in logs" setting. Truncated. */
function messageText(ctx: Ctx, job: JobsTable): string | null {
  if (!job.payload_enc) return null;
  try {
    const payload = ctx.box.decryptJson<Record<string, unknown>>(job.payload_enc);
    if (job.kind === 'chatwoot_event') return typeof payload.content === 'string' ? payload.content.slice(0, 500) : null;
    if (job.kind === 'evolution_event') {
      const data = payload.data as EvoMessageData | undefined;
      return extractContent(data?.Message).text.slice(0, 500) || null;
    }
  } catch {
    /* not a message payload */
  }
  return null;
}
