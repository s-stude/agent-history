import { homedir } from 'node:os';
import path from 'node:path';

export function historyHome(env = process.env) {
  return env.AGENT_HISTORY_HOME || path.join(homedir(), '.agent-history');
}
