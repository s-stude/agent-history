import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { openSource } from './inventory.js';
import { createClaudeParser, PARSER_VERSION as CLAUDE_VERSION } from './parsers/claude.js';
import { createCodexParser, PARSER_VERSION as CODEX_VERSION } from './parsers/codex.js';

export const BATCH_LINES = 500;
export const BATCH_BYTES = 16 * 1024 * 1024;
export const FINGERPRINT_WINDOW = 4096;
const READ_CHUNK = 1 << 16;
const MAX_ATTEMPTS = 4;
const MAX_STALE_RETRIES = 50;
const RETRYABLE_PG = new Set(['40001', '40P01', '55P03']);

export class StaleCheckpointError extends Error {
  name = 'StaleCheckpointError';
}

export function parserVersion(tool) {
  return PARSERS[tool].version;
}

const PARSERS = {
  claude: { create: createClaudeParser, version: CLAUDE_VERSION },
  codex: { create: createCodexParser, version: CODEX_VERSION },
};

async function hashRange(fh, start, end) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(Math.max(0, end - start));
  if (buf.length) await fh.read(buf, 0, buf.length, start);
  return hash.update(buf).digest('hex');
}

export async function prefixFingerprint(path, offset) {
  const fh = await open(path, 'r');
  try {
    const head = await hashRange(fh, 0, Math.min(offset, FINGERPRINT_WINDOW));
    const tail = await hashRange(fh, Math.max(0, offset - FINGERPRINT_WINDOW), offset);
    return `${head}:${tail}`;
  } finally {
    await fh.close();
  }
}

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class FileChangedError extends Error {
  name = 'FileChangedError';
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function openPlainReader(path, startOffset, startLine, expectedFingerprint) {
  const fh = await open(path, 'r');
  const readAt = async (start, end) => {
    const buf = Buffer.alloc(Math.max(0, end - start));
    if (buf.length) await fh.read(buf, 0, buf.length, start);
    return buf;
  };
  let head = await readAt(0, Math.min(startOffset, FINGERPRINT_WINDOW));
  let tail = await readAt(Math.max(0, startOffset - FINGERPRINT_WINDOW), startOffset);
  const fingerprint = () => `${sha(head)}:${sha(tail)}`;
  if (startOffset > 0 && fingerprint() !== expectedFingerprint) {
    await fh.close();
    throw new FileChangedError(path);
  }
  const consume = (bytes) => {
    if (head.length < FINGERPRINT_WINDOW) head = Buffer.concat([head, bytes.subarray(0, FINGERPRINT_WINDOW - head.length)]);
    if (bytes.length >= FINGERPRINT_WINDOW) {
      tail = Buffer.from(bytes.subarray(bytes.length - FINGERPRINT_WINDOW));
    } else {
      const keep = tail.subarray(Math.max(0, tail.length - (FINGERPRINT_WINDOW - bytes.length)));
      tail = Buffer.concat([keep, bytes]);
    }
  };
  async function* lines() {
    try {
      let pos = startOffset;
      let lineNo = startLine;
      let pending = [];
      let pendingBytes = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(READ_CHUNK);
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
        if (!bytesRead) return;
        const piece = chunk.subarray(0, bytesRead);
        if (piece.indexOf(0x0a) === -1) {
          pending.push(piece);
          pendingBytes += bytesRead;
          pos += bytesRead;
          continue;
        }
        const data = pendingBytes ? Buffer.concat([...pending, piece], pendingBytes + bytesRead) : piece;
        const base = pos - pendingBytes;
        pos += bytesRead;
        pending = [];
        pendingBytes = 0;
        let lineStart = 0;
        let nl = data.indexOf(0x0a, 0);
        while (nl !== -1) {
          lineNo++;
          consume(data.subarray(lineStart, nl + 1));
          yield { line: data.toString('utf8', lineStart, nl), lineNo, endOffset: base + nl + 1 };
          lineStart = nl + 1;
          nl = data.indexOf(0x0a, lineStart);
        }
        if (lineStart < data.length) {
          const rest = Buffer.from(data.subarray(lineStart));
          pending.push(rest);
          pendingBytes = rest.length;
        }
      }
    } finally {
      await fh.close();
    }
  }
  return { lines: lines(), fingerprint };
}

