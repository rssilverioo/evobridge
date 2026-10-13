import type { EventDirection, EventDto, EventPage, EventQuery, EventSource, EventStatus } from '@evobridge/shared';
import { sql } from 'kysely';
import type { Ctx } from '../context.js';
import { newId, nowIso } from '../lib/ids.js';

export interface RecordEventInput {
  connectionId: string | null;
  jobId?: string | null;
  source: EventSource;
  direction: EventDirection;
  type: string;
  status: EventStatus;
  durationMs?: number | null;
  error?: string | null;
  attempts?: number;
  refs?: Record<string, string | number | null | undefined>;
  detail?: Record<string, unknown> | null;
}

function cleanRefs(refs: RecordEventInput['refs']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(refs ?? {})) if (v !== null && v !== undefined && v !== '') out[k] = String(v);
  return out;
}

export async function recordEvent(ctx: Pick<Ctx, 'db'>, input: RecordEventInput): Promise<string> {
  const at = nowIso();
  const id = newId('evt');
  await ctx.db
    .insertInto('events')
    .values({
      id,
      connection_id: input.connectionId,
      job_id: input.jobId ?? null,
      source: input.source,
      direction: input.direction,
      type: input.type,
      status: input.status,
      duration_ms: input.durationMs ?? null,
      error: input.error?.slice(0, 2000) ?? null,
      attempts: input.attempts ?? 0,
      refs: JSON.stringify(cleanRefs(input.refs)),
      detail: input.detail ? JSON.stringify(input.detail) : null,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return id;
}

/** One event row per job: updated in place on every attempt so the log shows the latest outcome. */
export async function updateJobEvent(
  ctx: Pick<Ctx, 'db'>,
  jobId: string,
  patch: { status: EventStatus; type?: string; durationMs?: number; error?: string | null; attempts?: number; refs?: RecordEventInput['refs']; detail?: Record<string, unknown> | null },
): Promise<void> {
  const row = await ctx.db.selectFrom('events').select(['id', 'refs', 'detail']).where('job_id', '=', jobId).executeTakeFirst();
  if (!row) return;
  const refs = { ...(JSON.parse(row.refs) as Record<string, string>), ...cleanRefs(patch.refs) };
  const detail = patch.detail === undefined ? row.detail : patch.detail ? JSON.stringify({ ...(row.detail ? JSON.parse(row.detail) : {}), ...patch.detail }) : null;
  await ctx.db
    .updateTable('events')
    .set({
      status: patch.status,
      ...(patch.type ? { type: patch.type } : {}),
      duration_ms: patch.durationMs ?? null,
      error: patch.error === undefined ? null : (patch.error?.slice(0, 2000) ?? null),
      ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
      refs: JSON.stringify(refs),
      detail,
      updated_at: nowIso(),
    })
    .where('id', '=', row.id)
    .execute();
}

export async function queryEvents(ctx: Pick<Ctx, 'db'>, q: EventQuery): Promise<EventPage> {
  let query = ctx.db
    .selectFrom('events')
    .leftJoin('connections', 'connections.id', 'events.connection_id')
    .leftJoin('jobs', 'jobs.id', 'events.job_id')
    .select([
      'events.id',
      'events.created_at',
      'events.source',
      'events.connection_id',
      'connections.name as connection_name',
      'events.direction',
      'events.type',
      'events.status',
      'events.duration_ms',
      'events.error',
      'events.attempts',
      'events.refs',
      'events.detail',
      'jobs.status as job_status',
      sql<number>`jobs.payload_enc is not null`.as('has_payload'),
    ])
    .orderBy('events.created_at', 'desc')
    .orderBy('events.id', 'desc')
    .limit(q.limit + 1);
  if (q.connectionId) query = query.where('events.connection_id', '=', q.connectionId);
  if (q.direction) query = query.where('events.direction', '=', q.direction);
  if (q.status) query = query.where('events.status', '=', q.status);
  if (q.source) query = query.where('events.source', '=', q.source);
  if (q.before) query = query.where('events.created_at', '<', q.before);
  if (q.q) {
    const like = `%${q.q.replace(/[%_]/g, '')}%`;
    query = query.where((eb) =>
      eb.or([eb('events.type', 'like', like), eb('events.refs', 'like', like), eb('events.error', 'like', like), eb('events.id', 'like', like), eb('connections.name', 'like', like)]),
    );
  }
  const rows = await query.execute();
  const page = rows.slice(0, q.limit);
  const items: EventDto[] = page.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    source: r.source as EventSource,
    connectionId: r.connection_id,
    connectionName: r.connection_name ?? null,
    direction: r.direction as EventDirection,
    type: r.type,
    status: r.status as EventStatus,
    durationMs: r.duration_ms,
    error: r.error,
    attempts: r.attempts,
    refs: JSON.parse(r.refs) as Record<string, string>,
    replayable: Boolean(r.has_payload) && (r.job_status === 'dead' || r.job_status === 'done' || r.job_status === 'ignored'),
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined,
  }));
  return { items, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.created_at ?? null) : null };
}

export async function eventCounts(ctx: Pick<Ctx, 'db'>, since: string, connectionId?: string): Promise<{ processed: number; failed: number }> {
  let q = ctx.db
    .selectFrom('events')
    .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
    .where('created_at', '>=', since)
    .where('direction', '!=', 'system')
    .groupBy('status');
  if (connectionId) q = q.where('connection_id', '=', connectionId);
  const rows = await q.execute();
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return { processed: by.processed ?? 0, failed: (by.failed ?? 0) + (by.dead ?? 0) };
}

/**
 * Retention: deletes old events and finished jobs, and drops retained payloads of finished
 * jobs (message content) past the window. Dead jobs keep their payload so they stay replayable
 * until the window ends.
 */
export async function applyRetention(ctx: Pick<Ctx, 'db'>, days: number): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const payloadCutoff = new Date(Date.now() - Math.min(days, 2) * 24 * 60 * 60 * 1000).toISOString();
  await ctx.db.deleteFrom('events').where('created_at', '<', cutoff).execute();
  await ctx.db.deleteFrom('jobs').where('status', 'in', ['done', 'ignored', 'dead']).where('finished_at', '<', cutoff).execute();
  await ctx.db
    .updateTable('jobs')
    .set({ payload_enc: null })
    .where('status', 'in', ['done', 'ignored'])
    .where('finished_at', '<', payloadCutoff)
    .where('payload_enc', 'is not', null)
    .execute();
  // Hard cap so a flood can't fill the disk: keep the newest 200k events.
  await sql`delete from events where id in (select id from events order by created_at desc limit -1 offset 200000)`.execute(ctx.db);
}
