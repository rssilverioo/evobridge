import type { Generated } from 'kysely';

/**
 * Column types as stored. Timestamps are ISO-8601 strings, booleans are 0/1 integers and
 * JSON columns are TEXT, so the same schema maps 1:1 to PostgreSQL later.
 */
export interface Database {
  users: UsersTable;
  sessions: SessionsTable;
  settings: SettingsTable;
  providers: ProvidersTable;
  connections: ConnectionsTable;
  contacts: ContactsTable;
  message_links: MessageLinksTable;
  jobs: JobsTable;
  events: EventsTable;
}

export interface UsersTable {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SessionsTable {
  /** sha256 of the cookie token; the token itself is never stored. */
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
}

export interface SettingsTable {
  key: string;
  value: string;
  updated_at: string;
}

export interface ProvidersTable {
  id: string;
  kind: 'evolution_go' | 'chatwoot';
  name: string;
  base_url: string;
  secret_enc: string;
  secret_preview: string;
  status: string;
  status_message: string | null;
  meta: string;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionsTable {
  id: string;
  name: string;
  evolution_provider_id: string;
  instance_id: string | null;
  instance_name: string;
  /** Instance token, discovered with the global key. Encrypted. */
  instance_token_enc: string | null;
  chatwoot_provider_id: string;
  account_id: number;
  inbox_id: number | null;
  inbox_name: string | null;
  /** Random secret embedded in both webhook URLs. Encrypted. */
  hook_secret_enc: string;
  /** Chatwoot API-inbox HMAC token, when the inbox exposes one. Encrypted. */
  chatwoot_hmac_enc: string | null;
  /** Webhook the instance had before EvoBridge took over; events are forwarded to it. */
  previous_evo_webhook_url: string | null;
  /** Same for the Chatwoot inbox webhook_url. */
  previous_cw_webhook_url: string | null;
  state: string;
  state_reason: string | null;
  paused: number;
  options: string;
  provision: string;
  last_activity_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One row per WhatsApp chat per connection: the Chatwoot side of that chat. */
export interface ContactsTable {
  id: Generated<number>;
  connection_id: string;
  /** Canonical chat key: phone JID for 1:1 (`5511…@s.whatsapp.net`), `@lid` when no phone is known, `@g.us` for groups. */
  chat_jid: string;
  lid: string | null;
  phone: string | null;
  push_name: string | null;
  cw_contact_id: number | null;
  cw_source_id: string | null;
  cw_conversation_id: number | null;
  /** 1 while the Chatwoot contact still has a made-up name ("WhatsApp 442925"). */
  cw_name_placeholder: Generated<number>;
  created_at: string;
  updated_at: string;
}

/** WhatsApp message id <-> Chatwoot message id, for replies, deletes and echo suppression. */
export interface MessageLinksTable {
  id: Generated<number>;
  connection_id: string;
  wa_message_id: string;
  wa_chat_jid: string;
  wa_from_me: number;
  /** Group sender, needed to quote a group message. */
  wa_participant: string | null;
  cw_message_id: number | null;
  cw_conversation_id: number | null;
  /** 'wa_to_cw' or 'cw_to_wa': which side originated the message. */
  origin: 'wa_to_cw' | 'cw_to_wa';
  /** For cw_to_wa: pending (id reserved, not confirmed sent), sent, delivered, read, failed. */
  wa_status: string;
  created_at: string;
}

export interface JobsTable {
  id: string;
  connection_id: string | null;
  kind: string;
  /** Unique: the same provider event can never be queued twice. */
  dedupe_key: string;
  /** Jobs that share an ordering key run one at a time, oldest first. */
  ordering_key: string;
  payload_enc: string | null;
  status: 'queued' | 'running' | 'done' | 'ignored' | 'dead';
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface EventsTable {
  id: string;
  connection_id: string | null;
  job_id: string | null;
  source: string;
  direction: string;
  type: string;
  status: string;
  duration_ms: number | null;
  error: string | null;
  attempts: number;
  refs: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}
