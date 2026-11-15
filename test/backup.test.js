import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { useTestDb, serverUrl, testDbName } from './helpers/db.js';
import { tmpDir } from './helpers/tmp.js';
import { openDb } from '../src/db.js';
import { backup, restore, PG_BIN } from '../src/backup.js';
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
