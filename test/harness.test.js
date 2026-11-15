import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, serverReachable, serverUrl, TEST_DB_PATTERN } from './helpers/db.js';
import { openDb } from '../src/db.js';
import { schemaStatus } from '../src/schema.js';

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