async function* streamLines(source, skip) {
  let lineNo = 0;
  for await (const line of createInterface({ input: openSource(source), crlfDelay: Infinity })) {
    lineNo++;
    if (lineNo <= skip) continue;
    yield { line, lineNo, endOffset: null };
  }
}

function countDelta(current, flushed) {
  const out = [];
  for (const [key, n] of current) {
    const d = n - (flushed.get(key) || 0);
    if (d > 0) out.push([key, d]);
    flushed.set(key, n);
  }
  return out;
}

function sessionRow(session) {
  return { ...session, updated_at: new Date() };
}

async function upsertSession(trx, session) {
  await trx('sessions')
    .insert(sessionRow(session))
    .onConflict('id')
    .merge({
      started_at: trx.raw('LEAST(sessions.started_at, excluded.started_at)'),
      ended_at: trx.raw('GREATEST(sessions.ended_at, excluded.ended_at)'),
      title: trx.raw('COALESCE(excluded.title, sessions.title)'),
      project: trx.raw('COALESCE(sessions.project, excluded.project)'),
      cwd: trx.raw('COALESCE(sessions.cwd, excluded.cwd)'),
      cli_version: trx.raw('COALESCE(sessions.cli_version, excluded.cli_version)'),
      parent_id: trx.raw('COALESCE(excluded.parent_id, sessions.parent_id)'),
      agent_id: trx.raw('COALESCE(excluded.agent_id, sessions.agent_id)'),
      is_sidechain: trx.raw('sessions.is_sidechain OR excluded.is_sidechain'),
      source_path: trx.raw('excluded.source_path'),
      updated_at: trx.raw('excluded.updated_at'),
    });
}

const MESSAGE_COLUMNS = [
  'ts', 'role', 'phase', 'kind', 'turn_id', 'text', 'files', 'provisional', 'raw', 'source_path', 'source_line',
  'content_hash', 'parser_version', 'call_id',
];

async function upsertMessages(trx, rows) {
  if (!rows.length) return;
  const merge = Object.fromEntries(MESSAGE_COLUMNS.map((c) => [c, trx.raw('??', [`excluded.${c}`])]));
  merge.tool_name = trx.raw('COALESCE(excluded.tool_name, messages.tool_name)');
  for (let i = 0; i < rows.length; i += 1000) {
    await trx('messages')
      .insert(rows.slice(i, i + 1000))
      .onConflict(['session_id', 'record_id', 'block_ordinal'])
      .merge(merge);
  }
}

async function backfillToolNames(trx, sessionId) {
  await trx.raw(
    `UPDATE messages r SET tool_name = u.tool_name
       FROM messages u
      WHERE r.session_id = ? AND r.kind = 'tool_result' AND r.tool_name IS NULL AND r.call_id IS NOT NULL
        AND u.session_id = r.session_id AND u.call_id = r.call_id AND u.kind = 'tool_use' AND u.tool_name IS NOT NULL`,
    [sessionId],
  );
}

export async function resolveProvisional(trx, sessionId) {
  await trx.raw(
    `DELETE FROM messages p
      WHERE p.session_id = ? AND p.provisional
        AND (
          (p.turn_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM messages r
              WHERE r.session_id = p.session_id AND NOT r.provisional AND r.role = 'assistant' AND r.kind = 'text'
                AND r.turn_id = p.turn_id AND (r.phase = 'final_answer' OR r.phase IS NULL)))
          OR (p.turn_id IS NULL AND EXISTS (
             SELECT 1 FROM messages r
              WHERE r.session_id = p.session_id AND NOT r.provisional AND r.role = 'assistant' AND r.kind = 'text'
                AND r.text = p.text AND r.ts >= p.ts - interval '10 minutes'))
          OR EXISTS (
             SELECT 1 FROM messages q
              WHERE q.session_id = p.session_id AND NOT q.provisional AND q.kind = 'prompt' AND q.ts > p.ts)
        )`,
    [sessionId],
  );
}

