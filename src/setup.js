import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { databaseUrl, normalizeUrl, openDb } from './db.js';
import { migrateWithLock } from './migrate.js';
import { pointerText, POINTER_END, POINTER_START } from './pointer.js';
import { readerRoleSql } from './roles.js';
import { shellQuote } from './shell.js';
import { loadConfig } from './config.js';
import { historyHome as resolveHistoryHome } from './paths.js';

const run = promisify(execFile);
export const HEAP_FLAG = '--max-old-space-size=192';
export const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
export const SCAN_LABEL = 'com.agent-history.scan';
export const BACKUP_LABEL = 'com.agent-history.backup';
export const MANAGED = '# agent-history:managed';

export function layout({ home, env = process.env } = {}) {
  const explicit = Boolean(home);
  const base = home ?? homedir();
  const claude = !explicit && env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : path.join(base, '.claude');
  const codex = !explicit && env.CODEX_HOME ? env.CODEX_HOME : path.join(base, '.codex');
  const history = explicit ? path.join(base, '.agent-history') : resolveHistoryHome(env);
  const saved = loadConfig({ AGENT_HISTORY_HOME: history }).roots ?? {};
  const ambient = explicit ? {} : env;
  const roots = {
    claudeProjects: ambient.AGENT_HISTORY_CLAUDE_PROJECTS || saved.claudeProjects || path.join(claude, 'projects'),
    codexSessions: ambient.AGENT_HISTORY_CODEX_SESSIONS || saved.codexSessions || path.join(codex, 'sessions'),
    codexArchived: ambient.AGENT_HISTORY_CODEX_ARCHIVED || saved.codexArchived || path.join(codex, 'archived_sessions'),
  };
  return {
    home: base,
    claudeSettings: path.join(claude, 'settings.json'),
    claudeMd: path.join(claude, 'CLAUDE.md'),
    codexHooks: path.join(codex, 'hooks.json'),
    agentsMd: path.join(codex, 'AGENTS.md'),
    ...roots,
    historyHome: history,
    launchAgents: path.join(base, 'Library', 'LaunchAgents'),
  };
}

