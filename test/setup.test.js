import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpDir } from './helpers/tmp.js';
import { BIN, HEAP_FLAG, MANAGED, commandLine, layout, mergeHooks, setup, writeWithBackup } from '../src/setup.js';
import { databaseUrl } from '../src/db.js';
import { rootsFromEnv } from '../src/inventory.js';
import { shellQuote } from '../src/shell.js';
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
  assert.equal(ours.command, `AGENT_HISTORY_HOME=${shellQuote(L.historyHome)} /opt/node/bin/node ${HEAP_FLAG} ${shellQuote(BIN)} ingest ${MANAGED}`);
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /scan --changed-since-last # agent-history:managed$/);
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

test('mixed hook groups keep unrelated handlers and metadata; reruns stay idempotent', () => {
  const managed = `${commandLine(['ingest'], '/n')} ${MANAGED}`;
  const config = {
    hooks: {
      Stop: [
        { matcher: 'x', note: 'keep', hooks: [{ type: 'command', command: managed, async: true }, { type: 'command', command: 'say unrelated' }] },
        { hooks: [{ type: 'command', command: `echo ${BIN} is mentioned but not managed` }] },
      ],
    },
  };
  const once = mergeHooks(config, { Stop: ['ingest'] }, '/n');
  const twice = mergeHooks(once, { Stop: ['ingest'] }, '/n');
  assert.deepEqual(twice, once);
  assert.deepEqual(once.hooks.Stop[0], { matcher: 'x', note: 'keep', hooks: [{ type: 'command', command: 'say unrelated' }] });
  assert.match(once.hooks.Stop[1].hooks[0].command, /is mentioned but not managed/);
  assert.equal(once.hooks.Stop.filter((g) => g.hooks.some((h) => h.command.endsWith(MANAGED))).length, 1);
});

test('scheduled jobs and hooks resolve the configured endpoint and roots in a clean environment', async (t) => {
  const { L, opts } = await home(t);
  const custom = { ...opts, url: 'postgresql://someone:secret@localhost:6543/custom_history' };
  await setup('launchd', { ...custom, apply: true });
  const clean = { AGENT_HISTORY_HOME: L.historyHome };
  assert.equal(databaseUrl(clean), 'postgresql://someone@localhost:6543/custom_history');
  assert.equal(rootsFromEnv(clean).claudeProjects, L.claudeProjects);
  const config = await readFile(path.join(L.historyHome, 'config.json'), 'utf8');
  assert.doesNotMatch(config, /secret/);
  const plist = await readFile(path.join(L.launchAgents, 'com.agent-history.scan.plist'), 'utf8');
  assert.ok(plist.includes(`<key>AGENT_HISTORY_HOME</key>\n    <string>${L.historyHome}</string>`));
  assert.equal(databaseUrl({ ...clean, AGENT_HISTORY_DATABASE_URL: 'postgresql://localhost/override' }), 'postgresql://localhost/override');
});

test('two different edits in the same second keep both earlier versions', async (t) => {
  const dir = await tmpDir(t);
  const file = path.join(dir, 'settings.json');
  await writeFile(file, 'original');
  const now = new Date('2026-11-16T00:00:00Z');
  await writeWithBackup(file, 'first', { now });
  await writeWithBackup(file, 'second', { now });
  const backups = (await readdir(dir)).filter((n) => n.includes('.bak-')).sort();
  const contents = await Promise.all(backups.map((b) => readFile(path.join(dir, b), 'utf8')));
  assert.deepEqual(contents.sort(), ['first', 'original']);
});

