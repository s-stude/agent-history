import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';
import { migrateWithLock, NewerSchemaError } from '../src/migrate.js';
import { schemaStatus } from '../src/schema.js';
import { readerRoleSql } from '../src/roles.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const PSQL = '/Applications/Postgres 18.app/Contents/Versions/latest/bin/psql';

async function addSession(db, id = 's1') {
  await db('sessions').insert({ id, tool: 'claude', native_id: id, project: 'proj' });
}

async function addMessage(db, fields) {
  const [row] = await db('messages')
    .insert({ session_id: 's1', record_id: 'r1', block_ordinal: 0, kind: 'text', ...fields })
    .returning('id');
  return row.id;
}

function fts(db, query) {
  return db('messages').whereRaw("text_tsv @@ websearch_to_tsquery('simple', ?)", [query]).pluck('id');
}

test('init twice is idempotent and leaves the schema current', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  assert.equal((await migrateWithLock(h.url)).length, 2);
  assert.equal((await migrateWithLock(h.url)).length, 0);
  assert.equal((await schemaStatus(h.db)).state, 'current');
});

test('two simultaneous first-time inits on a pristine DB both succeed', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  const results = await Promise.all([migrateWithLock(h.url), migrateWithLock(h.url)]);
  assert.equal(results.flat().length, 2);
  const { rows } = await h.db.raw('SELECT count(*)::int AS n FROM knex_migrations_lock');
  assert.equal(rows[0].n, 1);
  assert.equal((await schemaStatus(h.db)).state, 'current');
});

test('init via CLI from an unrelated cwd, then doctor says current', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  const env = { ...process.env, AGENT_HISTORY_DATABASE_URL: h.url };
  const init = await run(process.execPath, [BIN, 'init'], { env, cwd: '/' });
  assert.match(init.stdout, /migrations applied: 2/);
  const doctor = await run(process.execPath, [BIN, 'doctor'], { env, cwd: '/' });
  assert.match(doctor.stdout, /^schema\tcurrent \(2 applied, 0 pending, 0 unknown\)$/m);
});

test('a DB with an unknown migration is refused as newer', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await h.db('knex_migrations').insert({ name: '999_future.js', batch: 9, migration_time: new Date() });
  assert.equal((await schemaStatus(h.db)).state, 'newer');
  await assert.rejects(migrateWithLock(h.url), NewerSchemaError);
  const r = await run(process.execPath, [BIN, 'init'], { env: { ...process.env, AGENT_HISTORY_DATABASE_URL: h.url } }).catch((e) => e);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /NewerSchemaError: database has migrations this code does not know/);
});

test('search indexes are GIN', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const defs = await h.db('pg_indexes').where({ tablename: 'messages' }).select('indexname', 'indexdef');
  const by = Object.fromEntries(defs.map((d) => [d.indexname, d.indexdef]));
  assert.match(by.messages_text_tsv_gin, /USING gin \(text_tsv\)/);
  assert.match(by.messages_files_gin, /USING gin \(files\)/);
  assert.match(by.messages_text_trgm, /USING gin \(text gin_trgm_ops\)/);
});

test('generated tsvector follows insert, update and delete', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await addSession(h.db);
  const id = await addMessage(h.db, { text: 'we picked knex for migrations' });
  assert.deepEqual(await fts(h.db, 'knex'), [id]);
  await h.db('messages').where({ id }).update({ text: 'we picked drizzle instead' });
  assert.deepEqual(await fts(h.db, 'knex'), []);
  assert.deepEqual(await fts(h.db, 'drizzle'), [id]);
  await h.db('messages').where({ id }).del();
  assert.deepEqual(await fts(h.db, 'drizzle'), []);
});

test('a 5 MB block inserts; FTS covers the first 100,000 chars, ILIKE the rest', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await addSession(h.db);
  const filler = 'lorem ipsum dolor sit amet '.repeat(200_000);
  const text = `earlytoken ${filler.slice(0, 120_000)} latetoken ${filler}`.slice(0, 5_000_000);
  const id = await addMessage(h.db, { text });
  assert.deepEqual(await fts(h.db, 'earlytoken'), [id]);
  assert.deepEqual(await fts(h.db, 'latetoken'), []);
  const fallback = await h.db('messages')
    .join('sessions', 'sessions.id', 'messages.session_id')
    .where('sessions.project', 'proj')
    .where('messages.text', 'ilike', '%latetoken%')
    .pluck('messages.id');
  assert.deepEqual(fallback, [id]);
});

