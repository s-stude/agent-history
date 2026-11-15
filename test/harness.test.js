import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, serverReachable, serverUrl, TEST_DB_PATTERN } from './helpers/db.js';
import { openDb } from '../src/db.js';
import { schemaStatus } from '../src/schema.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';

async function dbExists(name) {
  const admin = openDb(serverUrl());
  try {
    const r = await admin('pg_database').where({ datname: name }).count({ n: '*' });
    return Number(r[0].n) === 1;
  } finally {
    await admin.destroy();
  }
}

test('test DB is created with a safe name and dropped exactly', async (t) => {
  if (!(await serverReachable())) return t.skip('PostgreSQL server unreachable');
  const h = await createTestDb({ label: 'harness', migrate: false });
  try {
    assert.match(h.name, TEST_DB_PATTERN);
    assert.ok(await dbExists(h.name));
    const { rows } = await h.db.raw('SELECT current_database() AS d');
    assert.equal(rows[0].d, h.name);
  } finally {
    await h.drop();
  }
  assert.equal(await dbExists(h.name), false);
});

test('schema inspection of a pristine DB creates no migration tables', async (t) => {
  if (!(await serverReachable())) return t.skip('PostgreSQL server unreachable');
  const h = await createTestDb({ migrate: false });
  t.after(h.drop);
  const status = await schemaStatus(h.db);
  assert.equal(status.state, 'uninitialized');
  const { rows } = await h.db.raw("SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'knex_migrations%'");
  assert.equal(rows[0].n, 0);
});

test('a failing migration drops the created test DB', async (t) => {
  if (!(await serverReachable())) return t.skip('PostgreSQL server unreachable');
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, '001_broken.js'), "export async function up() { throw new Error('boom'); }\nexport async function down() {}\n");
  const created = [];
  await assert.rejects(createTestDb({ label: 'broken', migrationsDirectory: dir }), /boom/);
  const admin = openDb(serverUrl());
  try {
    const rows = await admin('pg_database').where('datname', 'like', 'agent\\_history\\_test\\_broken\\_' + process.pid + '\\_%').select('datname');
    created.push(...rows.map((r) => r.datname));
  } finally {
    await admin.destroy();
  }
  assert.deepEqual(created, []);
});

test('URL query options cannot override timeouts or application name', async () => {
  const { knexConfig, normalizeUrl } = await import('../src/db.js');
  const pg = (await import('pg')).default;
  const config = knexConfig('postgresql://u@localhost:1/x?statement_timeout=0&application_name=override&options=-c%20x&sslmode=disable');
  const client = new pg.Client(config.connection);
  assert.equal(client.connectionParameters.statement_timeout, 30000);
  assert.equal(client.connectionParameters.application_name, 'agent-history');
  assert.equal(normalizeUrl('postgresql://u@h:5/d?statement_timeout=0&sslmode=require'), 'postgresql://u@h:5/d?sslmode=require');
});
