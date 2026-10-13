import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('csrf_token', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('last_seen_at', 'text', (c) => c.notNull())
    .addColumn('ip', 'text')
    .addColumn('user_agent', 'text')
    .execute();
  await db.schema.createIndex('sessions_expires').on('sessions').column('expires_at').execute();

  await db.schema
    .createTable('settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('providers')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('base_url', 'text', (c) => c.notNull())
    .addColumn('secret_enc', 'text', (c) => c.notNull())
    .addColumn('secret_preview', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('unknown'))
    .addColumn('status_message', 'text')
    .addColumn('meta', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('last_checked_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('connections')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('evolution_provider_id', 'text', (c) => c.notNull().references('providers.id'))
    .addColumn('instance_id', 'text')
    .addColumn('instance_name', 'text', (c) => c.notNull())
    .addColumn('instance_token_enc', 'text')
    .addColumn('chatwoot_provider_id', 'text', (c) => c.notNull().references('providers.id'))
    .addColumn('account_id', 'integer', (c) => c.notNull())
    .addColumn('inbox_id', 'integer')
    .addColumn('inbox_name', 'text')
    .addColumn('hook_secret_enc', 'text', (c) => c.notNull())
    .addColumn('chatwoot_hmac_enc', 'text')
    .addColumn('previous_evo_webhook_url', 'text')
    .addColumn('previous_cw_webhook_url', 'text')
    .addColumn('state', 'text', (c) => c.notNull().defaultTo('configuring'))
    .addColumn('state_reason', 'text')
    .addColumn('paused', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('options', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('provision', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('last_activity_at', 'text')
    .addColumn('last_checked_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  // One bridge per instance and per inbox: two bridges on either side would duplicate messages.
  await db.schema
    .createIndex('connections_instance')
    .on('connections')
    .columns(['evolution_provider_id', 'instance_name'])
    .unique()
    .execute();
  await db.schema
    .createIndex('connections_inbox')
    .on('connections')
    .columns(['chatwoot_provider_id', 'account_id', 'inbox_id'])
    .unique()
    .execute();

  await db.schema
    .createTable('contacts')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('connection_id', 'text', (c) => c.notNull().references('connections.id').onDelete('cascade'))
    .addColumn('chat_jid', 'text', (c) => c.notNull())
    .addColumn('lid', 'text')
    .addColumn('phone', 'text')
    .addColumn('push_name', 'text')
    .addColumn('cw_contact_id', 'integer')
    .addColumn('cw_source_id', 'text')
    .addColumn('cw_conversation_id', 'integer')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('contacts_chat').on('contacts').columns(['connection_id', 'chat_jid']).unique().execute();
  await db.schema.createIndex('contacts_lid').on('contacts').columns(['connection_id', 'lid']).execute();
  await db.schema.createIndex('contacts_conversation').on('contacts').columns(['connection_id', 'cw_conversation_id']).execute();

  await db.schema
    .createTable('message_links')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('connection_id', 'text', (c) => c.notNull().references('connections.id').onDelete('cascade'))
    .addColumn('wa_message_id', 'text', (c) => c.notNull())
    .addColumn('wa_chat_jid', 'text', (c) => c.notNull())
    .addColumn('wa_from_me', 'integer', (c) => c.notNull())
    .addColumn('wa_participant', 'text')
    .addColumn('cw_message_id', 'integer')
    .addColumn('cw_conversation_id', 'integer')
    .addColumn('origin', 'text', (c) => c.notNull())
    .addColumn('wa_status', 'text', (c) => c.notNull().defaultTo('pending'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex('message_links_wa')
    .on('message_links')
    .columns(['connection_id', 'wa_message_id'])
    .unique()
    .execute();
  await db.schema.createIndex('message_links_cw').on('message_links').columns(['connection_id', 'cw_message_id']).execute();

  await db.schema
    .createTable('jobs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('connection_id', 'text', (c) => c.references('connections.id').onDelete('cascade'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('dedupe_key', 'text', (c) => c.notNull().unique())
    .addColumn('ordering_key', 'text', (c) => c.notNull())
    .addColumn('payload_enc', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (c) => c.notNull())
    .addColumn('run_at', 'text', (c) => c.notNull())
    .addColumn('locked_until', 'text')
    .addColumn('last_error', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('finished_at', 'text')
    .execute();
  await db.schema.createIndex('jobs_ready').on('jobs').columns(['status', 'run_at']).execute();
  await db.schema.createIndex('jobs_ordering').on('jobs').columns(['ordering_key', 'status', 'created_at']).execute();

  await db.schema
    .createTable('events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('connection_id', 'text', (c) => c.references('connections.id').onDelete('set null'))
    .addColumn('job_id', 'text')
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('direction', 'text', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('duration_ms', 'integer')
    .addColumn('error', 'text')
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('refs', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('detail', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('events_created').on('events').column('created_at').execute();
  await db.schema.createIndex('events_connection').on('events').columns(['connection_id', 'created_at']).execute();
  await db.schema.createIndex('events_job').on('events').column('job_id').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of ['events', 'jobs', 'message_links', 'contacts', 'connections', 'providers', 'settings', 'sessions', 'users']) {
    await db.schema.dropTable(t).ifExists().execute();
  }
}
