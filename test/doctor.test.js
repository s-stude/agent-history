import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';
import { makeRoots, write } from './helpers/tmp.js';
import { doctor } from '../src/doctor.js';
import { scan } from '../src/scan.js';
import { insertProvisional, recordError } from '../src/ingest.js';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const PARENT = '43cec861-2203-414b-bfc7-b732d4b880f0';

async function setup(t) {
  const h = await useTestDb(t);
  if (!h) return null;
  const { roots, env, dir } = await makeRoots(t);
  const main = path.join(roots.claudeProjects, '-w-demo', `${PARENT}.jsonl`);
  await write(main, await readFile(path.join(FIX, 'claude/main.jsonl'), 'utf8'));
  await mkdir(env.AGENT_HISTORY_HOME, { recursive: true, mode: 0o700 });
  await scan(h.db, { roots });
  const run = () => doctor(h.db, { roots, env: { ...process.env, ...env } });
  const level = async (check) => (await run()).checks.find((c) => c.check === check)?.level;
  return { ...h, roots, env, dir, main, run, level };
}

test('a fully ingested tree passes', async (t) => {
  const e = await setup(t);
  if (!e) return;
  const r = await e.run();
  assert.equal(r.failed, false, JSON.stringify(r.checks.filter((c) => c.level === 'fail')));
  assert.equal(await e.level('claude_missing'), 'ok');
});

test('missing, partial and unsupported sources fail', async (t) => {
  const e = await setup(t);
  if (!e) return;
  await write(path.join(e.roots.claudeProjects, '-w-demo', '43cec861-2203-414b-bfc7-b732d4b88001.jsonl'), '{"type":"mode"}\n');
  await appendFile(e.main, `{"type":"mode","timestamp":"${new Date(Date.now() - 3_600_000).toISOString()}"}\n`);
  await write(path.join(e.roots.codexSessions, 'weird.jsonl'), '{}\n');
  const r = await e.run();
  assert.equal(r.failed, true);
  assert.equal(await e.level('claude_missing'), 'fail');
  assert.equal(await e.level('claude_partial'), 'fail');
  assert.equal(await e.level('unsupported'), 'fail');
});

test('a trailing partial line is not reported as partial', async (t) => {
  const e = await setup(t);
  if (!e) return;
  await appendFile(e.main, '{"type":"mo');
  assert.equal(await e.level('claude_partial'), 'ok');
});

test('a stale provisional row fails; a recovered source returns doctor to ok', async (t) => {
  const e = await setup(t);
  if (!e) return;
  await insertProvisional(e.db, { sessionId: `claude:${PARENT}`, tool: 'claude', nativeId: PARENT, text: 'never arrives', ts: new Date(Date.now() - 3_600_000) });
  assert.equal(await e.level('stale_provisional'), 'fail');
  await e.db('messages').where({ provisional: true }).del();
  await recordError(e.db, { sourcePath: e.main, errorClass: 'SyntheticError' });
  assert.equal(await e.level('unresolved_errors'), 'fail');
  await appendFile(e.main, '{"type":"mode"}\n');
  await scan(e.db, { roots: e.roots });
  assert.equal(await e.level('unresolved_errors'), 'ok');
  assert.equal((await e.run()).failed, false);
});

test('wrong file modes under the history home fail', async (t) => {
  const e = await setup(t);
  if (!e) return;
  const log = path.join(e.env.AGENT_HISTORY_HOME, 'ingest.log');
  await writeFile(log, '');
  await chmod(log, 0o644);
  assert.equal(await e.level('file_modes'), 'fail');
  await chmod(log, 0o600);
  assert.equal(await e.level('file_modes'), 'ok');
});

test('CLI doctor: unreachable server exits 1', async (t) => {
  const { env } = await makeRoots(t);
  const r = await promisify(execFile)(process.execPath, [BIN, 'doctor'], {
    env: { ...process.env, ...env, AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none' },
  }).catch((err) => err);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /agent-history doctor: /);
});

test('a same-size in-place rewrite is reported stale before the next scan', async (t) => {
  const e = await setup(t);
  if (!e) return;
  const text = await readFile(e.main, 'utf8');
  await writeFile(e.main, text.replace('Add a retry', 'Add a RETRY'));
  assert.equal(await e.level('claude_stale'), 'fail');
  await scan(e.db, { roots: e.roots });
  assert.equal(await e.level('claude_stale'), 'ok');
});

