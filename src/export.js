import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { historyHome } from './paths.js';

const SAFE = /[^A-Za-z0-9._-]+/g;

export function exportPath(root, session) {
  const project = (session.project || 'unknown').replace(SAFE, '_');
  const date = session.started_at ? session.started_at.toISOString().slice(0, 10) : 'undated';
  const id = session.id.replace(SAFE, '_');
  return path.join(root, project, `${date}-${id}.md`);
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
  const q = db('sessions').select('*').orderBy('id');
  if (sessionIds) q.whereIn('id', sessionIds);
  const sessions = await q;
  const written = [];
  for (const s of sessions) {
    const messages = await db('messages')
      .where({ session_id: s.id })
      .select('role', 'kind', 'phase', 'text', 'tool_name', 'files', 'ts', 'provisional')
      .orderByRaw('ts NULLS FIRST, source_line, block_ordinal');
    const file = exportPath(root, s);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(file), 0o700);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, renderSession(s, messages), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
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
