import { appendFile, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { databaseUrl, openDb } from './db.js';
import { classifyClaude, classifyCodex, rootsFromEnv } from './inventory.js';
import { ingestSource, insertProvisional, recordError } from './ingest.js';
import { cleanText } from './parsers/common.js';
import { schemaStatus } from './schema.js';

export const MAX_STDIN = 16 * 1024 * 1024;
const UNREACHABLE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EPERM', 'ECONNRESET', '57P03', '3D000', '28000']);

export function historyHome(env = process.env) {
  return env.AGENT_HISTORY_HOME || path.join(homedir(), '.agent-history');
}

export async function logLine(fields, env = process.env) {
  const dir = historyHome(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const line = [new Date().toISOString(), ...fields.map((f) => String(f ?? '-').replace(/[\t\n]/g, ' '))].join('\t');
  await appendFile(path.join(dir, 'ingest.log'), `${line}\n`, { mode: 0o600 });
}

export async function readStdin(stream = process.stdin, limit = MAX_STDIN) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('hook input too large'), { code: 'EINPUTTOOLARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isUnder(file, root) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function sourceForPath(file, roots = rootsFromEnv()) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let real;
  try {
    real = await realpath(file);
  } catch {
    return null;
  }
  const realRoot = async (r) => realpath(r).catch(() => r);
  const claudeRoot = await realRoot(roots.claudeProjects);
  if (isUnder(real, claudeRoot)) {
    const s = classifyClaude(real, claudeRoot);
    return s ? { ...s, path: real } : null;
  }
  for (const [root, archived] of [[roots.codexSessions, false], [roots.codexArchived, true]]) {
    const rr = await realRoot(root);
    if (isUnder(real, rr)) return classifyCodex(real, archived);
  }
  return null;
}

function errorClass(err) {
  return err?.code || err?.name || 'Error';
}

export async function runHook(input, { env = process.env, roots = rootsFromEnv(env), url = databaseUrl(env) } = {}) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    await logLine(['-', '-', 'invalid-hook-json'], env);
    return { ok: false, reason: 'invalid-hook-json' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'invalid-hook-json' };
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const paths = [payload.transcript_path, payload.agent_transcript_path].filter((p) => typeof p === 'string');
  const sources = [];
  for (const p of paths) {
    const s = await sourceForPath(p, roots);
    if (s) sources.push(s);
    else await logLine(['-', sessionId, 'path-outside-roots'], env);
  }
  const db = openDb(url);
  try {
    const schema = await schemaStatus(db);
    if (schema.state !== 'current') {
      await logLine([sources[0]?.tool, sessionId, `schema-${schema.state}`], env);
      return { ok: false, reason: `schema-${schema.state}` };
    }
    for (const source of sources) {
      try {
        await ingestSource(db, source);
      } catch (err) {
        if (UNREACHABLE.has(err.code)) throw err;
        await recordError(db, { sourcePath: source.path, errorClass: errorClass(err) }).catch(() => {});
        await logLine([source.tool, sessionId, errorClass(err)], env);
      }
    }
    const answer = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : null;
    const target = sources.at(-1) ?? null;
    const tool = target?.tool ?? (payload.turn_id ? 'codex' : null);
    if (answer && tool && (target || sessionId)) {
      const sessionKey = target?.sessionKey ?? `${tool}:${sessionId}`;
      await insertProvisional(db, {
        sessionId: sessionKey,
        tool,
        nativeId: target?.nativeId ?? sessionId,
        text: cleanText(answer),
        turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
      });
    }
    return { ok: true, sources: sources.length };
  } catch (err) {
    await logLine([sources[0]?.tool, sessionId, errorClass(err)], env).catch(() => {});
    return { ok: false, reason: errorClass(err) };
  } finally {
    await db.destroy().catch(() => {});
  }
}
