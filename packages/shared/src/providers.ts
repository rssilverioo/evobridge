import { z } from 'zod';

export const PROVIDER_KINDS = ['evolution_go', 'chatwoot'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  evolution_go: 'Evolution Go',
  chatwoot: 'Chatwoot',
};

export const PROVIDER_STATUSES = ['ok', 'unreachable', 'unauthorized', 'not_activated', 'error', 'unknown'] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

const urlField = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Enter a valid http(s) URL')
  .transform((v) => v.replace(/\/+$/, ''));

export const providerTestSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: urlField,
  secret: z.string().trim().min(1, 'Required').max(512),
});
export type ProviderTestInput = z.infer<typeof providerTestSchema>;

export const providerCreateSchema = providerTestSchema.extend({
  name: z.string().trim().max(80).optional(),
});
export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;

export const providerUpdateSchema = z.object({
  name: z.string().trim().max(80).optional(),
  baseUrl: urlField.optional(),
  /** Omitted or empty keeps the stored secret. */
  secret: z.string().trim().max(512).optional(),
});
export type ProviderUpdateInput = z.infer<typeof providerUpdateSchema>;

export interface ProviderCheck {
  ok: boolean;
  status: ProviderStatus;
  message: string;
  /** Short human hint on how to fix, when known. */
  hint?: string;
  details?: {
    version?: string;
    userName?: string;
    instanceCount?: number;
    accounts?: Array<{ id: number; name: string; role: string }>;
  };
}

export interface ProviderDto {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  /** Masked secret, never the full value. */
  secretPreview: string;
  status: ProviderStatus;
  statusMessage: string | null;
  lastCheckedAt: string | null;
  meta: Record<string, unknown>;
  connectionCount: number;
  createdAt: string;
}

export interface EvolutionInstanceDto {
  id: string;
  name: string;
  connected: boolean;
  phone: string | null;
  profileName: string | null;
  /** Webhook currently configured on the instance, if readable. */
  webhookUrl: string | null;
}

export interface ChatwootAccountDto {
  id: number;
  name: string;
  role: string;
}

export interface ChatwootInboxDto {
  id: number;
  name: string;
  channelType: string;
  /** Only API-channel inboxes can be bridged. */
  bridgeable: boolean;
  webhookUrl: string | null;
}
