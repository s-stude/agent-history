export async function up(knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.text('call_id');
    t.index(['session_id', 'call_id'], 'messages_session_call_id');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.dropIndex(['session_id', 'call_id'], 'messages_session_call_id');
    t.dropColumn('call_id');
  });
}
