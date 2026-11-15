export async function up(knex) {
  await knex.schema.raw('CREATE INDEX messages_text_trgm ON messages USING gin (text gin_trgm_ops)');
}

export async function down(knex) {
  await knex.schema.raw('DROP INDEX IF EXISTS messages_text_trgm');
}
