// Live capture check in a real interactive session (one-shot runs cancel async hooks at exit).
// Usage: node scripts/capture-check.js claude|codex
// It starts the agent with a prompt asking for a random word, waits for that answer to appear in the transcript,
// then requires a final, non-provisional DB row for that exact session within 60 s of the answer.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { answerTime, claudeTranscript, codexRollout, findFinalRow, readerQuery, waitForCapture } from '../src/capture.js';
import { rootsFromEnv } from '../src/inventory.js';
import { loadDotenv } from '../src/dotenv.js';

loadDotenv();

const tool = process.argv[2];
if (!['claude', 'codex'].includes(tool)) {
  console.error('usage: node scripts/capture-check.js claude|codex');
  process.exit(2);
}
const word = `capture${randomBytes(4).toString('hex')}`;
const prompt = `Reply with exactly this one word and nothing else: ${word}`;
const roots = rootsFromEnv();
const uuid = randomUUID();
const started = Date.now();

async function sessionReady() {
  if (tool === 'claude') {
    const file = await claudeTranscript(roots.claudeProjects, uuid);
    const at = file && answerTime(await readFile(file, 'utf8'), word, 'claude');
    return at ? { sessionId: `claude:${uuid}`, answeredAt: at } : null;
  }
  const found = await codexRollout(roots.codexSessions, word, started - 1000);
  const at = found && answerTime(await readFile(found.file, 'utf8'), word, 'codex');
  return at && found.thread ? { sessionId: `codex:${found.thread}`, answeredAt: at } : null;
}

const { db, close } = readerQuery();
const args = tool === 'claude' ? ['--session-id', uuid, prompt] : [prompt];
console.log(`Starting ${tool}. Let it answer, then exit the session normally. Word: ${word}`);
const child = spawn(tool, args, { stdio: 'inherit' });
const result = waitForCapture({ sessionReady, query: (sessionId) => findFinalRow(db, { sessionId, word }) });
await new Promise((r) => child.on('close', r));
const r = await result;
await close();
console.log(r.ok ? `PASS: ${r.sessionId} captured ${r.seconds} s after the answer` : `FAIL: ${r.sessionId ?? '-'}: ${r.reason}`);
process.exitCode = r.ok ? 0 : 1;
