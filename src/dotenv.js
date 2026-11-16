import { fileURLToPath } from 'node:url';

export const DOTENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

export function loadDotenv(env = process.env) {
  if (env.AGENT_HISTORY_DOTENV === '0') return null;
  const file = env.AGENT_HISTORY_DOTENV_FILE || DOTENV_FILE;
  try {
    process.loadEnvFile(file);
    return file;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