test('generated shell arguments survive spaces, quotes, dollars and backticks literally', async () => {
  const weird = ["/a b/node", "/x/it's/node", '/fake/$(printf SENTINEL)/node', '/tick/`id`/node', '/d/$HOME/n'];
  for (const value of weird) {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`]);
    assert.equal(stdout, value);
  }
  const line = commandLine(['scan'], '/fake/$(printf SENTINEL)/node');
  const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `set -- ${line}; printf '%s\n' "$1"`]);
  assert.equal(stdout.trim(), '/fake/$(printf SENTINEL)/node');
});

test('root precedence: AGENT_HISTORY_* env, then native tool homes, then saved config, then defaults', async (t) => {
  const dir = await tmpDir(t);
  const hist = path.join(dir, 'hist');
  await mkdir(hist, { recursive: true });
  await writeFile(path.join(hist, 'config.json'), JSON.stringify({ roots: { claudeProjects: '/saved/claude', codexSessions: '/saved/codex', codexArchived: '/saved/arch' } }));
  const base = { AGENT_HISTORY_HOME: hist };
  assert.equal(rootsFromEnv(base).claudeProjects, '/saved/claude');
  assert.equal(rootsFromEnv({ ...base, CLAUDE_CONFIG_DIR: '/isolated/claude' }).claudeProjects, '/isolated/claude/projects');
  assert.equal(rootsFromEnv({ ...base, CODEX_HOME: '/isolated/codex' }).codexArchived, '/isolated/codex/archived_sessions');
  assert.equal(rootsFromEnv({ ...base, CLAUDE_CONFIG_DIR: '/isolated/claude', AGENT_HISTORY_CLAUDE_PROJECTS: '/explicit' }).claudeProjects, '/explicit');
  assert.equal(rootsFromEnv({}, '/h', { useSaved: false }).codexSessions, '/h/.codex/sessions');
});

test('setup without --home honours AGENT_HISTORY_HOME and the effective roots; a clean job env reads them back', async (t) => {
  const dir = await tmpDir(t);
  const env = {
    AGENT_HISTORY_HOME: path.join(dir, 'custom-history'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude-home'),
    CODEX_HOME: path.join(dir, 'codex-home'),
    AGENT_HISTORY_CLAUDE_PROJECTS: path.join(dir, 'transcripts'),
    AGENT_HISTORY_CODEX_SESSIONS: path.join(dir, 'codex-sessions'),
    AGENT_HISTORY_CODEX_ARCHIVED: path.join(dir, 'codex-archive'),
  };
  const L = layout({ env });
  assert.equal(L.historyHome, env.AGENT_HISTORY_HOME);
  assert.equal(L.claudeSettings, path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
  await setup('hooks', { env, apply: true, node: '/n', url: 'postgresql://localhost:6543/custom_history', log: () => {} });
  const clean = { AGENT_HISTORY_HOME: env.AGENT_HISTORY_HOME };
  assert.deepEqual(rootsFromEnv(clean), {
    claudeProjects: env.AGENT_HISTORY_CLAUDE_PROJECTS,
    codexSessions: env.AGENT_HISTORY_CODEX_SESSIONS,
    codexArchived: env.AGENT_HISTORY_CODEX_ARCHIVED,
  });
  assert.equal(databaseUrl(clean), 'postgresql://localhost:6543/custom_history');
  await readFile(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8');
});

test('a later setup step keeps the transcript roots saved by an earlier one', async (t) => {
  const dir = await tmpDir(t);
  const native = { AGENT_HISTORY_HOME: path.join(dir, 'hist'), CLAUDE_CONFIG_DIR: path.join(dir, 'ch'), CODEX_HOME: path.join(dir, 'cx') };
  const roots = { AGENT_HISTORY_CLAUDE_PROJECTS: '/custom/claude', AGENT_HISTORY_CODEX_SESSIONS: '/custom/sessions', AGENT_HISTORY_CODEX_ARCHIVED: '/custom/archive' };
  const quiet = { apply: true, node: '/n', url: 'postgresql://localhost/agent_history', log: () => {} };
  await setup('hooks', { ...quiet, env: { ...native, ...roots } });
  await setup('hooks', { ...quiet, env: native });
  const saved = JSON.parse(await readFile(path.join(native.AGENT_HISTORY_HOME, 'config.json'), 'utf8')).roots;
  assert.deepEqual(saved, { claudeProjects: '/custom/claude', codexSessions: '/custom/sessions', codexArchived: '/custom/archive' });
});

test('the installed hook command finds a custom history home from a cleared environment', async (t) => {
  const dir = await tmpDir(t);
  const transcripts = path.join(dir, 'transcripts');
  await mkdir(path.join(transcripts, '-p'), { recursive: true });
  await writeFile(path.join(transcripts, '-p', '43cec861-2203-414b-bfc7-b732d4b880f0.jsonl'), '{"type":"mode"}\n');
  const env = {
    AGENT_HISTORY_HOME: path.join(dir, 'custom-history'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'ch'),
    CODEX_HOME: path.join(dir, 'cx'),
    AGENT_HISTORY_CLAUDE_PROJECTS: transcripts,
    AGENT_HISTORY_CODEX_SESSIONS: path.join(dir, 'none1'),
    AGENT_HISTORY_CODEX_ARCHIVED: path.join(dir, 'none2'),
  };
  await setup('hooks', { env, apply: true, node: process.execPath, url: 'postgresql://localhost:6543/custom_history', log: () => {} });
  const settings = JSON.parse(await readFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const ingest = settings.hooks.Stop.at(-1).hooks[0].command;
  assert.ok(ingest.startsWith(`AGENT_HISTORY_HOME=${shellQuote(env.AGENT_HISTORY_HOME)} `));
  const dryRun = ingest.replace(/ ingest # agent-history:managed$/, ' scan --dry-run');
  const { stdout } = await promisify(execFile)('/usr/bin/env', ['-i', 'PATH=/usr/bin:/bin', `HOME=${dir}`, '/bin/sh', '-c', dryRun]);
  assert.match(stdout, /^claude\tplain\tactive\troot\t1$/m);
  assert.match(stdout, /^sessions\t1$/m);
});