export function commandLine(args, node = process.execPath, historyHome = null) {
  const env = historyHome ? `AGENT_HISTORY_HOME=${shellQuote(historyHome)} ` : '';
  return `${env}${[node, HEAP_FLAG, BIN, ...args].map(shellQuote).join(' ')}`;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON; fix it before running setup`);
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
}

async function exclusiveBackup(file, now) {
  for (let n = 0; ; n++) {
    const backup = `${file}.bak-${stamp(now)}${n ? `-${n}` : ''}`;
    try {
      await copyFile(file, backup, constants.COPYFILE_EXCL);
      await chmod(backup, 0o600);
      return backup;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

export async function writeWithBackup(file, content, { mode = 0o600, now = new Date() } = {}) {
  const old = await readText(file);
  if (old === content) return { file, changed: false, backup: null };
  await mkdir(path.dirname(file), { recursive: true });
  const backup = old !== null ? await exclusiveBackup(file, now) : null;
  await writeFile(file, content, { mode });
  return { file, changed: true, backup };
}

function hookEntry(command) {
  return { hooks: [{ type: 'command', command: `${command} ${MANAGED}`, async: true }] };
}

const isManaged = (h) => typeof h?.command === 'string' && h.command.trimEnd().endsWith(MANAGED);

export function mergeHooks(config, events, node, historyHome = null) {
  const out = structuredClone(config ?? {});
  out.hooks ??= {};
  for (const [event, args] of Object.entries(events)) {
    const groups = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const kept = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((h) => !isManaged(h));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    kept.push(hookEntry(commandLine(args, node, historyHome)));
    out.hooks[event] = kept;
  }
  return out;
}

const CLAUDE_EVENTS = { Stop: ['ingest'], SubagentStop: ['ingest'], SessionStart: ['scan', '--changed-since-last'] };
const CODEX_EVENTS = CLAUDE_EVENTS;

export function plist(label, args, { node, historyHome, interval = null, calendar = null }) {
  const programArgs = [node, HEAP_FLAG, BIN, ...args].map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  const schedule = interval
    ? `  <key>StartInterval</key>\n  <integer>${interval}</integer>\n  <key>RunAtLoad</key>\n  <true/>`
    : `  <key>StartCalendarInterval</key>\n  <dict>\n${Object.entries(calendar).map(([k, v]) => `    <key>${k}</key>\n    <integer>${v}</integer>`).join('\n')}\n  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
${schedule}
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(historyHome, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(historyHome, `${label}.err.log`))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_HISTORY_HOME</key>
    <string>${escapeXml(historyHome)}</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

function escapeXml(s) {
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function replacePointer(existing, block) {
  const text = existing ?? '';
  const start = text.indexOf(POINTER_START);
  const end = text.indexOf(POINTER_END);
  if (start !== -1 && end > start) {
    return `${text.slice(0, start)}${block.trimEnd()}${text.slice(end + POINTER_END.length)}`;
  }
  const sep = !text ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}`;
}

function runtimeConfig(L, { node, url }) {
  const endpoint = new URL(normalizeUrl(url));
  endpoint.password = '';
  return {
    node,
    bin: BIN,
    heap: HEAP_FLAG,
    url: endpoint.toString(),
    roots: { claudeProjects: L.claudeProjects, codexSessions: L.codexSessions, codexArchived: L.codexArchived },
  };
}

async function readConfig(L) {
  return (await readJson(path.join(L.historyHome, 'config.json'))) ?? {};
}

async function writeConfig(L, patch) {
  await mkdir(L.historyHome, { recursive: true, mode: 0o700 });
  await chmod(L.historyHome, 0o700);
  const next = { ...(await readConfig(L)), ...patch };
  return writeWithBackup(path.join(L.historyHome, 'config.json'), `${JSON.stringify(next, null, 2)}\n`);
}

async function planFiles(L, what, { node, url }) {
  const files = [];
  if (what === 'cleanup-period') {
    const settings = (await readJson(L.claudeSettings)) ?? {};
    files.push({ file: L.claudeSettings, content: `${JSON.stringify({ ...settings, cleanupPeriodDays: 36500 }, null, 2)}\n`, mode: 0o600 });
  } else if (what === 'hooks') {
    files.push({ file: L.claudeSettings, content: `${JSON.stringify(mergeHooks(await readJson(L.claudeSettings), CLAUDE_EVENTS, node, L.historyHome), null, 2)}\n`, mode: 0o600 });
    files.push({ file: L.codexHooks, content: `${JSON.stringify(mergeHooks(await readJson(L.codexHooks), CODEX_EVENTS, node, L.historyHome), null, 2)}\n`, mode: 0o600 });
  } else if (what === 'launchd') {
    files.push({ file: path.join(L.launchAgents, `${SCAN_LABEL}.plist`), content: plist(SCAN_LABEL, ['scan', '--changed-since-last'], { node, historyHome: L.historyHome, interval: 900 }), mode: 0o644 });
    files.push({ file: path.join(L.launchAgents, `${BACKUP_LABEL}.plist`), content: plist(BACKUP_LABEL, ['backup'], { node, historyHome: L.historyHome, calendar: { Weekday: 0, Hour: 3, Minute: 0 } }), mode: 0o644 });
  } else if (what === 'pointer') {
    const config = await readConfig(L);
    const block = pointerText({ url, exportDir: config.export ? path.join(L.historyHome, 'md') : null });
    for (const file of [L.claudeMd, L.agentsMd]) files.push({ file, content: replacePointer(await readText(file), block), mode: 0o644 });
  }
  return files;
}

function mirrorCommands(L) {
  const raw = path.join(L.historyHome, 'raw');
  return [
    [L.claudeProjects, path.join(raw, 'claude')],
    [L.codexSessions, path.join(raw, 'codex', 'sessions')],
    [L.codexArchived, path.join(raw, 'codex', 'archived_sessions')],
  ].map(([from, to]) => ['rsync', ['-a', '--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=', `${from}/`, `${to}/`]]);
}

export async function setup(what, { apply = false, home, env = process.env, node = process.execPath, url = databaseUrl(env), rolesOnly = false, log = console.log } = {}) {
  const L = layout({ home, env });
  if (['cleanup-period', 'hooks', 'launchd', 'pointer'].includes(what)) {
    const files = await planFiles(L, what, { node, url });
    for (const f of files) {
      const old = await readText(f.file);
      if (old === f.content) {
        log(`unchanged\t${f.file}`);
        continue;
      }
      if (!apply) {
        log(`would write\t${f.file}\n${f.content}`);
        continue;
      }
      const r = await writeWithBackup(f.file, f.content, { mode: f.mode });
      log(`wrote\t${f.file}${r.backup ? `\tbackup ${r.backup}` : ''}`);
    }
    if (what === 'hooks') log('next: in Codex run /hooks and trust the new hooks');
    if (what === 'launchd') {
      for (const label of [SCAN_LABEL, BACKUP_LABEL]) log(`next: launchctl bootstrap gui/$(id -u) ${shellQuote(path.join(L.launchAgents, `${label}.plist`))}`);
    }
    if (what === 'hooks' || what === 'launchd') {
      if (apply) await writeConfig(L, runtimeConfig(L, { node, url }));
      else log(`would record\t${path.join(L.historyHome, 'config.json')} (endpoint without password, transcript roots, node path)`);
    }
    return;
  }
  if (what === 'export') {
    if (!apply) log(`would set export=true in ${path.join(L.historyHome, 'config.json')}`);
    else log(`wrote\t${(await writeConfig(L, { export: true })).file}`);
    return;
  }
  if (what === 'mirror') {
    for (const [cmd, args] of mirrorCommands(L)) {
      if (!apply) log(`would run\t${cmd} ${args.map(shellQuote).join(' ')}`);
      else {
        await mkdir(args.at(-1), { recursive: true, mode: 0o700 });
        await run(cmd, args);
        log(`ran\t${cmd} ${args.at(-2)}`);
      }
    }
    return;
  }
  if (what === 'database') return setupDatabase(L, { apply, url, rolesOnly, node, log });
  throw new Error(`unknown setup target: ${what}`);
}

async function setupDatabase(L, { apply, url, rolesOnly, node, log }) {
  const target = new URL(normalizeUrl(url));
  const database = target.pathname.replace(/^\//, '');
  const admin = new URL(target);
  admin.pathname = '/postgres';
  const roleSql = readerRoleSql({ database }).slice(0, rolesOnly ? 2 : undefined);
  if (!apply) {
    if (!rolesOnly) log(`would run\tCREATE DATABASE "${database}" (if missing), then migrations`);
    for (const sql of roleSql) log(`would run\t${sql}`);
    if (!rolesOnly) log(`would write\t${path.join(L.historyHome, 'config.json')} (node, bin, url)`);
    return;
  }
  const adminDb = openDb(admin.toString());
  try {
    if (!rolesOnly && !(await adminDb('pg_database').where({ datname: database }).first())) {
      await adminDb.raw('CREATE DATABASE ?? TEMPLATE template0', [database]);
      log(`created database\t${database}`);
    }
  } finally {
    await adminDb.destroy();
  }
  if (!rolesOnly) log(`migrations applied\t${(await migrateWithLock(target.toString())).length}`);
  const db = openDb(rolesOnly ? admin.toString() : target.toString());
  try {
    const { rows } = await db.raw('SELECT current_user AS u');
    for (const sql of readerRoleSql({ database, owner: rows[0].u }).slice(0, rolesOnly ? 2 : undefined)) await db.raw(sql);
    log(`reader role\tready`);
  } finally {
    await db.destroy();
  }
  if (!rolesOnly) {
    await writeConfig(L, runtimeConfig(L, { node, url: target.toString() }));
    log(`wrote\t${path.join(L.historyHome, 'config.json')}`);
  }
}

export async function snapshotAgentConfig({ home, env = process.env, now = new Date(), log = console.log } = {}) {
  const L = layout({ home, env });
  const root = path.join(L.historyHome, 'config-backups');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(L.historyHome, 0o700).catch(() => {});
  await chmod(root, 0o700);
  let dir;
  for (let n = 0; ; n++) {
    dir = path.join(root, `${stamp(now)}${n ? `-${n}` : ''}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  const targets = [
    ['claude-settings.json', L.claudeSettings],
    ['codex-hooks.json', L.codexHooks],
    ['CLAUDE.md', L.claudeMd],
    ['AGENTS.md', L.agentsMd],
    [`${SCAN_LABEL}.plist`, path.join(L.launchAgents, `${SCAN_LABEL}.plist`)],
    [`${BACKUP_LABEL}.plist`, path.join(L.launchAgents, `${BACKUP_LABEL}.plist`)],
  ];
  const manifest = [];
  for (const [name, original] of targets) {
    if ((await readText(original)) === null) {
      manifest.push({ copy: null, original, absent: true });
      log(`absent\t${original}`);
      continue;
    }
    const copy = path.join(dir, name);
    await copyFile(original, copy, constants.COPYFILE_EXCL);
    await chmod(copy, 0o600);
    manifest.push({ copy, original });
    log(`saved\t${original}`);
  }
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  log(`snapshot\t${dir}`);
  for (const { copy, original, absent } of manifest) {
    if (absent) log(`did not exist: if setup created it later, review it, then remove with: rm ${shellQuote(original)}`);
    else log(`restore with: cp ${shellQuote(copy)} ${shellQuote(original)}`);
  }
  return { dir, manifest };
}
