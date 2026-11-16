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
