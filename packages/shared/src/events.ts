import { z } from 'zod';

export const EVENT_DIRECTIONS = ['inbound', 'outbound', 'system'] as const;
export type EventDirection = (typeof EVENT_DIRECTIONS)[number];

export const EVENT_STATUSES = ['received', 'processed', 'ignored', 'retrying', 'failed', 'dead'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const EVENT_SOURCES = ['evolution_go', 'chatwoot', 'evobridge'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const eventQuerySchema = z.object({
  connectionId: z.string().optional(),
  direction: z.enum(EVENT_DIRECTIONS).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  source: z.enum(EVENT_SOURCES).optional(),
  q: z.string().trim().max(200).optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EventQuery = z.infer<typeof eventQuerySchema>;

export interface EventDto {
  id: string;
  createdAt: string;
  source: EventSource;
  connectionId: string | null;
  connectionName: string | null;
  direction: EventDirection;
  type: string;
  status: EventStatus;
  durationMs: number | null;
  error: string | null;
  attempts: number;
  /** Technical ids (WhatsApp message id, Chatwoot message/conversation id, job id). */
  refs: Record<string, string>;
  /** Present when the original payload is still retained and the event can be replayed. */
  replayable: boolean;
  detail?: Record<string, unknown>;
}

export interface EventPage {
  items: EventDto[];
  nextCursor: string | null;
}
