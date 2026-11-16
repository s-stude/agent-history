import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readlink, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';
import { plan } from '../scripts/install.js';
import { prepare } from '../scripts/codex-probe.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const INSTALL = fileURLToPath(new URL('../scripts/install.js', import.meta.url));

test('an unreadable .env never fails the hook, but fails ordinary commands clearly', async (t) => {
  const dir = await tmpDir(t);
  const env = { ...process.env, AGENT_HISTORY_DOTENV: '1', AGENT_HISTORY_DOTENV_FILE: dir, AGENT_HISTORY_HOME: path.join(dir, 'home') };
  const child = (await import('node:child_process')).spawn(process.execPath, [BIN, 'ingest'], { env });
  child.stdin.end('{}');
  assert.equal(await new Promise((r) => child.on('close', r)), 0);
  assert.match(await readFile(path.join(dir, 'home', 'ingest.log'), 'utf8'), /\tdotenv-/);
  const r = await run(process.execPath, [BIN, 'doctor'], { env }).catch((e) => e);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot load \.env/);
});

test('launchd and skill plans use the resolved layout', () => {
  const steps = plan('launchd:load', { home: '/h', uid: 501 });
  assert.deepEqual(steps.map((s) => s.args), [
    ['bootstrap', 'gui/501', '/h/Library/LaunchAgents/com.agent-history.scan.plist'],
    ['bootstrap', 'gui/501', '/h/Library/LaunchAgents/com.agent-history.backup.plist'],
  ]);
  assert.deepEqual(plan('launchd:unload', { home: '/h', uid: 501 }).map((s) => s.args[1]), ['gui/501/com.agent-history.scan', 'gui/501/com.agent-history.backup']);
  assert.equal(plan('skill:install', { home: '/h' })[0].link, '/h/.claude/skills/retrospective');
});

test('skill install is idempotent; uninstall removes only our symlink', async (t) => {
  const dir = await tmpDir(t);
  const env = { ...process.env, AGENT_HISTORY_DOTENV: '0', CLAUDE_CONFIG_DIR: path.join(dir, 'claude') };
  const link = path.join(dir, 'claude', 'skills', 'retrospective');
  const dry = await run(process.execPath, [INSTALL, 'skill:install'], { env });
  assert.match(dry.stdout, /^would run\tln -s /m);
  await assert.rejects(lstat(link));
  for (let i = 0; i < 2; i++) await run(process.execPath, [INSTALL, 'skill:install', '--apply'], { env });
  assert.equal(await readlink(link), fileURLToPath(new URL('../skills/retrospective', import.meta.url)));
  await run(process.execPath, [INSTALL, 'skill:uninstall', '--apply'], { env });
  await assert.rejects(lstat(link));
  await mkdir(path.dirname(link), { recursive: true });
  await symlink('/somewhere/else', link);
  const r = await run(process.execPath, [INSTALL, 'skill:uninstall', '--apply'], { env }).catch((e) => e);
  assert.equal(r.code, 1);
  assert.equal(await readlink(link), '/somewhere/else');
});

test('the Codex probe home records payloads without touching the real ~/.codex', async (t) => {
  const dir = await tmpDir(t);
  const real = path.join(dir, 'real-codex');
  await mkdir(real);
  const { out } = await prepare(path.join(dir, 'probe'), real);
  const hooks = JSON.parse(await readFile(path.join(dir, 'probe', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionStart', 'Stop', 'SubagentStop']);
  const child = (await import('node:child_process')).spawn('/bin/sh', ['-c', hooks.hooks.Stop[0].hooks[0].command]);
  child.stdin.end('{"hook_event_name":"Stop","turn_id":"t1"}');
  await new Promise((r) => child.on('close', r));
  assert.equal(JSON.parse((await readFile(out, 'utf8')).trim()).turn_id, 't1');
});

const { apply, main } = await import('../scripts/install.js');
const { runProbe } = await import('../scripts/codex-probe.js');
const { EventEmitter } = await import('node:events');

test('unload treats only a not-loaded job as success', async () => {
  const step = { cmd: 'launchctl', args: ['bootout', 'gui/501/com.agent-history.scan'], tolerate: true };
  const notLoaded = async () => { throw Object.assign(new Error('x'), { code: 3, stderr: 'Boot-out failed: 3: No such process' }); };
  await apply(step, { exec: notLoaded });
  const denied = async () => { throw Object.assign(new Error('x'), { code: 1, stderr: 'Boot-out failed: 1: Operation not permitted' }); };
  await assert.rejects(apply(step, { exec: denied }));
  const logs = [];
  const errors = [];
  const code = await main(['launchd:unload', '--apply'], { exec: denied, log: (l) => logs.push(l), error: (l) => errors.push(l) });
  assert.equal(code, 1);
  assert.equal(logs.length, 0, 'nothing reported as ran');
});

test('unknown flags or extra arguments are rejected before any action', async () => {
  for (const argv of [['skill:install', '--apply', '--home', '/isolated'], ['skill:install', 'extra'], ['launchd:load', '--aply'], ['nope'], []]) {
    let calls = 0;
    const errors = [];
    const code = await main(argv, { exec: async () => { calls++; }, log: () => { calls++; }, error: (l) => errors.push(l) });
    assert.equal(code, 2, argv.join(' '));
    assert.equal(calls, 0, argv.join(' '));
  }
});

function fakeSpawn({ code = 0, payload = null, out }) {
  return () => {
    const child = new EventEmitter();
    setImmediate(async () => {
      if (payload) await (await import('node:fs/promises')).appendFile(out(), `${payload}\n`);
      child.emit('close', code);
    });
    return child;
  };
}

test('the probe reports only this run, and fails on a failed or empty run', async (t) => {
  const dir = await tmpDir(t);
  const probe = path.join(dir, 'probe');
  const out = () => path.join(probe, 'payload.jsonl');
  const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
  await md(probe, { recursive: true });
  const stale = '{"hook_event_name":"Stop","old":"x"}';
  const quiet = () => {};

  await wf(out(), `${stale}\n`);
  assert.equal(await runProbe({ dir: probe, spawnFn: fakeSpawn({ code: 9, out }), log: quiet }), 9);

  await wf(out(), `${stale}\n`);
  assert.equal(await runProbe({ dir: probe, spawnFn: fakeSpawn({ code: 0, out }), log: quiet }), 1);

  await wf(out(), `${stale}\n`);
  const lines = [];
  const ok = await runProbe({ dir: probe, spawnFn: fakeSpawn({ code: 0, payload: '{"hook_event_name":"Stop","turn_id":"t9"}', out }), log: (l) => lines.push(l) });
  assert.equal(ok, 0);
  assert.deepEqual(lines, ['Stop: hook_event_name=string, turn_id=string']);
});
