import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));

export async function tmpDir(t) {
  const base = path.join(REPO, 'tmp', 'test');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(base, 'run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export async function write(file, text = '{"type":"user"}\n') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

export async function writeZst(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, zstdCompressSync(Buffer.from(text)));
  return file;
}

export async function makeRoots(t) {
  const dir = await tmpDir(t);
  const roots = {
    claudeProjects: path.join(dir, 'claude/projects'),
    codexSessions: path.join(dir, 'codex/sessions'),
    codexArchived: path.join(dir, 'codex/archived_sessions'),
  };
  for (const p of Object.values(roots)) await mkdir(p, { recursive: true });
  const env = {
    AGENT_HISTORY_CLAUDE_PROJECTS: roots.claudeProjects,
    AGENT_HISTORY_CODEX_SESSIONS: roots.codexSessions,
    AGENT_HISTORY_CODEX_ARCHIVED: roots.codexArchived,
  };
  return { dir, roots, env };
}
