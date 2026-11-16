import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, rm, truncate, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';
import { makeRoots, write, writeZst } from './helpers/tmp.js';
import { buildInventory } from '../src/inventory.js';
import { ingestSource, insertProvisional, StaleCheckpointError } from '../src/ingest.js';
import { runHook } from '../src/hook.js';
import * as S from './fixtures/secrets.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PARENT = '43cec861-2203-414b-bfc7-b732d4b880f0';
const THREAD = '01a0813d-de8d-7a63-885f-1777a897b70c';
const CODEX_NAME = `rollout-2026-11-02T09-00-00-${THREAD}.jsonl`;

const claudeLines = async () => (await readFile(path.join(FIX, 'claude/main.jsonl'), 'utf8')).split('\n').filter(Boolean);
const codexLines = async () => (await readFile(path.join(FIX, 'codex', CODEX_NAME), 'utf8')).split('\n').filter(Boolean);

async function env(t) {
  const h = await useTestDb(t);
  if (!h) return null;
  const { roots, dir } = await makeRoots(t);
  const claudeFile = path.join(roots.claudeProjects, '-w-demo', `${PARENT}.jsonl`);
  const codexFile = path.join(roots.codexSessions, '2026/11/02', CODEX_NAME);
  const source = async (file) => (await buildInventory(roots)).sources.find((s) => s.path === file);
  return { ...h, roots, dir, claudeFile, codexFile, source };
}

async function snapshot(db) {
  const messages = await db('messages')
    .select('session_id', 'record_id', 'block_ordinal', 'role', 'kind', 'phase', 'turn_id', 'text', 'tool_name', 'call_id', 'files', 'provisional', 'raw')
    .orderBy(['session_id', 'record_id', 'block_ordinal']);
  const sessions = await db('sessions')
    .select('id', 'title', 'project', 'started_at', 'ended_at', 'parent_id', 'cli_version')
    .orderBy('id');
  return { messages, sessions };
}

async function checkpoint(db, file) {
  return db('sources').where({ path: file }).first();
}

test('chunked and one-shot ingest give identical rows and checkpoints', async (t) => {
  const e = await env(t);
  if (!e) return;
  await write(e.claudeFile, `${(await claudeLines()).join('\n')}\n`);
  const one = await e.open();
  await ingestSource(e.db, await e.source(e.claudeFile));
  const a = await snapshot(e.db);
  const cpA = await checkpoint(e.db, e.claudeFile);
  await e.db('messages').del();
  await e.db('sessions').del();
  await e.db('sources').del();
  await ingestSource(one, await e.source(e.claudeFile), { batchLines: 2 });
  assert.deepEqual(await snapshot(e.db), a);
  const cpB = await checkpoint(e.db, e.claudeFile);
  assert.equal(cpB.byte_offset, cpA.byte_offset);
  assert.equal(cpB.last_line, cpA.last_line);
  assert.equal(cpB.status, 'done');
  assert.ok(Number(cpB.generation) > Number(cpA.generation), 'every batch advances the generation');
});

