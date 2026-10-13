import type { Ctx } from '../context.js';
import type { JobsTable } from '../db/schema.js';
import { newId, nowIso } from '../lib/ids.js';

export type JobKind = 'evolution_event' | 'chatwoot_event' | 'forward_webhook';

export interface EnqueueInput {
  connectionId: string;
  kind: JobKind;
  dedupeKey: string;
  orderingKey: string;
  payload: unknown;
  maxAttempts?: number;
}

export const DEFAULT_MAX_ATTEMPTS = 10;
const LEASE_MS = 5 * 60 * 1000;
/** After this many failures a job stops blocking newer jobs of the same chat. */
const ORDER_BLOCK_ATTEMPTS = 3;

/**
 * Inserts a job unless one with the same dedupe key exists. Returns the new job id,
 * or null for a duplicate delivery (which is then acknowledged and dropped).
 */
export async function enqueue(ctx: Pick<Ctx, 'db' | 'box'>, input: EnqueueInput): Promise<string | null> {
  const at = nowIso();
  const id = newId('job');
  const res = await ctx.db
    .insertInto('jobs')
    .values({
      id,
      connection_id: input.connectionId,
      kind: input.kind,
      dedupe_key: input.dedupeKey,
      ordering_key: input.orderingKey,
      payload_enc: ctx.box.encryptJson(input.payload),
      status: 'queued',
      attempts: 0,
      max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      run_at: at,
      locked_until: null,
      last_error: null,
      created_at: at,
      updated_at: at,
      finished_at: null,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .executeTakeFirst();
  return Number(res.numInsertedOrUpdatedRows ?? 0) > 0 ? id : null;
}

/**
 * Claims up to `limit` runnable jobs, at most one per ordering key, never one whose chat
 * has an older job still running or waiting (unless that one has failed repeatedly).
 * Runs in a single transaction; SQLite serializes writers so two claims can't overlap.
 */
export async function claimJobs(ctx: Pick<Ctx, 'db'>, limit: number): Promise<JobsTable[]> {
  if (limit <= 0) return [];
  const now = nowIso();
  return ctx.db.transaction().execute(async (trx) => {
    const candidates = await trx
      .selectFrom('jobs')
      .selectAll()
      .where('status', '=', 'queued')
      .where('run_at', '<=', now)
      .orderBy('created_at', 'asc')
      .limit(limit * 10)
      .execute();
    if (!candidates.length) return [];

    const keys = [...new Set(candidates.map((c) => c.ordering_key))];
    const blockers = await trx
      .selectFrom('jobs')
      .select(['id', 'ordering_key', 'status', 'attempts', 'created_at'])
      .where('ordering_key', 'in', keys)
      .where((eb) => eb.or([eb('status', '=', 'running'), eb.and([eb('status', '=', 'queued'), eb('attempts', '<', ORDER_BLOCK_ATTEMPTS)])]))
      .execute();

    const claimed: JobsTable[] = [];
    const takenKeys = new Set<string>();
    for (const job of candidates) {
      if (claimed.length >= limit) break;
      if (takenKeys.has(job.ordering_key)) continue;
      const blocked = blockers.some(
        (b) => b.ordering_key === job.ordering_key && b.id !== job.id && (b.status === 'running' || b.created_at < job.created_at),
      );
      if (blocked) {
        takenKeys.add(job.ordering_key);
        continue;
      }
      takenKeys.add(job.ordering_key);
      const lockedUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await trx
        .updateTable('jobs')
        .set({ status: 'running', attempts: job.attempts + 1, locked_until: lockedUntil, updated_at: now })
        .where('id', '=', job.id)
        .where('status', '=', 'queued')
        .execute();
      claimed.push({ ...job, status: 'running', attempts: job.attempts + 1, locked_until: lockedUntil });
    }
    return claimed;
  });
}

export async function completeJob(ctx: Pick<Ctx, 'db'>, id: string, status: 'done' | 'ignored'): Promise<void> {
  const at = nowIso();
  await ctx.db.updateTable('jobs').set({ status, locked_until: null, last_error: null, updated_at: at, finished_at: at }).where('id', '=', id).execute();
}

let backoffBaseMs = 2000;
/** Tests shorten the retry schedule; production keeps 2 s. */
export function setBackoffBase(ms: number): void {
  backoffBaseMs = ms;
}

/** Exponential backoff with jitter: 2s, 4s, 8s … capped at 10 minutes. */
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(backoffBaseMs * 2 ** Math.max(0, attempt - 1), 10 * 60 * 1000);
  const jittered = base / 2 + Math.random() * (base / 2);
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** Schedules a retry, or moves the job to the dead-letter state when attempts are exhausted. */
export async function failJob(
  ctx: Pick<Ctx, 'db'>,
  job: Pick<JobsTable, 'id' | 'attempts' | 'max_attempts'>,
  error: string,
  opts: { retryable: boolean; retryAfterMs?: number },
): Promise<'retrying' | 'dead'> {
  const at = nowIso();
  if (!opts.retryable || job.attempts >= job.max_attempts) {
    await ctx.db
      .updateTable('jobs')
      .set({ status: 'dead', locked_until: null, last_error: error.slice(0, 2000), updated_at: at, finished_at: at })
      .where('id', '=', job.id)
      .execute();
    return 'dead';
  }
  const runAt = new Date(Date.now() + backoffMs(job.attempts, opts.retryAfterMs)).toISOString();
  await ctx.db
    .updateTable('jobs')
    .set({ status: 'queued', run_at: runAt, locked_until: null, last_error: error.slice(0, 2000), updated_at: at })
    .where('id', '=', job.id)
    .execute();
  return 'retrying';
}

/** After a crash, jobs left running with an expired lease go back to the queue. */
export async function recoverExpiredLeases(ctx: Pick<Ctx, 'db'>): Promise<number> {
  const res = await ctx.db
    .updateTable('jobs')
    .set({ status: 'queued', locked_until: null, run_at: nowIso(), updated_at: nowIso() })
    .where('status', '=', 'running')
    .where('locked_until', '<', nowIso())
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** On boot, nothing is running yet: every `running` row is from a previous process. */
export async function requeueAllRunning(ctx: Pick<Ctx, 'db'>): Promise<number> {
  const res = await ctx.db
    .updateTable('jobs')
    .set({ status: 'queued', locked_until: null, run_at: nowIso(), updated_at: nowIso() })
    .where('status', '=', 'running')
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** Re-runs a dead (or finished) job from its retained payload. */
export async function replayJob(ctx: Pick<Ctx, 'db'>, id: string): Promise<boolean> {
  const res = await ctx.db
    .updateTable('jobs')
    .set({ status: 'queued', attempts: 0, run_at: nowIso(), locked_until: null, last_error: null, finished_at: null, updated_at: nowIso() })
    .where('id', '=', id)
    .where('status', 'in', ['dead', 'done', 'ignored'])
    .where('payload_enc', 'is not', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function queueStats(ctx: Pick<Ctx, 'db'>): Promise<{ queued: number; dead: number }> {
  const rows = await ctx.db
    .selectFrom('jobs')
    .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
    .where('status', 'in', ['queued', 'running', 'dead'])
    .groupBy('status')
    .execute();
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return { queued: (by.queued ?? 0) + (by.running ?? 0), dead: by.dead ?? 0 };
}
