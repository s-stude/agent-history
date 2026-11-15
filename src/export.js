import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { historyHome } from './paths.js';

const SAFE = /[^A-Za-z0-9._-]+/g;

function safeComponent(value, fallback) {
  const s = String(value || '').replace(SAFE, '_');
  return !s || /^\.+$/.test(s) ? fallback : s.replace(/^\./, '_');
}

export function exportPath(root, session) {
  const project = safeComponent(session.project, 'unknown');
  const date = session.started_at ? session.started_at.toISOString().slice(0, 10) : 'undated';
  const id = safeComponent(session.id, 'session');
  const file = path.resolve(root, project, `${date}-${id}.md`);
  const base = path.resolve(root);
  if (path.dirname(path.dirname(file)) !== base) throw new Error('export path escapes the export root');
  return file;
}

function fence(text) {
  const longest = Math.max(2, ...[...(text.matchAll(/`+/g))].map((m) => m[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

function when(ts) {
  return ts ? ts.toISOString().replace('T', ' ').slice(0, 19) : '';
}

export function renderSession(session, messages) {
  const head = [
    `# ${session.title || session.id}`,
    '',
    `- session: \`${session.id}\``,
    `- tool: ${session.tool}`,
    session.project ? `- project: ${session.project}` : null,
    session.cwd ? `- cwd: \`${session.cwd}\`` : null,
    session.parent_id ? `- parent: \`${session.parent_id}\`` : null,
    `- started: ${when(session.started_at)}`,
    `- ended: ${when(session.ended_at)}`,
    '',
  ].filter((l) => l !== null);
  const body = [];
  for (const m of messages) {
    const label = [m.role, m.kind, m.phase].filter(Boolean).join(' · ');
    if (m.kind === 'tool_use' || m.kind === 'tool_result') {
      const files = m.files?.length ? ` — ${m.files.map((f) => `\`${f}\``).join(', ')}` : '';
      body.push(`#### ${label} \`${m.tool_name ?? '?'}\` · ${when(m.ts)}${files}`, '', fence(m.text ?? ''), '');
    } else {
      body.push(`### ${label} · ${when(m.ts)}${m.provisional ? ' (provisional)' : ''}`, '', m.text ?? '', '');
    }
  }
  return `${[...head, ...body].join('\n')}\n`;
}

export async function exportSessions(db, { root, sessionIds = null } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const q = db('sessions').select('id').orderBy('id');
  if (sessionIds) q.whereIn('id', sessionIds);
  const sessions = await q;
  const written = [];
  for (const { id } of sessions) {
    const file = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`export:${id}`]);
      const s = await trx('sessions').where({ id }).first();
      const messages = await trx('messages')
        .where({ session_id: id })
        .select('role', 'kind', 'phase', 'text', 'tool_name', 'files', 'ts', 'provisional')
        .orderByRaw('ts NULLS FIRST, source_line, block_ordinal');
      const target = exportPath(root, s);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(target), 0o700);
      const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, renderSession(s, messages), { mode: 0o600, flag: 'wx' });
        await chmod(tmp, 0o600);
        await rename(tmp, target);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      return target;
    });
    written.push(file);
  }
  return written;
}

export async function exportEnabled(env = process.env) {
  try {
    const config = JSON.parse(await readFile(path.join(historyHome(env), 'config.json'), 'utf8'));
    return config.export === true;
  } catch {
    return false;
  }
}

export function exportRoot(env = process.env) {
  return path.join(historyHome(env), 'md');
}
