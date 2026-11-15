import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { useTestDb, serverUrl, testDbName } from './helpers/db.js';
import { tmpDir } from './helpers/tmp.js';
import { openDb } from '../src/db.js';
import { backup, grantsToRole, restore, PG_BIN } from '../src/backup.js';
import { migrationFiles } from '../src/schema.js';
import * as S from './fixtures/secrets.js';

async function seed(db) {
  await db('sessions').insert({ id: 's1', tool: 'claude', native_id: 's1', project: 'demo' });
  await db('messages').insert({ session_id: 's1', record_id: 'r', block_ordinal: 0, kind: 'text', role: 'assistant', text: 'we kept the trigram index [REDACTED:env]' });
}

function dropAfter(t, name) {
  t.after(async () => {
    const admin = openDb(serverUrl());
    try {
      await admin.raw('DROP DATABASE IF EXISTS ?? WITH (FORCE)', [name]);
    } finally {
      await admin.destroy();
    }
  });
}

test('backup writes a private dump, rotates only after success, and restores into a new DB', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await seed(h.db);
  const dir = await tmpDir(t);
  for (let i = 0; i < 4; i++) await writeFile(path.join(dir, `2026-01-0${i + 1}T00-00-00Z.dump`), 'old');
  const { file, removed } = await backup(h.url, dir, { keep: 3 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(removed, ['2026-01-01T00-00-00Z.dump', '2026-01-02T00-00-00Z.dump']);
  assert.equal((await readdir(dir)).length, 3);

  const name = testDbName('restore');
  dropAfter(t, name);
  const r = await restore(file, { serverUrl: serverUrl(), database: name });
  assert.equal(r.migrationsApplied, 0);
  const db = openDb(r.url);
  try {
    assert.equal((await db('messages')).length, 1);
    const hits = await db('messages').whereRaw("text_tsv @@ websearch_to_tsquery('simple', 'trigram')").pluck('record_id');
    assert.deepEqual(hits, ['r']);
    const [{ n }] = await db('knex_migrations').count({ n: '*' });
    assert.equal(Number(n), (await migrationFiles()).length, 'no duplicate migration rows');
  } finally {
    await db.destroy();
  }
  const { stdout } = await promisify(execFile)(path.join(PG_BIN, 'pg_restore'), ['-f', '-', file], { maxBuffer: 64 << 20 });
  for (const secret of S.ALL) assert.ok(!stdout.includes(secret));
});

test('a failed dump leaves older backups untouched', async (t) => {
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, '2026-01-01T00-00-00Z.dump'), 'old');
  await assert.rejects(backup('postgresql://localhost:1/agent_history_test_none', dir, { keep: 0 }), /pg_dump failed/);
  assert.deepEqual(await readdir(dir), ['2026-01-01T00-00-00Z.dump']);
});

test('restore frees a stale migration lock in the fresh copy and refuses existing DBs', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await h.db('knex_migrations_lock').update({ is_locked: 1 });
  const dir = await tmpDir(t);
  const { file } = await backup(h.url, dir);
  const name = testDbName('restore');
  dropAfter(t, name);
  const r = await restore(file, { serverUrl: serverUrl(), database: name });
  assert.equal(r.freedLock, true);
  const db = openDb(r.url);
  try {
    assert.equal((await db('knex_migrations_lock').first()).is_locked, 0);
  } finally {
    await db.destroy();
  }
  await assert.rejects(restore(file, { serverUrl: serverUrl(), database: name }), /already exists/);
  const [{ is_locked }] = await h.db('knex_migrations_lock');
  assert.equal(is_locked, 1, 'the source DB lock is never touched');
});

test('the reader-role preflight reads grant recipients from schema SQL', () => {
  assert.equal(grantsToRole('GRANT SELECT ON TABLE public.messages TO agent_history_reader;'), true);
  assert.equal(grantsToRole('ALTER DEFAULT PRIVILEGES FOR ROLE me IN SCHEMA public GRANT SELECT ON TABLES TO "agent_history_reader";'), true);
  assert.equal(grantsToRole('GRANT CONNECT ON DATABASE agent_history TO agent_history_reader;'), true);
  assert.equal(grantsToRole('3500; 0 0 ACL public TABLE messages owner'), false);
  assert.equal(grantsToRole('GRANT SELECT ON TABLE public.messages TO agent_history_readers;'), false);
  assert.equal(grantsToRole('-- GRANT SELECT TO agent_history_reader'), false);
});

test('overlapping backups produce distinct dumps; a failing one removes only its own temp', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const dir = await tmpDir(t);
  const now = new Date('2026-11-16T00:00:00Z');
  const [a, b] = await Promise.all([backup(h.url, dir, { now }), backup(h.url, dir, { now })]);
  assert.notEqual(a.file, b.file);
  const slow = backup(h.url, dir, { now });
  await assert.rejects(backup('postgresql://localhost:1/agent_history_test_none', dir, { now }), /pg_dump failed/);
  await slow;
  const names = await readdir(dir);
  assert.equal(names.filter((n) => n.endsWith('.dump')).length, 3);
  assert.equal(names.filter((n) => n.includes('.partial')).length, 0);
});

test('a failed pg_restore removes the database it created, so a retry is possible', async (t) => {
  const dir = await tmpDir(t);
  const bad = path.join(dir, 'bad.dump');
  const h = await useTestDb(t);
  if (!h) return;
  const { file } = await backup(h.url, dir);
  const bytes = await (await import('node:fs/promises')).readFile(file);
  await writeFile(bad, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const name = testDbName('restore');
  dropAfter(t, name);
  await assert.rejects(restore(bad, { serverUrl: serverUrl(), database: name }), /removed|pg_restore/);
  const admin = openDb(serverUrl());
  try {
    assert.equal(await admin('pg_database').where({ datname: name }).first(), undefined);
  } finally {
    await admin.destroy();
  }
});
