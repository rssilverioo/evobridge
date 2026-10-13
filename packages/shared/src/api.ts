import { z } from 'zod';
import type { ConnectionState } from './connections';
import type { EventDto } from './events';
import type { ProviderKind, ProviderStatus } from './providers';

/** Every API error has this shape. `code` is stable, `message` is for humans. */
export interface ApiError {
  error: { code: string; message: string; hint?: string; fields?: Record<string, string> };
}

export interface OverviewDto {
  connections: { total: number; active: number; error: number; byState: Partial<Record<ConnectionState, number>> };
  messages: { processed24h: number; failed24h: number; processedTotal: number; queued: number; dead: number };
  providers: Array<{ id: string; kind: ProviderKind; name: string; status: ProviderStatus; lastCheckedAt: string | null }>;
  recentEvents: EventDto[];
}

export const settingsSchema = z.object({
  /** Base URL Evolution Go and Chatwoot use to reach EvoBridge. */
  publicUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === '' || /^https?:\/\/[^\s/]+/.test(v), 'Enter a valid http(s) URL')
    .transform((v) => v.replace(/\/+$/, '')),
  /** Days to keep processed events and retained payloads. */
  retentionDays: z.number().int().min(1).max(365),
  /** Store message text/captions in event details. Off by default. */
  logMessageContent: z.boolean(),
});
export type SettingsDto = z.infer<typeof settingsSchema>;

export interface SystemInfoDto {
  version: string;
  publicUrl: string;
  publicUrlSource: 'env' | 'settings' | 'unset';
  allowPrivateNetworks: boolean;
  dataDir: string;
  database: { sizeBytes: number; events: number };
}