async function flushCounts(trx, tool, deltas) {
  for (const [key, n] of deltas) {
    const [type, ...rest] = key.split('/');
    await trx('unknown_types')
      .insert({ tool, type, subtype: rest.join('/'), count: n })
      .onConflict(['tool', 'type', 'subtype'])
      .merge({ count: trx.raw('unknown_types.count + excluded.count') });
  }
}

async function readCheckpoint(db, path) {
  return db('sources').where({ path }).first();
}

async function deleteSourceRows(trx, path) {
  await trx('messages').where({ source_path: path, provisional: false }).del();
}

function lockSource(trx, path) {
  return trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [path]);
}

async function commitBatch(db, ctx, batch) {
  await db.transaction(async (trx) => {
    await lockSource(trx, ctx.source.path);
    const current = await trx('sources').where({ path: ctx.source.path }).first();
    const currentGen = current ? String(current.generation) : null;
    if (currentGen !== ctx.expectedGeneration) throw new StaleCheckpointError(ctx.source.path);
    if (ctx.reset && current) await deleteSourceRows(trx, ctx.source.path);
    await upsertSession(trx, batch.session);
    await upsertMessages(trx, batch.rows);
    await backfillToolNames(trx, batch.session.id);
    await resolveProvisional(trx, batch.session.id);
    await flushCounts(trx, ctx.source.tool, batch.unknown);
    const checkpoint = {
      session_id: batch.session.id,
      tool: ctx.source.tool,
      encoding: ctx.source.encoding,
      content_hash: ctx.contentHash,
      inode: ctx.inode,
      size: ctx.size,
      byte_offset: batch.endOffset,
      last_line: batch.lastLine,
      prefix_fingerprint: batch.fingerprint,
      status: batch.done ? 'done' : 'partial',
      parser_state: JSON.stringify(batch.state),
      parser_version: ctx.parserVersion,
      updated_at: new Date(),
    };
    if (current) {
      const n = await trx('sources')
        .where({ path: ctx.source.path, generation: currentGen })
        .update({ ...checkpoint, generation: trx.raw('generation + 1') });
      if (n !== 1) throw new StaleCheckpointError(ctx.source.path);
    } else {
      await trx('sources').insert({ path: ctx.source.path, ...checkpoint, generation: 1 });
    }
    if (batch.done) {
      await trx('ingest_errors').where({ source_path: ctx.source.path }).whereNull('resolved_at').update({ resolved_at: trx.fn.now() });
    }
    const [{ generation }] = await trx('sources').where({ path: ctx.source.path }).select('generation');
    ctx.expectedGeneration = String(generation);
    ctx.reset = false;
  });
}

async function planSource(db, source) {
  const info = await stat(source.path);
  const current = await readCheckpoint(db, source.path);
  const ctx = {
    source,
    inode: info.ino,
    size: info.size,
    expectedGeneration: current ? String(current.generation) : null,
    reset: false,
    contentHash: null,
    parserVersion: PARSERS[source.tool].version,
    startOffset: 0,
    startLine: 0,
    state: null,
    skip: false,
    expectedFingerprint: null,
    status: current?.status ?? null,
  };
  const stale = current && current.parser_version !== ctx.parserVersion;
  if (source.immutable) {
    ctx.contentHash = await fileHash(source.path);
    if (current && current.content_hash === ctx.contentHash && !stale) {
      if (current.status === 'done') ctx.skip = true;
      ctx.startLine = Number(current.last_line);
      ctx.state = current.parser_state;
    } else if (current) {
      ctx.reset = true;
    }
    return ctx;
  }
  if (current && !stale) {
    const offset = Number(current.byte_offset);
    const sameFile = String(current.inode) === String(info.ino) && info.size >= offset;
    const fp = sameFile ? await prefixFingerprint(source.path, offset) : null;
    if (sameFile && fp === current.prefix_fingerprint) {
      if (info.size === offset) ctx.skip = true;
      ctx.startOffset = offset;
      ctx.startLine = Number(current.last_line);
      ctx.state = current.parser_state;
      ctx.expectedFingerprint = current.prefix_fingerprint;
      return ctx;
    }
  }
  if (current) ctx.reset = true;
  return ctx;
}

