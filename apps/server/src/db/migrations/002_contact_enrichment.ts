import { type Kysely, sql } from 'kysely';

/** Tracks contacts created with a placeholder name, so a real name can replace it later. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('contacts').addColumn('cw_name_placeholder', 'integer', (c) => c.notNull().defaultTo(0)).execute();
  await sql`update contacts set cw_name_placeholder = 1 where cw_contact_id is not null and phone is null and push_name is null and chat_jid not like '%@g.us' and chat_jid not like 'evobridge:%'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('contacts').dropColumn('cw_name_placeholder').execute();
}
