import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { useTestDb } from './helpers/db.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const COMMANDS = ['init', 'ingest', 'scan', 'export', 'doctor', 'setup'];

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

test('doctor reports an uninitialized test DB from an unrelated cwd', async (t) => {
  const h = await useTestDb(t, { migrate: false });
  if (!h) return;
  const r = await cli(['doctor'], { AGENT_HISTORY_DATABASE_URL: h.url });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^database\\t${h.name}$`, 'm'));
  assert.match(r.stdout, /^schema\tuninitialized/m);
});
