/**
 * Chatwoot wire types, verified against chatwoot v4.18.0 source. See docs/research/chatwoot.md.
 */

export interface CwProfile {
  id: number;
  name: string;
  email: string;
  type?: string | null;
  accounts: Array<{ id: number; name: string; role: 'administrator' | 'agent' | string; status?: string }>;
}

export interface CwInbox {
  id: number;
  name: string;
  channel_type: string;
  webhook_url?: string | null;
  /** Webhook signing secret (Chatwoot >= 4.13). Only returned to administrators. */
  secret?: string | null;
  inbox_identifier?: string;
  lock_to_single_conversation?: boolean;
}

export interface CwContact {
  id: number;
  name: string | null;
  phone_number: string | null;
  identifier: string | null;
  contact_inboxes?: Array<{ source_id: string; inbox?: { id: number } }>;
}

export interface CwConversation {
  id: number;
  inbox_id: number;
  status: 'open' | 'resolved' | 'pending' | 'snoozed';
  contact_inbox?: { source_id?: string };
  last_activity_at?: number;
  created_at?: number;
}

export interface CwMessage {
  id: number;
  conversation_id?: number;
  source_id?: string | null;
}

export interface CwAttachment {
  id: number;
  file_type: string;
  data_url?: string;
  extension?: string | null;
  content_type?: string | null;
  file_size?: number;
  coordinates_lat?: number;
  coordinates_long?: number;
  fallback_title?: string;
}

/** Payload EvoBridge receives on the API inbox webhook_url. Fields per Message#webhook_data. */
export interface CwWebhook {
  event: string;
  id?: number;
  content?: string | null;
  content_type?: string;
  content_attributes?: { in_reply_to?: number; in_reply_to_external_id?: string; deleted?: boolean } & Record<string, unknown>;
  /** String here ("incoming" | "outgoing" | "template"), unlike the REST API. */
  message_type?: string;
  private?: boolean;
  source_id?: string | null;
  sender?: { id?: number; name?: string; type?: string; available_name?: string } | null;
  inbox?: { id: number; name?: string };
  account?: { id: number };
  conversation?: {
    id: number;
    inbox_id?: number;
    status?: string;
    contact_inbox?: { source_id?: string };
    meta?: { sender?: { id?: number; phone_number?: string; identifier?: string } };
  };
  attachments?: CwAttachment[];
}
