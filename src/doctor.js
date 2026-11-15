import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { buildInventory, rootsFromEnv } from './inventory.js';
import { schemaStatus } from './schema.js';
import { READER_ROLE } from './roles.js';
import { historyHome } from './paths.js';

export const PROVISIONAL_MAX_AGE_MIN = 10;
export const BACKUP_MAX_AGE_DAYS = 8;

async function hasCompleteLineAfter(file, offset) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    let pos = offset;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) return false;
      if (buf.subarray(0, bytesRead).includes(0x0a)) return true;
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

async function sourceProblems(db, inv) {
  const rows = new Map((await db('sources').select('path', 'status', 'byte_offset', 'inode', 'size')).map((r) => [r.path, r]));
  const out = { missing: [], partial: [], stale: [] };
  for (const s of inv.sources) {
    const row = rows.get(s.path);
    if (!row) {
      out.missing.push(s);
      continue;
    }
    let info;
    try {
      info = await stat(s.path);
    } catch {
      continue;
    }
    if (s.immutable) {
      if (row.status !== 'done') out.partial.push(s);
      else if (String(row.size) !== String(info.size) || String(row.inode) !== String(info.ino)) out.stale.push(s);
    } else if (String(row.inode) !== String(info.ino) || info.size < Number(row.byte_offset)) {
      out.stale.push(s);
    } else if (info.size > Number(row.byte_offset) && (await hasCompleteLineAfter(s.path, Number(row.byte_offset)))) {
      out.partial.push(s);
    }
  }
  return out;
}

async function modeProblems(home) {
  const bad = [];
  let info;
  try {
    info = await stat(home);
  } catch {
    return bad;
  }
  if ((info.mode & 0o777) !== 0o700) bad.push(`${home} ${(info.mode & 0o777).toString(8)}`);
  for (const name of await readdir(home)) {
    const p = path.join(home, name);
    const st = await stat(p);
    const want = st.isDirectory() ? 0o700 : 0o600;
    if ((st.mode & 0o777) !== want) bad.push(`${p} ${(st.mode & 0o777).toString(8)}`);
  }
  return bad;
}

async function logAfter(home, since) {
  try {
    const text = await readFile(path.join(home, 'ingest.log'), 'utf8');
    return text.split('\n').filter((l) => l && (!since || new Date(l.split('\t')[0]) > since)).length;
  } catch {
    return 0;
  }
}

async function readerStatus(db) {
  const role = await db('pg_roles').where({ rolname: READER_ROLE }).first();
  if (!role) return 'missing';
  const { rows } = await db.raw(
    `SELECT bool_or(has_table_privilege(?, c.oid, 'INSERT') OR has_table_privilege(?, c.oid, 'UPDATE') OR has_table_privilege(?, c.oid, 'DELETE')) AS can_write
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    [READER_ROLE, READER_ROLE, READER_ROLE],
  );
  return rows[0].can_write ? 'can-write' : 'ok';
}

async function readConfig(home) {
  try {
    return JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function newestBackup(home) {
  try {
    const names = (await readdir(path.join(home, 'backups'))).filter((n) => n.endsWith('.dump'));
    let newest = null;
    for (const n of names) {
      const { mtime } = await stat(path.join(home, 'backups', n));
      if (!newest || mtime > newest) newest = mtime;
    }
    return newest;
  } catch {
    return null;
  }
}

export async function doctor(db, { roots = rootsFromEnv(), env = process.env, now = new Date() } = {}) {
  const checks = [];
  const add = (level, check, detail) => checks.push({ level, check, detail: String(detail) });
  const home = historyHome(env);

  const { rows } = await db.raw("SELECT current_setting('server_version') AS v, current_database() AS d, pg_database_size(current_database()) AS size");
  add('info', 'server', rows[0].v);
  add('info', 'database', rows[0].d);
  add('info', 'db_size_mb', Math.round(Number(rows[0].size) / 2 ** 20));

  const schema = await schemaStatus(db);
  add(schema.state === 'current' ? 'ok' : 'fail', 'schema', `${schema.state} (${schema.applied.length} applied, ${schema.pending.length} pending, ${schema.unknown.length} unknown)`);
  if (schema.state !== 'current') return finish(checks);

  const inv = await buildInventory(roots);
  const problems = await sourceProblems(db, inv);
  for (const tool of ['claude', 'codex']) {
    for (const kind of ['missing', 'partial', 'stale']) {
      const list = problems[kind].filter((s) => s.tool === tool);
      add(list.length ? 'fail' : 'ok', `${tool}_${kind}`, list.length ? `${list.length}: ${list.slice(0, 3).map((s) => path.basename(s.path)).join(', ')}` : 0);
    }
  }
  add(inv.unsupported.length ? 'fail' : 'ok', 'unsupported', inv.unsupported.length);
  add(inv.unreadable.length ? 'fail' : 'ok', 'unreadable', inv.unreadable.length);

  const [{ n: unresolved }] = await db('ingest_errors').whereNull('resolved_at').count({ n: '*' });
  const [{ n: resolved }] = await db('ingest_errors').whereNotNull('resolved_at').count({ n: '*' });
  add(Number(unresolved) ? 'fail' : 'ok', 'unresolved_errors', unresolved);
  add('info', 'recovered_errors', resolved);

  const cutoff = new Date(now.getTime() - PROVISIONAL_MAX_AGE_MIN * 60_000);
  const [{ n: oldProvisional }] = await db('messages').where('provisional', true).where('ts', '<', cutoff).count({ n: '*' });
  add(Number(oldProvisional) ? 'fail' : 'ok', 'stale_provisional', oldProvisional);

  const unknown = await db('unknown_types').select('tool', 'type', 'subtype', 'count').orderBy('count', 'desc').limit(5);
  add('info', 'unknown_types', unknown.map((u) => `${u.tool}:${u.type}${u.subtype ? '/' + u.subtype : ''}=${u.count}`).join(', ') || 0);

  const [{ last }] = await db('sources').max({ last: 'updated_at' });
  add('info', 'last_ingest', last ? last.toISOString() : 'never');
  const newerLog = await logAfter(home, last);
  add(newerLog ? 'warn' : 'ok', 'log_after_last_ingest', newerLog);

  const modes = await modeProblems(home);
  add(modes.length ? 'fail' : 'ok', 'file_modes', modes.length ? modes.join('; ') : 'ok');

  const reader = await readerStatus(db);
  add(reader === 'can-write' ? 'fail' : reader === 'missing' ? 'warn' : 'ok', 'reader_role', reader);

  const config = await readConfig(home);
  if (config?.node && config.node !== process.execPath) add('warn', 'node_path', `recorded ${config.node}, running ${process.execPath}`);
  else add(config?.node ? 'ok' : 'info', 'node_path', config?.node ?? 'not recorded (setup not run)');

  const backup = await newestBackup(home);
  const stale = !backup || now - backup > BACKUP_MAX_AGE_DAYS * 86_400_000;
  add(stale ? 'warn' : 'ok', 'backup', backup ? backup.toISOString() : 'none');

  return finish(checks);
}

function finish(checks) {
  return { checks, failed: checks.some((c) => c.level === 'fail') };
}