test('trigram ILIKE finds a path fragment', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await addSession(h.db);
  const id = await addMessage(h.db, { text: 'edited src/parsers/codex.js and test/inventory.test.js' });
  assert.deepEqual(await h.db('messages').where('text', 'ilike', '%parsers/code%').pluck('id'), [id]);
});

test('row key is unique per session, record and block', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await addSession(h.db);
  await addMessage(h.db, { block_ordinal: 0 });
  await addMessage(h.db, { block_ordinal: 1 });
  await assert.rejects(addMessage(h.db, { block_ordinal: 1 }), /messages_row_key/);
});

test('reader role SQL grants only SELECT and a read-only default', () => {
  const sql = readerRoleSql({ database: 'agent_history', owner: 'ahalilov' });
  const joined = sql.join(';\n');
  assert.match(joined, /CREATE ROLE "agent_history_reader" LOGIN/);
  assert.match(joined, /SET default_transaction_read_only = on/);
  const grants = sql.filter((s) => /\bGRANT\b/.test(s));
  for (const g of grants) assert.match(g, /GRANT (SELECT|CONNECT|USAGE) /);
  assert.doesNotMatch(joined, /INSERT|UPDATE|DELETE|TRUNCATE|SUPERUSER|CREATEDB|CREATEROLE|ALL PRIVILEGES/);
  assert.throws(() => readerRoleSql({ role: 'x"; DROP' }), /unsafe identifier/);
});

test('Postgres.app psql runs the pointer query in a read-only transaction', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await addSession(h.db);
  await addMessage(h.db, { text: 'decided to keep the trigram index for paths' });
  const sql = [
    'BEGIN READ ONLY;',
    "SELECT s.project, m.ts, ts_headline('simple', m.text, q) AS hit",
    "FROM messages m JOIN sessions s ON s.id = m.session_id, websearch_to_tsquery('simple', 'trigram index') q",
    'WHERE m.text_tsv @@ q ORDER BY ts_rank(m.text_tsv, q) DESC LIMIT 5;',
    'COMMIT;',
  ].join(' ');
  const { stdout } = await run(PSQL, ['--dbname', h.url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  assert.match(stdout, /proj\|\|.*<b>trigram<\/b> <b>index<\/b>/);
});

async function migrationsDir(t, body) {
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, '001_probe.js'), `${body}\nexport async function down() {}\n`);
  return dir;
}

async function tableExists(db, name) {
  const { rows } = await db.raw('SELECT to_regclass(?) AS t', [`public.${name}`]);
  return rows[0].t !== null;
}

test('losing the init connection mid-migration commits nothing', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  const dir = await migrationsDir(t, `export async function up(knex) {
  await knex.schema.createTable('probe', (t) => t.integer('n'));
  await knex.raw('SELECT pg_sleep(10)');
}`);
  const running = migrateWithLock(h.url, { migrationsDirectory: dir });
  let killed = 0;
  for (let i = 0; i < 50 && !killed; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await h.db.raw(
      "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%pg_sleep(10)%' AND pid <> pg_backend_pid()",
    );
    killed = rows.filter((r) => r.ok).length;
  }
  assert.equal(killed, 1);
  await assert.rejects(running);
  assert.equal(await tableExists(h.db, 'probe'), false);
  assert.equal(await tableExists(h.db, 'knex_migrations'), false);
  assert.equal(await tableExists(h.db, 'knex_migrations_lock'), false);
});

test('a failing migration rolls back bootstrap and earlier steps', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  const dir = await migrationsDir(t, `export async function up(knex) {
  await knex.schema.createTable('probe', (t) => t.integer('n'));
  throw new Error('boom');
}`);
  await assert.rejects(migrateWithLock(h.url, { migrationsDirectory: dir }), /boom/);
  assert.equal(await tableExists(h.db, 'probe'), false);
  assert.equal(await tableExists(h.db, 'knex_migrations'), false);
});