test('nested backups and exports with wrong modes fail; symlinks are flagged', async (t) => {
  const e = await setup(t);
  if (!e) return;
  const home = e.env.AGENT_HISTORY_HOME;
  await mkdir(path.join(home, 'backups'), { mode: 0o700 });
  await mkdir(path.join(home, 'md', 'demo'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, 'backups', 'x.dump'), '', { mode: 0o644 });
  await writeFile(path.join(home, 'md', 'demo', 'x.md'), '', { mode: 0o600 });
  assert.equal(await e.level('file_modes'), 'fail');
  await chmod(path.join(home, 'backups', 'x.dump'), 0o600);
  assert.equal(await e.level('file_modes'), 'ok');
  await chmod(path.join(home, 'md', 'demo', 'x.md'), 0o640);
  assert.equal(await e.level('file_modes'), 'fail');
  await chmod(path.join(home, 'md', 'demo', 'x.md'), 0o600);
  const { symlink } = await import('node:fs/promises');
  await symlink('/etc/hosts', path.join(home, 'md', 'link.md'));
  const detail = (await e.run()).checks.find((c) => c.check === 'file_modes').detail;
  assert.match(detail, /link\.md symlink/);
});

test('role audit: a role that can truncate, own or create is not read-only', async (t) => {
  const e = await setup(t);
  if (!e) return;
  const { roleStatus } = await import('../src/doctor.js');
  const { rows } = await e.db.raw('SELECT current_user AS u');
  assert.equal(await roleStatus(e.db, rows[0].u), 'can-write');
  assert.equal(await roleStatus(e.db, 'agent_history_role_that_does_not_exist'), 'missing');
});

const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test('a backlog younger than 20 minutes warns; older fails, even while new lines keep arriving', async (t) => {
  const e = await setup(t);
  if (!e) return;
  await appendFile(e.main, `{"type":"attachment","timestamp":"${at(1)}"}\n`);
  let r = await e.run();
  assert.equal(r.failed, false);
  assert.equal(r.checks.find((c) => c.check === 'claude_catching_up').level, 'warn');
  const e2 = await setup(t);
  await appendFile(e2.main, `{"type":"attachment","timestamp":"${at(25)}"}\n`);
  for (const m of [10, 3, 0]) await appendFile(e2.main, `{"type":"user","timestamp":"${at(m)}"}\n`);
  r = await e2.run();
  assert.equal(r.failed, true, 'appends keep coming but the oldest pending record is 25 minutes old');
  assert.equal(await e2.level('claude_partial'), 'fail');
});

test('an idle session that gets its first new line gets the grace period', async (t) => {
  const e = await setup(t);
  if (!e) return;
  await e.db('sources').update({ updated_at: new Date(Date.now() - 3 * 86_400_000) });
  await appendFile(e.main, `{"type":"user","timestamp":"${at(0)}"}\n`);
  assert.equal(await e.level('claude_partial'), 'ok');
  assert.equal((await e.run()).failed, false);
});

test('a pending line without a timestamp is aged by the last checkpoint', async (t) => {
  const e = await setup(t);
  if (!e) return;
  await appendFile(e.main, '{"type":"attachment"}\n');
  assert.equal((await e.run()).failed, false);
  await e.db('sources').update({ updated_at: new Date(Date.now() - 30 * 60_000) });
  assert.equal(await e.level('claude_partial'), 'fail');
});

test('the pending-record age uses the top-level timestamp, never a nested one', async () => {
  const { lineTime } = await import('../src/doctor.js');
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '{"timestamp":"2020-01-01T00:00:00Z"}', timestamp: '2020-01-01T00:00:00Z' }] }, timestamp: '2026-11-16T10:00:00Z' });
  assert.equal(lineTime(line), Date.parse('2026-11-16T10:00:00Z'));
  assert.equal(lineTime('{"type":"attachment"}'), null);
  assert.equal(lineTime('{"timestamp": 5}'), null);
  assert.equal(lineTime('not json "timestamp":"2026-01-01T00:00:00Z"'), null);
  assert.equal(lineTime('[{"timestamp":"2026-01-01T00:00:00Z"}]'), null);
});
