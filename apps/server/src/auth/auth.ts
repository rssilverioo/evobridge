import { hash, verify } from '@node-rs/argon2';
import type { SessionUser, SetupInput } from '@evobridge/shared';
import type { Ctx } from '../context.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';

// Argon2id with OWASP's recommended minimum (19 MiB, 2 iterations).
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1, algorithm: 2 as const };
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 60 * 60 * 1000;

export const SESSION_COOKIE = 'evobridge_session';

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

export async function isSetupRequired(ctx: Pick<Ctx, 'db'>): Promise<boolean> {
  const row = await ctx.db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  return Number(row.n) === 0;
}

/** Creates the single administrator. Refuses once one exists, so setup can't be replayed. */
export async function createAdmin(ctx: Pick<Ctx, 'db'>, input: SetupInput): Promise<SessionUser> {
  const passwordHash = await hashPassword(input.password);
  const at = nowIso();
  const id = newId('usr');
  // The count check and insert run in one transaction: two racing setup requests can't both win.
  await ctx.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    if (Number(row.n) > 0) throw new AppError(409, 'setup_done', 'An administrator already exists. Sign in instead.');
    await trx
      .insertInto('users')
      .values({ id, name: input.name, email: input.email, password_hash: passwordHash, created_at: at, updated_at: at })
      .execute();
  });
  return { id, name: input.name, email: input.email };
}

// Verifying against a throwaway hash when the email is unknown keeps response time constant.
let dummyHash: Promise<string> | null = null;

export async function authenticate(ctx: Pick<Ctx, 'db'>, email: string, password: string): Promise<SessionUser | null> {
  const user = await ctx.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
  if (!user) {
    dummyHash ??= hashPassword(randomToken(16));
    await verifyPassword(await dummyHash, password);
    return null;
  }
  if (!(await verifyPassword(user.password_hash, password))) return null;
  return { id: user.id, name: user.name, email: user.email };
}

export async function changePassword(ctx: Pick<Ctx, 'db'>, userId: string, current: string, next: string, keepSessionId: string): Promise<void> {
  const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!user || !(await verifyPassword(user.password_hash, current))) {
    throw new AppError(400, 'invalid_password', 'Current password is incorrect', undefined, { currentPassword: 'Incorrect password' });
  }
  await ctx.db.updateTable('users').set({ password_hash: await hashPassword(next), updated_at: nowIso() }).where('id', '=', userId).execute();
  // Sign out every other session.
  await ctx.db.deleteFrom('sessions').where('user_id', '=', userId).where('id', '!=', keepSessionId).execute();
}

export interface SessionInfo {
  sessionId: string;
  csrfToken: string;
  user: SessionUser;
}

export async function createSession(ctx: Pick<Ctx, 'db'>, userId: string, meta: { ip?: string; userAgent?: string }): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await ctx.db
    .insertInto('sessions')
    .values({
      id: sha256(token),
      user_id: userId,
      csrf_token: csrfToken,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      last_seen_at: now.toISOString(),
      ip: meta.ip ?? null,
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  return { token, csrfToken, expiresAt };
}

export async function resolveSession(ctx: Pick<Ctx, 'db'>, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  const id = sha256(token);
  const row = await ctx.db
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .select(['sessions.id', 'sessions.csrf_token', 'sessions.expires_at', 'sessions.last_seen_at', 'users.id as user_id', 'users.name', 'users.email'])
    .where('sessions.id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  const now = Date.now();
  if (Date.parse(row.expires_at) <= now) {
    await ctx.db.deleteFrom('sessions').where('id', '=', id).execute();
    return null;
  }
  if (now - Date.parse(row.last_seen_at) > SESSION_TOUCH_MS) {
    // Sliding expiry, written at most once an hour.
    await ctx.db
      .updateTable('sessions')
      .set({ last_seen_at: new Date(now).toISOString(), expires_at: new Date(now + SESSION_TTL_MS).toISOString() })
      .where('id', '=', id)
      .execute();
  }
  return { sessionId: id, csrfToken: row.csrf_token, user: { id: row.user_id, name: row.name, email: row.email } };
}

export async function destroySession(ctx: Pick<Ctx, 'db'>, sessionId: string): Promise<void> {
  await ctx.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
}

export async function purgeExpiredSessions(ctx: Pick<Ctx, 'db'>): Promise<void> {
  await ctx.db.deleteFrom('sessions').where('expires_at', '<=', nowIso()).execute();
}
