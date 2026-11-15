import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';
import { makeRoots, write, writeZst } from './helpers/tmp.js';
import { scan } from '../src/scan.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PARENT = '43cec861-2203-414b-bfc7-b732d4b880f0';

async function tree(t) {
  const { roots } = await makeRoots(t);
  const proj = path.join(roots.claudeProjects, '-w-demo');
  await write(path.join(proj, `${PARENT}.jsonl`), await readFile(path.join(FIX, 'claude/main.jsonl'), 'utf8'));
  for (const a of ['a1', 'a2']) await write(path.join(proj, PARENT, 'subagents', `agent-${a}.jsonl`), await readFile(path.join(FIX, `claude/agent-${a}.jsonl`), 'utf8'));
  const names = await readdir(path.join(FIX, 'codex'));
  for (const [i, name] of names.entries()) {
    const text = await readFile(path.join(FIX, 'codex', name), 'utf8');
    if (i % 2) await writeZst(path.join(roots.codexArchived, `${name}.zst`), text);
    else await write(path.join(roots.codexSessions, '2026/11/02', name), text);
  }
  return roots;
}

test('scan ingests every source; a second scan skips them all', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const roots = await tree(t);
  const first = await scan(h.db, { roots });
  assert.equal(first.sources, 7);
  assert.equal(first.ingested, 7);
  assert.equal(first.errors, 0);
  assert.equal(Number((await h.db('sessions').count({ n: '*' }))[0].n), 7);
  const second = await scan(h.db, { roots });
  assert.equal(second.skipped, 7);
  assert.equal(second.rows, 0);
  const third = await scan(h.db, { roots, changedSinceLast: true });
  assert.equal(third.skipped, 7);
});

test('--tool limits the scan', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const roots = await tree(t);
  const r = await scan(h.db, { roots, tool: 'codex' });
  assert.equal(r.sources, 4);
  assert.deepEqual(await h.db('sessions').distinct('tool').pluck('tool'), ['codex']);
});

test('a corrupt source is recorded and the scan continues', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const roots = await tree(t);
  await write(path.join(roots.codexArchived, 'rollout-2026-11-03T09-00-00-01a0813d-de8d-7a63-885f-1777a897b7ff.jsonl.zst'), 'not zstd');
  const r = await scan(h.db, { roots });
  assert.equal(r.errors, 1);
  assert.equal(r.ingested, 7);
  const errors = await h.db('ingest_errors').select('source_path', 'error_class', 'detail');
  assert.equal(errors.length, 1);
  assert.match(errors[0].source_path, /b7ff\.jsonl\.zst$/);
  assert.equal(errors[0].detail, null);
});

test('--changed-since-last still replays an immutable source parsed by an older parser', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const roots = await tree(t);
  await scan(h.db, { roots });
  const zst = await h.db('sources').where('encoding', 'zst').first();
  await h.db('sources').where({ path: zst.path }).update({ parser_version: 0 });
  const r = await scan(h.db, { roots, changedSinceLast: true });
  assert.equal(r.ingested, 1);
  assert.equal((await h.db('sources').where({ path: zst.path }).first()).parser_version, 1);
});

test('history stays searchable after the source transcript is deleted', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const roots = await tree(t);
  await scan(h.db, { roots });
  const { rm } = await import('node:fs/promises');
  await rm(path.join(roots.claudeProjects, '-w-demo', `${PARENT}.jsonl`));
  const r = await scan(h.db, { roots });
  assert.equal(r.errors, 0);
  const hits = await h.db('messages').whereRaw("text_tsv @@ websearch_to_tsquery('simple', 'retry backoff')").pluck('session_id');
  assert.deepEqual(hits, [`claude:${PARENT}`]);
});
