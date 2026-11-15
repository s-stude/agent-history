import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createTestDb } from '../test/helpers/db.js';
import { REPO } from '../test/helpers/tmp.js';

const bin = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const h = await createTestDb({ label: 'check' });
await mkdir(path.join(REPO, 'tmp'), { recursive: true });
const dir = await mkdtemp(path.join(REPO, 'tmp', 'check-'));
const roots = Object.fromEntries(
  ['AGENT_HISTORY_CLAUDE_PROJECTS', 'AGENT_HISTORY_CODEX_SESSIONS', 'AGENT_HISTORY_CODEX_ARCHIVED'].map((k) => [k, path.join(dir, k)]),
);
try {
  execFileSync(process.execPath, [bin, 'doctor'], {
    stdio: 'inherit',
    env: { ...process.env, ...roots, AGENT_HISTORY_HOME: path.join(dir, 'home'), AGENT_HISTORY_DATABASE_URL: h.url },
  });
} catch (err) {
  process.exitCode = err.status ?? 1;
} finally {
  await h.drop();
  await rm(dir, { recursive: true, force: true });
}
