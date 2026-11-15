import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { BIN, HEAP_FLAG, layout, setup } from '../src/setup.js';
import { POINTER_END, POINTER_START } from '../src/pointer.js';

async function home(t) {
  const h = await tmpDir(t);
  const L = layout({ home: h });
  await mkdir(path.dirname(L.claudeSettings), { recursive: true });
  await mkdir(path.dirname(L.codexHooks), { recursive: true });
  await writeFile(L.claudeSettings, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } }));
  await writeFile(L.claudeMd, '# Mine\n\nKeep this.\n');
  const logs = [];
  const opts = { home: h, node: '/opt/node/bin/node', url: 'postgresql://owner:pw@localhost:5432/agent_history', log: (l) => logs.push(l) };
  return { h, L, logs, opts };
}

async function files(dir) {
  return (await readdir(dir, { recursive: true })).sort();
}

test('dry runs write nothing', async (t) => {
  const { h, opts } = await home(t);
  const before = await files(h);
  for (const what of ['cleanup-period', 'hooks', 'launchd', 'pointer', 'export', 'mirror', 'database']) await setup(what, opts);
  assert.deepEqual(await files(h), before);
});

test('hooks: merged, unrelated hooks kept, idempotent, backed up once', async (t) => {
  const { h, L, opts } = await home(t);
  await setup('hooks', { ...opts, apply: true });
  await setup('hooks', { ...opts, apply: true });
  const s = JSON.parse(await readFile(L.claudeSettings, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'guard');
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
  const ours = s.hooks.Stop[1].hooks[0];
  assert.equal(ours.async, true);
  assert.equal(ours.command, `"/opt/node/bin/node" ${HEAP_FLAG} "${BIN}" ingest`);
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /scan --changed-since-last$/);
  assert.equal(s.hooks.SubagentStop.length, 1);
  const codex = JSON.parse(await readFile(L.codexHooks, 'utf8'));
  assert.deepEqual(Object.keys(codex.hooks).sort(), ['SessionStart', 'Stop', 'SubagentStop']);
  const backups = (await readdir(path.dirname(L.claudeSettings))).filter((n) => n.includes('.bak-'));
  assert.equal(backups.length, 1, 'second apply changed nothing, so no second backup');
  const config = JSON.parse(await readFile(path.join(L.historyHome, 'config.json'), 'utf8'));
  assert.equal(config.node, '/opt/node/bin/node');
});

test('cleanup period keeps other settings', async (t) => {
  const { L, opts } = await home(t);
  await setup('cleanup-period', { ...opts, apply: true });
  const s = JSON.parse(await readFile(L.claudeSettings, 'utf8'));
  assert.equal(s.cleanupPeriodDays, 36500);
  assert.equal(s.theme, 'dark');
});

test('pointer is inserted once between markers, replaced on rerun, and includes exports when enabled', async (t) => {
  const { L, opts } = await home(t);
  await setup('pointer', { ...opts, apply: true });
  await setup('export', { ...opts, apply: true });
  await setup('pointer', { ...opts, apply: true });
  for (const file of [L.claudeMd, L.agentsMd]) {
    const text = await readFile(file, 'utf8');
    assert.equal(text.split(POINTER_START).length, 2, file);
    assert.equal(text.split(POINTER_END).length, 2, file);
    assert.match(text, /agent_history_reader@localhost:5432/);
    assert.match(text, /Markdown copies/);
    assert.doesNotMatch(text, /owner|:pw@/);
  }
  assert.match(await readFile(L.claudeMd, 'utf8'), /^# Mine\n\nKeep this\.\n\n<!-- agent-history/);
});

test('launchd plists are valid and use absolute paths', async (t) => {
  const { L, opts } = await home(t);
  await setup('launchd', { ...opts, apply: true });
  for (const name of ['com.agent-history.scan.plist', 'com.agent-history.backup.plist']) {
    const file = path.join(L.launchAgents, name);
    await promisify(execFile)('/usr/bin/plutil', ['-lint', file]);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes('<string>/opt/node/bin/node</string>'));
    assert.ok(text.includes(`<string>${BIN}</string>`));
    assert.ok(text.includes(HEAP_FLAG));
  }
  assert.match(await readFile(path.join(L.launchAgents, 'com.agent-history.scan.plist'), 'utf8'), /<key>StartInterval<\/key>\n  <integer>900<\/integer>/);
});

test('database dry run prints the plan and the read-only role SQL', async (t) => {
  const { logs, opts } = await home(t);
  await setup('database', opts);
  const text = logs.join('\n');
  assert.match(text, /CREATE DATABASE "agent_history"/);
  assert.match(text, /default_transaction_read_only = on/);
  assert.match(text, /GRANT SELECT ON ALL TABLES/);
  logs.length = 0;
  await setup('database', { ...opts, rolesOnly: true });
  assert.doesNotMatch(logs.join('\n'), /CREATE DATABASE|GRANT/);
});
