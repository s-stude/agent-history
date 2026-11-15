import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestDb } from '../test/helpers/db.js';

const bin = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const h = await createTestDb({ label: 'check' });
try {
  execFileSync(process.execPath, [bin, 'doctor'], {
    stdio: 'inherit',
    env: { ...process.env, AGENT_HISTORY_DATABASE_URL: h.url },
  });
} catch (err) {
  process.exitCode = err.status ?? 1;
} finally {
  await h.drop();
}
