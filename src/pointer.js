import { normalizeUrl } from './db.js';
import { READER_ROLE } from './roles.js';

export const PSQL = '/Applications/Postgres 18.app/Contents/Versions/latest/bin/psql';
export const POINTER_START = '<!-- agent-history:pointer:start -->';
export const POINTER_END = '<!-- agent-history:pointer:end -->';

export function readerUrl(connectionString, role = READER_ROLE) {
  const url = new URL(normalizeUrl(connectionString));
  url.username = role;
  url.password = '';
  url.searchParams.delete('user');
  url.searchParams.delete('password');
  return url.toString();
}

export function pointerText({ url, psql = PSQL, exportDir = null }) {
  const reader = readerUrl(url);
  const run = `"${psql}" --dbname="${reader}" -X -c`;
  const lines = [
    POINTER_START,
    '## Past sessions',
    '',
    'Every Claude Code and Codex session is stored in PostgreSQL (read-only access below). Use it when asked about earlier work ("remember when…", retrospectives).',
    '',
    `- Connect: \`"${psql}" --dbname="${reader}"\``,
    '- Tables: `sessions` (id, tool, project, cwd, started_at, ended_at, title, parent_id) and `messages` (session_id, ts, role, kind, phase, text, tool_name, files).',
    '- Kinds: prompt, text (answers; Codex phase final_answer/commentary), tool_use, tool_result, summary, notification.',
    '- Filter by project and date first, then search text. Always show dates; when sessions disagree, the newer one wins.',
    '- Full-text search covers the first 100,000 characters of each message; for longer ones use `text ILIKE` with a project/date filter.',
    '',
    'Examples:',
    '',
    '```sh',
    `${run} "SELECT id, started_at, title FROM sessions WHERE project = 'demo' AND started_at >= now() - interval '30 days' ORDER BY started_at DESC LIMIT 20"`,
    `${run} "SELECT s.project, m.ts, ts_headline('simple', m.text, q) FROM messages m JOIN sessions s ON s.id = m.session_id, websearch_to_tsquery('simple', 'retry backoff') q WHERE m.text_tsv @@ q ORDER BY m.ts DESC LIMIT 10"`,
    `${run} "SELECT session_id, ts, left(text, 200) FROM messages WHERE text ILIKE '%src/net.js%' ORDER BY ts DESC LIMIT 10"`,
    `${run} "SELECT session_id, ts, tool_name FROM messages WHERE files @> ARRAY['src/net.js'] ORDER BY ts DESC LIMIT 10"`,
    '```',
  ];
  if (exportDir) lines.push('', `Markdown copies, one file per session: \`${exportDir}/<project>/<date>-<id>.md\` (grep-friendly).`);
  lines.push(POINTER_END, '');
  return lines.join('\n');
}
