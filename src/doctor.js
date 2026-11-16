import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import { parserVersion, prefixFingerprint } from './ingest.js';
import path from 'node:path';
import { buildInventory, rootsFromEnv } from './inventory.js';
import { schemaStatus } from './schema.js';
import { READER_ROLE } from './roles.js';
import { historyHome } from './paths.js';

export const PROVISIONAL_MAX_AGE_MIN = 10;
export const BACKUP_MAX_AGE_DAYS = 8;
export const CATCH_UP_GRACE_MIN = 20;

const FIRST_LINE_LIMIT = 4 * 1024 * 1024;

export async function firstPendingLine(file, offset) {
  const fh = await open(file, 'r');
  try {
    const chunks = [];
    let size = 0;
    const buf = Buffer.alloc(1 << 16);
    let pos = offset;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) return null;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (nl !== -1) {
        if (size < FIRST_LINE_LIMIT) chunks.push(Buffer.from(buf.subarray(0, nl)));
        return Buffer.concat(chunks).toString('utf8');
      }
      if (size < FIRST_LINE_LIMIT) chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      size += bytesRead;
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
}

export function lineTime(line) {
  const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line.slice(0, 4096));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isNaN(t) ? null : t;
}

async function sourceProblems(db, inv, now = new Date()) {
  const rows = new Map(
    (await db('sources').select('path', 'status', 'byte_offset', 'inode', 'size', 'prefix_fingerprint', 'parser_version', 'updated_at')).map((r) => [r.path, r]),
  );
  const out = { missing: [], partial: [], stale: [], catching_up: [] };
  const graceStart = now.getTime() - CATCH_UP_GRACE_MIN * 60_000;
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
    if (row.parser_version !== parserVersion(s.tool)) {
      out.stale.push(s);
    } else if (s.immutable) {
      if (row.status !== 'done') out.partial.push(s);
      else if (String(row.size) !== String(info.size) || String(row.inode) !== String(info.ino)) out.stale.push(s);
    } else if (
      String(row.inode) !== String(info.ino) ||
      info.size < Number(row.byte_offset) ||
      (await prefixFingerprint(s.path, Number(row.byte_offset))) !== row.prefix_fingerprint
    ) {
      out.stale.push(s);
    } else if (info.size > Number(row.byte_offset)) {
      const pending = await firstPendingLine(s.path, Number(row.byte_offset));
      if (pending !== null) {
        const since = lineTime(pending) ?? new Date(row.updated_at).getTime();
        if (since >= graceStart) out.catching_up.push(s);
        else out.partial.push(s);
      }
    }
  }
  return out;
}

