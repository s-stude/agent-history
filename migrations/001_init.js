export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  await knex.schema.createTable('sessions', (t) => {
    t.text('id').primary();
    t.text('tool').notNullable();
    t.text('native_id').notNullable();
    t.text('parent_id');
    t.text('agent_id');
    t.text('workflow_id');
    t.boolean('is_sidechain').notNullable().defaultTo(false);
    t.text('project');
    t.text('cwd');
    t.timestamp('started_at', { useTz: true });
    t.timestamp('ended_at', { useTz: true });
    t.text('title');
    t.text('source_path');
    t.text('cli_version');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['project', 'started_at'], 'sessions_project_started_at');
    t.index(['parent_id'], 'sessions_parent_id');
  });

  await knex.schema.createTable('messages', (t) => {
    t.bigIncrements('id').primary();
    t.text('session_id').notNullable().references('id').inTable('sessions').onDelete('CASCADE');
    t.text('record_id').notNullable();
    t.integer('block_ordinal').notNullable();
    t.timestamp('ts', { useTz: true });
    t.text('role');
    t.text('phase');
    t.text('kind').notNullable();
    t.text('turn_id');
    t.text('text');
    t.text('tool_name');
    t.specificType('files', 'text[]').notNullable().defaultTo('{}');
    t.boolean('provisional').notNullable().defaultTo(false);
    t.text('raw');
    t.text('source_path');
    t.integer('source_line');
    t.text('content_hash');
    t.integer('parser_version');
    t.specificType(
      'text_tsv',
      "tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(coalesce(text, ''), 100000))) STORED",
    );
    t.unique(['session_id', 'record_id', 'block_ordinal'], { indexName: 'messages_row_key' });
    t.index(['session_id', 'ts'], 'messages_session_ts');
    t.index(['text_tsv'], 'messages_text_tsv_gin', { storageEngineIndexType: 'gin' });
    t.index(['files'], 'messages_files_gin', { storageEngineIndexType: 'gin' });
  });

  await knex.schema.createTable('sources', (t) => {
    t.text('path').primary();
    t.text('session_id');
    t.text('tool').notNullable();
    t.text('encoding').notNullable();
    t.text('content_hash');
    t.bigInteger('inode');
    t.bigInteger('size');
    t.bigInteger('byte_offset').notNullable().defaultTo(0);
    t.integer('last_line').notNullable().defaultTo(0);
    t.text('prefix_fingerprint');
    t.bigInteger('generation').notNullable().defaultTo(0);
    t.text('status').notNullable().defaultTo('pending');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('ingest_errors', (t) => {
    t.bigIncrements('id').primary();
    t.timestamp('ts', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('source_path');
    t.integer('line');
    t.text('error_class').notNullable();
    t.text('detail');
    t.timestamp('resolved_at', { useTz: true });
  });

  await knex.schema.createTable('unknown_types', (t) => {
    t.text('tool').notNullable();
    t.text('type').notNullable();
    t.text('subtype').notNullable().defaultTo('');
    t.bigInteger('count').notNullable().defaultTo(0);
    t.primary(['tool', 'type', 'subtype']);
  });
}

export async function down(knex) {
  for (const table of ['unknown_types', 'ingest_errors', 'sources', 'messages', 'sessions']) {
    await knex.schema.dropTableIfExists(table);
  }
}
