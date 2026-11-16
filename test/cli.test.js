import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';
import { makeRoots } from './helpers/tmp.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const COMMANDS = ['init', 'ingest', 'scan', 'export', 'doctor', 'setup', 'backup', 'snapshot-config', 'restore'];

function cli(args, env = {}) {
  return run(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, cwd: '/' }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
}

test('--help exits 0 and lists every subcommand', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0);
  for (const c of COMMANDS) assert.match(r.stdout, new RegExp(`^  ${c}\\b`, 'm'));
});

test('unknown command prints usage and exits 2', async () => {
  const r = await cli(['nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage: agent-history/);
});

test('doctor against a refused port exits 1 quickly', async () => {
  const started = Date.now();
  const r = await cli(['doctor'], { AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /agent-history doctor: /);
  assert.ok(Date.now() - started < 5000);
});

test('doctor reports an uninitialized test DB from an unrelated cwd and fails', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  const { env } = await makeRoots(t);
  const r = await cli(['doctor'], { AGENT_HISTORY_DATABASE_URL: h.url, ...env });
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, new RegExp(`^info\\tdatabase\\t${h.name}$`, 'm'));
  assert.match(r.stdout, /^fail\tschema\tuninitialized/m);
});

test('subcommand --help and -h show usage without running the command', async () => {
  const env = { AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none' };
  for (const args of [['init', '--help'], ['init', '-h'], ['doctor', '--help']]) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.stdout, /Usage: agent-history/);
  }
});

test('unknown flags are rejected before a command runs', async () => {
  const r = await cli(['init', '--bogus'], { AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none' });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /agent-history init: .*bogus/);
});

test('unknown options before the command are rejected without running it', async () => {
  const env = { AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none' };
  for (const args of [['--bogus', 'init'], ['--dry-run', 'init']]) {
    const r = await cli(args, env);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /unknown option before the command/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|agent-history init:/);
  }
});

test('ingest reads hook JSON from stdin and exits 0 even when the server is unreachable', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp } = await import('node:fs/promises');
  const { REPO } = await import('./helpers/tmp.js');
  const home = await mkdtemp(`${REPO}tmp/cli-home-`);
  const child = spawn(process.execPath, [BIN, 'ingest'], {
    env: { ...process.env, AGENT_HISTORY_HOME: home, AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none' },
    cwd: '/',
  });
  child.stdin.end(JSON.stringify({ session_id: 'abc', transcript_path: '/nonexistent/x.jsonl' }));
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  const { readFile, rm } = await import('node:fs/promises');
  const log = await readFile(`${home}/ingest.log`, 'utf8');
  assert.match(log, /\tabc\t/);
  await rm(home, { recursive: true, force: true });
});

test('ingest exits 0 with a malformed URL or an unwritable history home', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { REPO } = await import('./helpers/tmp.js');
  const dir = await mkdtemp(`${REPO}tmp/cli-fail-`);
  const homeFile = `${dir}/not-a-dir`;
  await writeFile(homeFile, 'x');
  const cases = [
    { AGENT_HISTORY_DATABASE_URL: 'not a url', AGENT_HISTORY_HOME: `${dir}/home` },
    { AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost:1/agent_history_test_none', AGENT_HISTORY_HOME: homeFile },
  ];
  for (const extra of cases) {
    for (const input of ['{not json', JSON.stringify({ session_id: 'abc', transcript_path: '/nonexistent/x.jsonl' })]) {
      const child = spawn(process.execPath, [BIN, 'ingest'], { env: { ...process.env, ...extra }, cwd: '/' });
      child.stdin.end(input);
      const code = await new Promise((r) => child.on('close', r));
      assert.equal(code, 0, JSON.stringify(extra));
    }
  }
  await rm(dir, { recursive: true, force: true });
});