async function modeProblems(home) {
  const bad = [];
  const walk = async (p) => {
    let st;
    try {
      st = await lstat(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      bad.push(`${p} symlink`);
      return;
    }
    const want = st.isDirectory() ? 0o700 : 0o600;
    if ((st.mode & 0o777) !== want) bad.push(`${p} ${(st.mode & 0o777).toString(8)}`);
    if (st.isDirectory()) for (const name of await readdir(p)) await walk(path.join(p, name));
  };
  await walk(home);
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

export async function roleStatus(db, role = READER_ROLE) {
  const r = await db('pg_roles').where({ rolname: role }).first();
  if (!r) return 'missing';
  if (r.rolsuper || r.rolcreaterole || r.rolbypassrls) return 'can-write';
  const { rows } = await db.raw(
    `SELECT bool_or(
              has_table_privilege(:role, c.oid, 'INSERT') OR has_table_privilege(:role, c.oid, 'UPDATE')
              OR has_table_privilege(:role, c.oid, 'DELETE') OR has_table_privilege(:role, c.oid, 'TRUNCATE')
              OR has_table_privilege(:role, c.oid, 'TRIGGER') OR pg_has_role(:role, c.relowner, 'USAGE')
            ) AS table_write,
            has_schema_privilege(:role, 'public', 'CREATE') AS schema_create
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    { role },
  );
  return rows[0].table_write || rows[0].schema_create ? 'can-write' : 'ok';
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
  let group = 'server';
  const add = (level, check, detail) => checks.push({ level, check, detail: String(detail), group });
  const home = historyHome(env);

  const { rows } = await db.raw("SELECT current_setting('server_version') AS v, current_database() AS d, pg_database_size(current_database()) AS size");
  add('info', 'server', rows[0].v);
  add('info', 'database', rows[0].d);
  add('info', 'db_size_mb', Math.round(Number(rows[0].size) / 2 ** 20));

  group = 'schema';
  const schema = await schemaStatus(db);
  add(schema.state === 'current' ? 'ok' : 'fail', 'schema', `${schema.state} (${schema.applied.length} applied, ${schema.pending.length} pending, ${schema.unknown.length} unknown)`);
  if (schema.state !== 'current') return finish(checks);

  const inv = await buildInventory(roots);
  const problems = await sourceProblems(db, inv, now);
  for (const tool of ['claude', 'codex']) {
    group = tool;
    for (const kind of ['missing', 'partial', 'stale']) {
      const list = problems[kind].filter((s) => s.tool === tool);
      add(list.length ? 'fail' : 'ok', `${tool}_${kind}`, list.length ? `${list.length}: ${list.slice(0, 3).map((s) => path.basename(s.path)).join(', ')}` : 0);
    }
    const recent = problems.catching_up.filter((s) => s.tool === tool);
    if (recent.length) {
      add('warn', `${tool}_catching_up`, `${recent.length} written in the last ${CATCH_UP_GRACE_MIN} min, not yet fully ingested: ${recent.slice(0, 3).map((s) => path.basename(s.path)).join(', ')}`);
    }
  }
  group = 'inventory';
  add(inv.unsupported.length ? 'fail' : 'ok', 'unsupported', inv.unsupported.length);
  add(inv.unreadable.length ? 'fail' : 'ok', 'unreadable', inv.unreadable.length);

  const [{ n: unresolved }] = await db('ingest_errors').whereNull('resolved_at').count({ n: '*' });
  const [{ n: resolved }] = await db('ingest_errors').whereNotNull('resolved_at').count({ n: '*' });
  group = 'errors';
  add(Number(unresolved) ? 'fail' : 'ok', 'unresolved_errors', unresolved);
  add('info', 'recovered_errors', resolved);

  const cutoff = new Date(now.getTime() - PROVISIONAL_MAX_AGE_MIN * 60_000);
  const [{ n: oldProvisional }] = await db('messages').where('provisional', true).where('ts', '<', cutoff).count({ n: '*' });
  add(Number(oldProvisional) ? 'fail' : 'ok', 'stale_provisional', oldProvisional);

  const unknown = await db('unknown_types').select('tool', 'type', 'subtype', 'count').orderBy('count', 'desc').limit(5);
  add('info', 'unknown_types', unknown.map((u) => `${u.tool}:${u.type}${u.subtype ? '/' + u.subtype : ''}=${u.count}`).join(', ') || 0);

  const [{ last }] = await db('sources').max({ last: 'updated_at' });
  group = 'activity';
  add('info', 'last_ingest', last ? last.toISOString() : 'never');
  const newerLog = await logAfter(home, last);
  add(newerLog ? 'warn' : 'ok', 'log_after_last_ingest', newerLog);

  const modes = await modeProblems(home);
  group = 'local';
  add(modes.length ? 'fail' : 'ok', 'file_modes', modes.length ? modes.join('; ') : 'ok');

  const reader = await roleStatus(db);
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

export function formatChecks(checks) {
  const lines = [];
  checks.forEach((c, i) => {
    if (i > 0 && c.group !== checks[i - 1].group) lines.push('');
    lines.push(`${c.level}\t${c.check}\t${c.detail}`);
  });
  return lines.join('\n');
}
