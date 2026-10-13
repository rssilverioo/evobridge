import type { SettingsDto } from '@evobridge/shared';
import type { Ctx } from '../context.js';
import { nowIso } from '../lib/ids.js';

const DEFAULTS: SettingsDto = {
  publicUrl: '',
  retentionDays: 14,
  logMessageContent: false,
};

export async function getSettings(ctx: Pick<Ctx, 'db'>): Promise<SettingsDto> {
  const rows = await ctx.db.selectFrom('settings').selectAll().execute();
  const out: SettingsDto = { ...DEFAULTS };
  for (const row of rows) {
    if (row.key in out) (out as unknown as Record<string, unknown>)[row.key] = JSON.parse(row.value);
  }
  return out;
}

export async function saveSettings(ctx: Pick<Ctx, 'db'>, patch: Partial<SettingsDto>): Promise<SettingsDto> {
  const at = nowIso();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in DEFAULTS)) continue;
    await ctx.db
      .insertInto('settings')
      .values({ key, value: JSON.stringify(value), updated_at: at })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: at }))
      .execute();
  }
  return getSettings(ctx);
}

/**
 * The base URL providers call back. PUBLIC_URL (env) wins so infrastructure can pin it;
 * otherwise the value saved in Settings, which the dashboard pre-fills from the browser origin.
 */
export async function resolvePublicUrl(ctx: Pick<Ctx, 'db' | 'config'>): Promise<{ url: string; source: 'env' | 'settings' | 'unset' }> {
  if (ctx.config.publicUrl) return { url: ctx.config.publicUrl, source: 'env' };
  const s = await getSettings(ctx);
  if (s.publicUrl) return { url: s.publicUrl, source: 'settings' };
  return { url: '', source: 'unset' };
}
