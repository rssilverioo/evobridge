import { z } from 'zod';

export const CONNECTION_STATES = ['configuring', 'connected', 'degraded', 'disconnected', 'error', 'paused'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  configuring: 'Configuring',
  connected: 'Connected',
  degraded: 'Degraded',
  disconnected: 'Disconnected',
  error: 'Error',
  paused: 'Paused',
};

export const connectionOptionsSchema = z.object({
  /** Prefix agent replies with the agent name, like "*Ana:*". */
  signAgentName: z.boolean().default(true),
  /** Reopen the last resolved conversation instead of creating a new one. */
  reopenConversation: z.boolean().default(true),
  /** Create new conversations as pending instead of open. */
  pendingConversations: z.boolean().default(false),
  /** Mirror messages typed on the phone itself into Chatwoot as outgoing. */
  syncPhoneMessages: z.boolean().default(true),
  /** Bridge group chats. Off by default: most support inboxes only want 1:1. */
  includeGroups: z.boolean().default(false),
  /** Post connection status notes (connected, logged out...) in a Chatwoot conversation. */
  connectionNotices: z.boolean().default(true),
});
export type ConnectionOptions = z.infer<typeof connectionOptionsSchema>;

export const inboxChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), inboxId: z.number().int().positive() }),
  z.object({ mode: z.literal('create'), inboxName: z.string().trim().min(1).max(80) }),
]);
export type InboxChoice = z.infer<typeof inboxChoiceSchema>;

export const connectionCreateSchema = z.object({
  name: z.string().trim().max(80).optional(),
  evolutionProviderId: z.string().min(1),
  instanceName: z.string().min(1).max(200),
  chatwootProviderId: z.string().min(1),
  accountId: z.number().int().positive(),
  inbox: inboxChoiceSchema,
  /** Explicit consent to replace a webhook another service set on the instance or inbox. */
  replaceExistingWebhooks: z.boolean().default(false),
  /** Explicit consent to remove connections of this EvoBridge that use the same instance or inbox. */
  replaceExistingConnection: z.boolean().default(false),
  options: connectionOptionsSchema.partial().optional(),
});
export type ConnectionCreateInput = z.infer<typeof connectionCreateSchema>;

export const connectionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  options: connectionOptionsSchema.partial().optional(),
});
export type ConnectionUpdateInput = z.infer<typeof connectionUpdateSchema>;

export const connectionDeleteSchema = z.object({
  /** Also remove the webhooks EvoBridge set on Evolution Go and Chatwoot. */
  removeRemoteWebhooks: z.boolean().default(false),
});

export const PROVISION_STEPS = [
  'validate',
  'register',
  'chatwoot_inbox',
  'evolution_webhook',
  'chatwoot_callback',
  'reachability',
  'health',
  'activate',
] as const;
export type ProvisionStepId = (typeof PROVISION_STEPS)[number];

export const PROVISION_STEP_LABELS: Record<ProvisionStepId, string> = {
  validate: 'Validate settings',
  register: 'Register connection',
  chatwoot_inbox: 'Prepare Chatwoot inbox',
  evolution_webhook: 'Configure Evolution Go webhook',
  chatwoot_callback: 'Configure Chatwoot callback',
  reachability: 'Check public callback URL',
  health: 'Run health check',
  activate: 'Activate message sync',
};

export type ProvisionStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'action_required';

export interface ProvisionStep {
  id: ProvisionStepId;
  status: ProvisionStepStatus;
  message?: string;
  /** Concrete instructions when the API can't do it for the user. */
  instructions?: string[];
  at?: string;
}

export interface ConnectionDto {
  id: string;
  name: string;
  state: ConnectionState;
  stateReason: string | null;
  paused: boolean;
  evolution: { providerId: string; providerName: string; instanceName: string; instanceId: string | null };
  chatwoot: { providerId: string; providerName: string; accountId: number; inboxId: number | null; inboxName: string | null };
  options: ConnectionOptions;
  provision: ProvisionStep[];
  webhookUrls: { evolution: string; chatwoot: string };
  stats: { processed24h: number; failed24h: number };
  lastActivityAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}