async function ingestOnce(db, source, { batchLines = BATCH_LINES, batchBytes = BATCH_BYTES, onBatch, beforeCommit } = {}) {
  const ctx = await planSource(db, source);
  if (ctx.skip) return { skipped: true, lines: 0, rows: 0 };
  const parser = PARSERS[source.tool].create(source, ctx.state);
  const flushed = new Map();
  const reader = source.immutable ? null : await openPlainReader(source.path, ctx.startOffset, ctx.startLine, ctx.expectedFingerprint);
  const lines = reader ? reader.lines : streamLines(source, ctx.startLine);
  let rows = [];
  let count = 0;
  let bytes = 0;
  let total = { lines: 0, rows: 0 };
  let lastLine = ctx.startLine;
  let endOffset = ctx.startOffset;

  const flush = async (done) => {
    const fingerprint = reader ? reader.fingerprint() : null;
    const session = { ...parser.finish() };
    await beforeCommit?.({ lastLine, endOffset });
    await commitBatch(db, ctx, {
      session,
      rows: dedupeRows(rows),
      unknown: countDelta(parser.unknown, flushed),
      state: parser.snapshot(),
      endOffset: source.immutable ? 0 : endOffset,
      lastLine,
      fingerprint,
      done,
    });
    total.rows += rows.length;
    rows = [];
    count = 0;
    bytes = 0;
    await onBatch?.({ lastLine, endOffset });
  };

  for await (const { line, lineNo, endOffset: end } of lines) {
    if (line) {
      for (const r of parser.parseLine(line, lineNo)) {
        rows.push(r);
        bytes += (r.text?.length ?? 0) + (r.raw?.length ?? 0);
      }
    }
    lastLine = lineNo;
    if (end !== null) endOffset = end;
    count++;
    total.lines++;
    if (count >= batchLines || bytes >= batchBytes) await flush(false);
  }
  if (total.lines === 0 && !ctx.reset && ctx.expectedGeneration !== null && !source.immutable && ctx.status === 'done') {
    return { skipped: true, lines: 0, rows: 0 };
  }
  await flush(true);
  return { skipped: false, ...total };
}

function retryable(err) {
  return err instanceof StaleCheckpointError || err instanceof FileChangedError || RETRYABLE_PG.has(err.code);
}

export function dedupeRows(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.session_id}\u0000${r.record_id}\u0000${r.block_ordinal}`;
    byKey.delete(key);
    byKey.set(key, r);
  }
  return [...byKey.values()];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ingestSource(db, source, options = {}) {
  let stale = 0;
  let other = 0;
  for (;;) {
    try {
      return await ingestOnce(db, source, options);
    } catch (err) {
      if (err instanceof StaleCheckpointError || err instanceof FileChangedError) {
        if (++stale > MAX_STALE_RETRIES) throw err;
      } else if (!retryable(err) || ++other >= MAX_ATTEMPTS) {
        throw err;
      }
      await sleep(Math.random() * 20 * Math.min(stale + other, 10));
    }
  }
}

export async function recordError(db, { sourcePath = null, line = null, errorClass, detail = null }) {
  await db('ingest_errors').insert({ source_path: sourcePath, line, error_class: errorClass, detail });
}

export async function insertProvisional(db, { sessionId, tool, nativeId, text, turnId = null, ts = new Date() }) {
  await db.transaction(async (trx) => {
    await upsertSession(trx, {
      id: sessionId, tool, native_id: nativeId, parent_id: null, agent_id: null, workflow_id: null,
      is_sidechain: false, project: null, cwd: null, started_at: null, ended_at: null, title: null,
      source_path: null, cli_version: null,
    });
    const recordId = `provisional:${turnId ?? createHash('sha256').update(`${sessionId}\n${text}`).digest('hex').slice(0, 16)}`;
    await trx('messages')
      .insert({
        session_id: sessionId, record_id: recordId, block_ordinal: 0, ts, role: 'assistant', kind: 'text',
        turn_id: turnId, text, files: [], provisional: true, parser_version: 0,
      })
      .onConflict(['session_id', 'record_id', 'block_ordinal'])
      .ignore();
    await resolveProvisional(trx, sessionId);
  });
}
