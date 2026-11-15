import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';
import { makeRoots, write } from './helpers/tmp.js';
import { scan } from '../src/scan.js';
import { exportSessions } from '../src/export.js';
import { runHook } from '../src/hook.js';
import * as S from './fixtures/secrets.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PARENT = '43cec861-2203-414b-bfc7-b732d4b880f0';

async function filesUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out;
}

test('export writes one private markdown file per session with the answers and no secrets', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const { roots, dir } = await makeRoots(t);
  const proj = path.join(roots.claudeProjects, '-w-demo');
  const extra = JSON.stringify({ type: 'user', uuid: 'sx', sessionId: PARENT, cwd: '/Users/me/projects/demo', timestamp: '2026-11-01T10:03:00.000Z', message: { role: 'user', content: `token ${S.GITHUB} and DB_PASSWORD=${S.ENV_VALUE}` } });
  await write(path.join(proj, `${PARENT}.jsonl`), `${await readFile(path.join(FIX, 'claude/main.jsonl'), 'utf8')}${extra}\n`);
  for (const a of ['a1', 'a2']) await write(path.join(proj, PARENT, 'subagents', `agent-${a}.jsonl`), await readFile(path.join(FIX, `claude/agent-${a}.jsonl`), 'utf8'));
  await scan(h.db, { roots });
  const root = path.join(dir, 'md');
  const written = await exportSessions(h.db, { root });
  assert.equal(written.length, 3);
  assert.deepEqual((await filesUnder(root)).sort(), [...written].sort());
  const main = await readFile(written.find((f) => f.endsWith(`claude_${PARENT}.md`)), 'utf8');
  assert.match(main, /^# Fetch retry work$/m);
  assert.match(main, /Added retry with backoff; tests pass\./);
  for (const f of written) {
    const text = await readFile(f, 'utf8');
    for (const secret of S.ALL) assert.ok(!text.includes(secret), secret.slice(0, 8));
    assert.equal((await stat(f)).mode & 0o777, 0o600);
  }
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, 'demo'))).mode & 0o777, 0o700);
});

test('the hook exports touched sessions only when export is enabled', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const { roots, env } = await makeRoots(t);
  const file = path.join(roots.claudeProjects, '-w-demo', `${PARENT}.jsonl`);
  await write(file, await readFile(path.join(FIX, 'claude/main.jsonl'), 'utf8'));
  const hookEnv = { ...process.env, ...env };
  const md = path.join(env.AGENT_HISTORY_HOME, 'md');
  await runHook(JSON.stringify({ session_id: PARENT, transcript_path: file }), { env: hookEnv, roots, url: h.url });
  await assert.rejects(readdir(md));
  await mkdir(env.AGENT_HISTORY_HOME, { recursive: true, mode: 0o700 });
  await writeFile(path.join(env.AGENT_HISTORY_HOME, 'config.json'), JSON.stringify({ export: true }), { mode: 0o600 });
  await runHook(JSON.stringify({ session_id: PARENT, transcript_path: file }), { env: hookEnv, roots, url: h.url });
  assert.equal((await filesUnder(md)).length, 1);
});

test('export paths stay inside the root for dot and punctuation project names', async () => {
  const { exportPath } = await import('../src/export.js');
  const root = '/mirror/md';
  for (const project of ['..', '.', '...', '!!!', '', null, '../etc', '.hidden']) {
    const file = exportPath(root, { id: 'claude:x', project, started_at: null });
    assert.equal(path.dirname(path.dirname(file)), root, String(project));
  }
  assert.equal(exportPath(root, { id: 'claude:abc', project: 'demo', started_at: new Date('2026-11-01T00:00:00Z') }), '/mirror/md/demo/2026-11-01-claude_abc.md');
});

test('overlapping exports of one session both succeed and leave the newest content', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  const { dir } = await makeRoots(t);
  await h.db('sessions').insert({ id: 's1', tool: 'claude', native_id: 's1', project: 'demo' });
  await h.db('messages').insert({ session_id: 's1', record_id: 'r1', block_ordinal: 0, kind: 'prompt', role: 'user', text: 'first' });
  const root = path.join(dir, 'md');
  const other = h.open();
  const a = exportSessions(h.db, { root });
  const b = exportSessions(other, { root });
  await Promise.all([a, b]);
  await h.db('messages').insert({ session_id: 's1', record_id: 'r2', block_ordinal: 0, kind: 'prompt', role: 'user', text: 'second' });
  await Promise.all([exportSessions(h.db, { root }), exportSessions(other, { root })]);
  const files = await filesUnder(root);
  assert.equal(files.length, 1, 'no temp files left');
  assert.match(await readFile(files[0], 'utf8'), /second/);
});