test('repeated ingest is a no-op', async (t) => {
  const e = await env(t);
  if (!e) return;
  await write(e.claudeFile, `${(await claudeLines()).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const before = await snapshot(e.db);
  const gen = (await checkpoint(e.db, e.claudeFile)).generation;
  const r = await ingestSource(e.db, await e.source(e.claudeFile));
  assert.equal(r.skipped, true);
  assert.deepEqual(await snapshot(e.db), before);
  assert.equal((await checkpoint(e.db, e.claudeFile)).generation, gen);
});

test('append and resume equals a full parse, across parser state (Claude and Codex)', async (t) => {
  const e = await env(t);
  if (!e) return;
  for (const [file, lines] of [[e.claudeFile, await claudeLines()], [e.codexFile, await codexLines()]]) {
    for (const cut of [3, 9, 17]) {
      await e.db('messages').del();
      await e.db('sessions').del();
      await e.db('sources').del();
      await write(file, `${lines.slice(0, cut).join('\n')}\n`);
      await ingestSource(e.db, await e.source(file), { batchLines: 4 });
      await appendFile(file, `${lines.slice(cut).join('\n')}\n`);
      const r = await ingestSource(e.db, await e.source(file), { batchLines: 4 });
      assert.equal(r.lines, lines.length - cut, 'only appended lines are read');
      const resumed = await snapshot(e.db);
      await e.db('messages').del();
      await e.db('sessions').del();
      await e.db('sources').del();
      await ingestSource(e.db, await e.source(file));
      assert.deepEqual(resumed, await snapshot(e.db), `${path.basename(file)} cut ${cut}`);
    }
  }
});

test('a crash between batches resumes to the same result', async (t) => {
  const e = await env(t);
  if (!e) return;
  await write(e.claudeFile, `${(await claudeLines()).join('\n')}\n`);
  let batches = 0;
  await assert.rejects(
    ingestSource(e.db, await e.source(e.claudeFile), {
      batchLines: 3,
      onBatch: () => {
        if (++batches === 2) throw new Error('crash');
      },
    }),
    /crash/,
  );
  const cp = await checkpoint(e.db, e.claudeFile);
  assert.equal(cp.status, 'partial');
  assert.equal(cp.last_line, 6);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const resumed = await snapshot(e.db);
  await e.db('messages').del();
  await e.db('sessions').del();
  await e.db('sources').del();
  await ingestSource(e.db, await e.source(e.claudeFile));
  assert.deepEqual(resumed, await snapshot(e.db));
});

test('two ingesters on one growing file end with the same rows as one ingester', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  await write(e.claudeFile, `${lines.slice(0, 8).join('\n')}\n`);
  const other = e.open();
  const first = ingestSource(e.db, await e.source(e.claudeFile), { batchLines: 2 });
  await appendFile(e.claudeFile, `${lines.slice(8, 14).join('\n')}\n`);
  const second = ingestSource(other, await e.source(e.claudeFile), { batchLines: 2 });
  await appendFile(e.claudeFile, `${lines.slice(14).join('\n')}\n`);
  await Promise.all([first, second]);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const both = await snapshot(e.db);
  await e.db('messages').del();
  await e.db('sessions').del();
  await e.db('sources').del();
  await ingestSource(e.db, await e.source(e.claudeFile));
  assert.deepEqual(both, await snapshot(e.db));
  assert.equal((await checkpoint(e.db, e.claudeFile)).last_line, lines.length);
});

test('a partial last line and a split UTF-8 character wait for completion', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  const prompt = JSON.stringify({
    type: 'user', uuid: 'utf', sessionId: PARENT, cwd: '/w/demo', timestamp: '2026-11-01T10:05:00.000Z',
    message: { role: 'user', content: 'Привет, мир — 你好' },
  });
  const bytes = Buffer.from(`${prompt}\n`);
  const cut = bytes.indexOf(Buffer.from('你')) + 1;
  await write(e.claudeFile, `${lines.join('\n')}\n`);
  await appendFile(e.claudeFile, bytes.subarray(0, cut));
  await ingestSource(e.db, await e.source(e.claudeFile));
  assert.equal(await e.db('messages').where({ record_id: 'utf' }).first(), undefined);
  const cp = await checkpoint(e.db, e.claudeFile);
  assert.equal(cp.last_line, lines.length);
  await appendFile(e.claudeFile, bytes.subarray(cut));
  await ingestSource(e.db, await e.source(e.claudeFile));
  const row = await e.db('messages').where({ record_id: 'utf' }).first();
  assert.equal(row.text, 'Привет, мир — 你好');
});

test('truncation and same-size rewrite are detected and replayed', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  await write(e.claudeFile, `${lines.join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const firstPrompt = JSON.parse(lines[2]);
  await truncate(e.claudeFile, 0);
  await appendFile(e.claudeFile, `${lines.slice(0, 5).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  assert.equal(await e.db('messages').where({ record_id: 'a-4' }).first(), undefined, 'rows past the truncation are gone');
  const original = await readFile(e.claudeFile, 'utf8');
  const rewritten = original.replace(firstPrompt.message.content, firstPrompt.message.content.replace('retry', 'RETRY'));
  assert.equal(rewritten.length, original.length);
  await writeFile(e.claudeFile, rewritten);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const row = await e.db('messages').where({ record_id: 'u-1' }).first();
  assert.match(row.text, /RETRY/);
});

test('a stale writer cannot commit after the file was replaced and replayed to the same offset', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  const oldText = `${lines.slice(0, 6).join('\n')}\n`;
  const newText = oldText.replace('Add a retry', 'Add a RETRY');
  await write(e.claudeFile, oldText);
  let release;
  const paused = new Promise((r) => (release = r));
  let reached;
  const atCommit = new Promise((r) => (reached = r));
  let firstCall = true;
  const stale = ingestSource(e.db, await e.source(e.claudeFile), {
    beforeCommit: async () => {
      if (!firstCall) return;
      firstCall = false;
      reached();
      await paused;
    },
  });
  await atCommit;
  await writeFile(e.claudeFile, newText);
  const other = e.open();
  await ingestSource(other, await e.source(e.claudeFile));
  release();
  await stale;
  const row = await e.db('messages').where({ record_id: 'u-1' }).first();
  assert.match(row.text, /RETRY/, 'old content never overwrote the replacement');
});

test('a plain Codex file replaced by its .zst copy keeps one set of rows', async (t) => {
  const e = await env(t);
  if (!e) return;
  const text = `${(await codexLines()).join('\n')}\n`;
  await write(e.codexFile, text);
  await ingestSource(e.db, await e.source(e.codexFile));
  const before = await snapshot(e.db);
  await rm(e.codexFile);
  const zst = path.join(e.roots.codexArchived, `${CODEX_NAME}.zst`);
  await writeZst(zst, text);
  await ingestSource(e.db, await e.source(zst));
  const after = await snapshot(e.db);
  assert.deepEqual(after.messages.map(({ raw, ...m }) => m), before.messages.map(({ raw, ...m }) => m));
  const again = await ingestSource(e.db, await e.source(zst));
  assert.equal(again.skipped, true, 'immutable copy is ingested once');
});

test('tool names are filled from the DB when the tool_use was in an earlier run', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  await write(e.claudeFile, `${lines.slice(0, 6).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  await appendFile(e.claudeFile, `${lines.slice(6).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const results = await e.db('messages').where({ kind: 'tool_result' }).orderBy('record_id').pluck('tool_name');
  assert.deepEqual(results, ['Read', 'Bash']);
});

test('provisional answers: duplicates collapse; replaced by the transcript (Codex by turn, Claude by text)', async (t) => {
  const e = await env(t);
  if (!e) return;
  const sid = `codex:${THREAD}`;
  await insertProvisional(e.db, { sessionId: sid, tool: 'codex', nativeId: THREAD, text: 'Renamed fetchJson to getJson.', turnId: 'turn-1' });
  await insertProvisional(e.db, { sessionId: sid, tool: 'codex', nativeId: THREAD, text: 'Renamed fetchJson to getJson.', turnId: 'turn-1' });
  assert.equal((await e.db('messages').where({ provisional: true })).length, 1);
  await write(e.codexFile, `${(await codexLines()).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.codexFile));
  assert.equal((await e.db('messages').where({ provisional: true })).length, 0);

  const cid = `claude:${PARENT}`;
  const lines = await claudeLines();
  await write(e.claudeFile, `${lines.slice(0, 3).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  await insertProvisional(e.db, { sessionId: cid, tool: 'claude', nativeId: PARENT, text: 'Added retry with backoff; tests pass.', ts: new Date('2026-11-01T10:00:11.000Z') });
  assert.equal((await e.db('messages').where({ session_id: cid, provisional: true })).length, 1);
  await appendFile(e.claudeFile, `${lines.slice(3).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  assert.equal((await e.db('messages').where({ session_id: cid, provisional: true })).length, 0);
  const real = await e.db('messages').where({ session_id: cid, kind: 'text', role: 'assistant', provisional: false }).pluck('text');
  assert.ok(real.includes('Added retry with backoff; tests pass.'));
});

test('ten concurrent writers on different sessions', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  const files = [];
  for (let i = 0; i < 10; i++) {
    const sid = `43cec861-2203-414b-bfc7-b732d4b880${String(i).padStart(2, '0')}`;
    const file = path.join(e.roots.claudeProjects, '-w-demo', `${sid}.jsonl`);
    await write(file, `${lines.map((l) => l.replaceAll(PARENT, sid)).join('\n')}\n`);
    files.push(file);
  }
  const inv = await buildInventory(e.roots);
  await Promise.all(files.map((f) => ingestSource(e.open(), inv.sources.find((s) => s.path === f), { batchLines: 3 })));
  const counts = await e.db('messages').groupBy('session_id').select('session_id').count({ n: '*' });
  assert.equal(counts.length, 10);
  assert.equal(new Set(counts.map((c) => Number(c.n))).size, 1);
});

test('seeded secrets never reach messages, tsvector, sessions or the log', async (t) => {
  const e = await env(t);
  if (!e) return;
  const home = path.join(e.dir, 'home');
  const secretLines = [
    { type: 'user', uuid: 's1', message: { role: 'user', content: `keys ${S.ALL.slice(0, 10).join(' ')}` } },
    { type: 'user', uuid: 's2', message: { role: 'user', content: `${S.PEM}\nDB_PASSWORD=${S.ENV_VALUE}` } },
    { type: 'assistant', uuid: 's3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: `curl -H 'Authorization: Bearer ${S.BEARER}'`, env: { api_key: S.FIELD_VALUE } } }] } },
    { type: 'user', uuid: 's4', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: JSON.stringify({ password: S.FIELD_VALUE }) }] } },
    { type: 'custom-title', customTitle: `DB_PASSWORD=${S.ENV_VALUE}` },
    { type: 'ai-title', aiTitle: `title ${S.SLACK}` },
    { type: 'agent-name', agentName: `agent ${S.AWS}` },
  ].map((r) => JSON.stringify({ sessionId: PARENT, cwd: `/w/${S.AWS}/demo`, timestamp: '2026-11-01T10:00:00.000Z', ...r }));
  await write(e.claudeFile, `${secretLines.join('\n')}\n`);
  await runHook(JSON.stringify({ session_id: PARENT, transcript_path: e.claudeFile, last_assistant_message: `done ${S.GITHUB}` }), {
    env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url: e.url,
  });
  const dump = JSON.stringify(await e.db.raw('SELECT m.*, m.text_tsv::text AS tsv FROM messages m'))
    + JSON.stringify(await e.db('sessions'))
    + JSON.stringify(await e.db('sources').select('parser_state', 'path'));
  for (const secret of S.ALL) assert.ok(!dump.includes(secret), secret.slice(0, 10));
  const log = await readFile(path.join(home, 'ingest.log'), 'utf8').catch(() => '');
  for (const secret of S.ALL) assert.ok(!log.includes(secret));
});

test('hook: unreachable server or a hung handshake exits fast and logs ids only', async (t) => {
  const e = await env(t);
  if (!e) return;
  await write(e.claudeFile, `${(await claudeLines()).join('\n')}\n`);
  const home = path.join(e.dir, 'home');
  const sockets = new Set();
  const hung = createServer((socket) => sockets.add(socket));
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((r) => hung.close(r));
  });
  for (const url of ['postgresql://localhost:1/agent_history_test_none', `postgresql://127.0.0.1:${hung.address().port}/agent_history_test_none`]) {
    const started = Date.now();
    const r = await runHook(JSON.stringify({ session_id: PARENT, transcript_path: e.claudeFile, last_assistant_message: 'secret answer text' }), {
      env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url,
    });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 5000, url);
  }
  const log = await readFile(path.join(home, 'ingest.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 2);
  assert.ok(!log.includes('secret answer text'));
  assert.match(log, new RegExp(`\\t${PARENT}\\t`));
});

test('hook: paths outside the known roots are ignored; an uninitialized DB is not migrated', async (t) => {
  const e = await env(t);
  if (!e) return;
  const home = path.join(e.dir, 'home');
  const outside = path.join(e.dir, 'elsewhere', `${PARENT}.jsonl`);
  await write(outside, `${(await claudeLines()).join('\n')}\n`);
  await runHook(JSON.stringify({ session_id: PARENT, transcript_path: outside }), { env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url: e.url });
  assert.equal((await e.db('messages')).length, 0);
  assert.match(await readFile(path.join(home, 'ingest.log'), 'utf8'), /path-outside-roots/);

  const fresh = await useTestDb(t, { migrate: false });
  await runHook(JSON.stringify({ session_id: PARENT, transcript_path: e.claudeFile }), { env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url: fresh.url });
  const { rows } = await fresh.db.raw("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(rows[0].n, 0);
  assert.match(await readFile(path.join(home, 'ingest.log'), 'utf8'), /schema-uninitialized/);
});

test('StaleCheckpointError is exported for callers', () => {
  assert.equal(new StaleCheckpointError('x').name, 'StaleCheckpointError');
});

test('an in-place rewrite between reading and committing is caught by the next run', async (t) => {
  const e = await env(t);
  if (!e) return;
  const lines = await claudeLines();
  const oldText = `${lines.join('\n')}\n`;
  const newText = oldText.replace('Add a retry', 'Add a RETRY');
  await write(e.claudeFile, oldText);
  let done = false;
  await ingestSource(e.db, await e.source(e.claudeFile), {
    beforeCommit: async () => {
      if (done) return;
      done = true;
      await writeFile(e.claudeFile, newText);
    },
  });
  await ingestSource(e.db, await e.source(e.claudeFile));
  const row = await e.db('messages').where({ record_id: 'u-1' }).first();
  assert.match(row.text, /RETRY/);
  const final = await snapshot(e.db);
  await e.db('messages').del();
  await e.db('sessions').del();
  await e.db('sources').del();
  await ingestSource(e.db, await e.source(e.claudeFile));
  assert.deepEqual(final, await snapshot(e.db));
});

test('repeated Claude hook deliveries keep one provisional row until the answer arrives', async (t) => {
  const e = await env(t);
  if (!e) return;
  const now = new Date().toISOString();
  const lines = (await claudeLines()).map((l) => l.replace(/"timestamp": ?"[^"]+"/, `"timestamp":"${now}"`));
  await write(e.claudeFile, `${lines.slice(0, 3).join('\n')}\n`);
  const home = path.join(e.dir, 'home');
  const payload = JSON.stringify({ session_id: PARENT, transcript_path: e.claudeFile, last_assistant_message: 'Added retry with backoff; tests pass.' });
  for (let i = 0; i < 3; i++) {
    await runHook(payload, { env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url: e.url });
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await e.db('messages').where({ provisional: true })).length, 1);
  await appendFile(e.claudeFile, `${lines.slice(3).join('\n')}\n`);
  await runHook(payload, { env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url: e.url });
  assert.equal((await e.db('messages').where({ provisional: true })).length, 0);
});

test('duplicate record keys in one batch: last record wins for any batch size', async (t) => {
  const e = await env(t);
  if (!e) return;
  const mk = (text) => JSON.stringify({ type: 'user', uuid: 'dup', sessionId: PARENT, cwd: '/w/demo', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: text } });
  await write(e.claudeFile, `${mk('first version')}\n${mk('second version')}\n`);
  for (const batchLines of [500, 1]) {
    await e.db('messages').del();
    await e.db('sessions').del();
    await e.db('sources').del();
    await ingestSource(e.db, await e.source(e.claudeFile), { batchLines });
    const rows = await e.db('messages').where({ record_id: 'dup' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'second version', `batch ${batchLines}`);
  }
});

test('a batch is flushed early when its rows exceed the byte budget', async (t) => {
  const e = await env(t);
  if (!e) return;
  const big = (i) => JSON.stringify({ type: 'user', uuid: `b${i}`, sessionId: PARENT, cwd: '/w/demo', timestamp: '2026-11-01T10:00:00.000Z', message: { role: 'user', content: 'x'.repeat(4000) } });
  await write(e.claudeFile, `${[0, 1, 2, 3, 4].map(big).join('\n')}\n`);
  let batches = 0;
  await ingestSource(e.db, await e.source(e.claudeFile), { batchBytes: 9000, onBatch: () => batches++ });
  assert.equal(batches, 3);
  assert.equal((await e.db('messages')).length, 5);
});

test('hook against a corrupted schema exits cleanly and records a private diagnostic', async (t) => {
  const e = await env(t);
  if (!e) return;
  await write(e.claudeFile, `${(await claudeLines()).join('\n')}\n`);
  await e.db.raw('DROP TABLE messages CASCADE');
  const home = path.join(e.dir, 'home');
  const r = await runHook(JSON.stringify({ session_id: PARENT, transcript_path: e.claudeFile, last_assistant_message: 'private answer text' }), {
    env: { ...process.env, AGENT_HISTORY_HOME: home }, roots: e.roots, url: e.url,
  });
  assert.equal(typeof r.ok, 'boolean');
  const errors = await e.db('ingest_errors').select('error_class', 'detail');
  assert.deepEqual(errors.map((x) => [x.error_class, x.detail]), [['42P01', null]]);
  const log = await readFile(path.join(home, 'ingest.log'), 'utf8');
  assert.match(log, /\t42P01$/m);
  assert.ok(!log.includes('private answer text'));
});

test('a run that reads no complete line leaves the checkpoint untouched', async (t) => {
  const e = await env(t);
  if (!e) return;
  await write(e.claudeFile, `${(await claudeLines()).join('\n')}\n`);
  await ingestSource(e.db, await e.source(e.claudeFile));
  const before = await checkpoint(e.db, e.claudeFile);
  await new Promise((r) => setTimeout(r, 20));
  await appendFile(e.claudeFile, '{"type":"user","uuid":"half');
  const r = await ingestSource(e.db, await e.source(e.claudeFile));
  assert.equal(r.skipped, true);
  const after = await checkpoint(e.db, e.claudeFile);
  assert.equal(String(after.generation), String(before.generation));
  assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
  const fresh = path.join(e.roots.claudeProjects, '-w-demo', '43cec861-2203-414b-bfc7-b732d4b880aa.jsonl');
  await write(fresh, '{"type":"user","uuid":"only-partial');
  await ingestSource(e.db, await e.source(fresh));
  assert.ok(await checkpoint(e.db, fresh), 'a new source still gets its first checkpoint row');
});
