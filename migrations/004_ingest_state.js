export async function up(knex) {
  await knex.schema.alterTable('sources', (t) => {
    t.jsonb('parser_state');
    t.integer('parser_version');
  });
  await knex.schema.raw(
    'CREATE INDEX messages_provisional ON messages (session_id) WHERE provisional',
  );
  await knex.schema.raw('CREATE INDEX messages_source_path ON messages (source_path)');
}

export async function down(knex) {
  await knex.schema.raw('DROP INDEX IF EXISTS messages_source_path');
  await knex.schema.raw('DROP INDEX IF EXISTS messages_provisional');
  await knex.schema.alterTable('sources', (t) => {
    t.dropColumn('parser_version');
    t.dropColumn('parser_state');
  });
}
