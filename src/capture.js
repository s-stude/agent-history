import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { databaseUrl, openDb } from './db.js';
import { readerUrl } from './pointer.js';

export const CAPTURE_MS = 60_000;
export const PREPARE_MS = 10 * 60_000;

export function captureReaderUrl(env = process.env) {
  return env.AGENT_HISTORY_READER_URL || readerUrl(databaseUrl(env));
}

export async function findFinalRow(db, { sessionId, word }) {
  return db('messages')
    .where({ session_id: sessionId, role: 'assistant', kind: 'text', provisional: false })
    .whereRaw("coalesce(phase, 'final_answer') = 'final_answer'")
    .whereRaw('btrim(text) = ?', [word])
    .first('session_id', 'ts');
}

export async function waitForCapture({ sessionReady, query, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), captureMs = CAPTURE_MS, prepareMs = PREPARE_MS, pollMs = 1000 }) {
  const started = now();
  let ready = null;
  while (!ready) {
    ready = await sessionReady();
    if (ready) break;
    if (now() - started > prepareMs) return { ok: false, reason: 'answer never appeared in a transcript' };
    await sleep(pollMs);
  }
  const t0 = ready.answeredAt ?? now();
  for (;;) {
    const row = await query(ready.sessionId);
    const elapsed = now() - t0;
    if (row && elapsed <= captureMs) return { ok: true, sessionId: ready.sessionId, seconds: Math.round(elapsed / 100) / 10 };
    if (elapsed > captureMs) return { ok: false, sessionId: ready.sessionId, reason: `not captured within ${captureMs / 1000} s of the answer` };
    await sleep(pollMs);
  }
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export function answerTime(text, word, tool) {
  for (const line of text.split('\n')) {
    if (!line.includes(word)) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (tool === 'claude' && r.type === 'assistant') {
      const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
      if (blocks.some((b) => b.type === 'text' && b.text?.trim() === word)) return new Date(r.timestamp).getTime();
    }
    if (tool === 'codex' && r.type === 'response_item' && r.payload?.role === 'assistant') {
      if ((r.payload.content ?? []).some((b) => b.type === 'output_text' && b.text?.trim() === word)) return new Date(r.timestamp).getTime();
    }
  }
  return null;
}

export async function claudeTranscript(projectsRoot, uuid) {
  let dirs = [];
  try {
    dirs = await readdir(projectsRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(projectsRoot, d, `${uuid}.jsonl`);
    if (await readIfExists(file)) return file;
  }
  return null;
}

export async function codexRollout(sessionsRoot, word, sinceMs) {
  const stack = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/^rollout-.*\.jsonl$/.test(e.name) && (await stat(p)).mtimeMs >= sinceMs) {
        const text = await readIfExists(p);
        if (text?.includes(word)) return { file: p, thread: /-([0-9a-f-]{36})\.jsonl$/.exec(e.name)?.[1] ?? null };
      }
    }
  }
  return null;
}

export function readerQuery(env = process.env) {
  const db = openDb(captureReaderUrl(env));
  return { db, close: () => db.destroy() };
}
