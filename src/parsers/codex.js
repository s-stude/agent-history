import { createHash } from 'node:crypto';
import { recordId } from '../inventory.js';
import { bounded, redactText, sanitize, sanitizeLine } from '../redact.js';
import { projectFromCwd } from './claude.js';
import { cleanBounded, cleanText, safeDate } from './common.js';

export const PARSER_VERSION = 1;
export const TOOL_TEXT_LIMIT = 500;
export const RAW_LIMIT = 2048;
export const TITLE_LIMIT = 120;

const RESPONSE_TYPES = new Set([
  'message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'reasoning',
  'compaction', 'additional_tools', 'tool_search_call', 'tool_search_output', 'agent_message', 'local_shell_call',
  'local_shell_call_output', 'web_search_call',
]);
const SKIPPED_RESPONSE = new Set(['reasoning', 'compaction', 'additional_tools', 'web_search_call']);
const NOISE_TYPES = new Set([
  'event_msg', 'token_usage_record', 'world_state', 'inter_agent_communication_metadata', 'state',
]);
const TRANSCRIPT_COPY = /^The following is the Codex agent history\b/;
const INJECTED_BLOCK = /^\s*(?:<[a-z_]+>|# AGENTS\.md|# Files\b)/;
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const FILE_KEYS = ['path', 'file_path', 'filePath'];

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n');
  }
  if (output && typeof output === 'object') {
    if (typeof output.content === 'string') return output.content;
    return JSON.stringify(output);
  }
  return '';
}

function parseArgs(args) {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function filesFrom(input) {
  const out = new Set();
  const text = typeof input === 'string' ? input : typeof input?.input === 'string' ? input.input : null;
  if (text) for (const m of text.matchAll(PATCH_FILE)) out.add(m[1].trim());
  if (input && typeof input === 'object') {
    for (const key of FILE_KEYS) if (typeof input[key] === 'string') out.add(input[key]);
  }
  return [...out].map(redactText);
}

export function createCodexParser(source) {
  const toolNames = new Map();
  const unknown = new Map();
  const skipped = new Map();
  const session = {
    id: source.sessionKey,
    tool: 'codex',
    native_id: source.nativeId,
    parent_id: null,
    agent_id: null,
    workflow_id: null,
    is_sidechain: false,
    project: null,
    cwd: null,
    started_at: null,
    ended_at: null,
    title: null,
    source_path: source.path,
    cli_version: null,
  };
  let ownId = source.nativeId;
  let historyStart = 0;
  let replaying = false;
  let turnId = null;
  let firstPrompt = null;

  const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  function touchTime(ts) {
    const d = safeDate(ts);
    if (!d) return;
    if (!session.started_at || d < session.started_at) session.started_at = d;
    if (!session.ended_at || d > session.ended_at) session.ended_at = d;
  }

  function applyMeta(meta, lineNo) {
    if (lineNo > 1 && meta.id && meta.id !== ownId) {
      if (lineNo < historyStart) replaying = true;
      return;
    }
    if (meta.id) ownId = meta.id;
    if (meta.cwd && !session.cwd) {
      session.cwd = redactText(meta.cwd);
      session.project = redactText(projectFromCwd(meta.cwd));
    }
    if (meta.cli_version && !session.cli_version) session.cli_version = String(meta.cli_version);
    const parent = meta.parent_thread_id ?? meta.forked_from_id ?? null;
    if (parent) session.parent_id = `codex:${parent}`;
    if (meta.parent_thread_id) {
      session.is_sidechain = true;
      const kind = meta.source?.subagent?.other;
      session.agent_id = redactText(String(meta.agent_nickname ?? (typeof kind === 'string' ? kind : null) ?? ownId));
    }
    if (Number.isInteger(meta.subagent_history_start_ordinal)) historyStart = meta.subagent_history_start_ordinal;
  }

  function parseLine(line, lineNo) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      count(unknown, 'invalid-json');
      return [];
    }
    if (!r || typeof r !== 'object') return [];

    let type = r.type;
    let p = r.payload;
    if (lineNo === 1 && !type && r.id) {
      type = 'session_meta';
      p = r;
    } else if (!p && RESPONSE_TYPES.has(type)) {
      p = r;
      type = 'response_item';
    } else if (!type && r.record_type) {
      type = r.record_type;
    }

    if (type === 'session_meta') {
      applyMeta(p ?? {}, lineNo);
      if (lineNo === 1) touchTime(r.timestamp);
      return [];
    }
    if (replaying && lineNo < historyStart) {
      count(skipped, 'replayed-parent-history');
      return [];
    }
    if (type === 'turn_context') {
      if (p?.turn_id) turnId = p.turn_id;
      if (p?.cwd && !session.cwd) {
        session.cwd = redactText(p.cwd);
        session.project = redactText(projectFromCwd(p.cwd));
      }
      return [];
    }
    if (type === 'event_msg') {
      if (p?.type === 'task_started' && p.turn_id) turnId = p.turn_id;
      touchTime(r.timestamp);
      count(skipped, `event_msg/${p?.type}`);
      return [];
    }
    if (NOISE_TYPES.has(type)) {
      count(skipped, type);
      return [];
    }

    touchTime(r.timestamp);
    const base = {
      session_id: session.id,
      record_id: recordId(source, null, lineNo),
      ts: safeDate(r.timestamp, () => count(unknown, 'invalid-timestamp')),
      phase: null,
      turn_id: turnId,
      tool_name: null,
      call_id: null,
      files: [],
      provisional: false,
      raw: null,
      source_path: source.path,
      source_line: lineNo,
      content_hash: createHash('sha256').update(line).digest('hex'),
      parser_version: PARSER_VERSION,
    };
    const rows = [];
    const push = (ordinal, fields) => rows.push({ ...base, block_ordinal: ordinal, ...fields });

    if (type === 'compacted') {
      const text = typeof p?.message === 'string' ? p.message : '';
      if (text) push(0, { role: 'system', kind: 'summary', text: cleanText(text) });
      else count(skipped, 'compacted');
    } else if (type === 'response_item') {
      const t = p?.type;
      if (t === 'message') {
        const blocks = Array.isArray(p.content) ? p.content : [];
        if (p.role === 'user' && TRANSCRIPT_COPY.test(blocks[0]?.text ?? '')) {
          count(skipped, 'user/transcript-copy');
        } else if (p.role === 'user') {
          blocks.forEach((b, i) => {
            if (b?.type === 'input_text') {
              if (INJECTED_BLOCK.test(b.text ?? '')) count(skipped, 'user/injected');
              else {
                const text = cleanText(b.text ?? '');
                if (!firstPrompt && text.trim()) firstPrompt = text;
                push(i, { role: 'user', kind: 'prompt', text });
              }
            } else if (b?.type === 'input_image') {
              push(i, { role: 'user', kind: 'image', text: '[image]' });
            } else {
              count(unknown, `message/user/${b?.type}`);
            }
          });
        } else if (p.role === 'assistant') {
          blocks.forEach((b, i) => {
            if (b?.type === 'output_text') {
              push(i, { role: 'assistant', kind: 'text', phase: p.phase ?? null, text: cleanText(b.text ?? '') });
            } else {
              count(unknown, `message/assistant/${b?.type}`);
            }
          });
        } else {
          count(skipped, `message/${p.role}`);
        }
      } else if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call' || t === 'tool_search_call') {
        const input = t === 'function_call' ? parseArgs(p.arguments) : t === 'custom_tool_call' ? p.input : p.action ?? p.arguments ?? p.query;
        const name = p.name ?? t;
        if (p.call_id) toolNames.set(p.call_id, name);
        push(0, {
          role: 'assistant',
          kind: 'tool_use',
          tool_name: name,
          call_id: p.call_id ?? null,
          files: filesFrom(input),
          text: typeof input === 'string' ? cleanBounded(input, TOOL_TEXT_LIMIT) : bounded(JSON.stringify(sanitize(input ?? {})), TOOL_TEXT_LIMIT),
        });
      } else if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'local_shell_call_output' || t === 'tool_search_output') {
        push(0, {
          role: 'tool',
          kind: 'tool_result',
          tool_name: toolNames.get(p.call_id) ?? null,
          call_id: p.call_id ?? null,
          text: bounded(outputText(sanitize(p.output ?? p.tools ?? '')), TOOL_TEXT_LIMIT),
        });
      } else if (t === 'agent_message') {
        push(0, { role: 'agent', kind: 'agent_message', text: cleanText(outputText(p.content ?? p.message ?? '')) });
      } else if (SKIPPED_RESPONSE.has(t)) {
        count(skipped, `response_item/${t}`);
      } else {
        count(unknown, `response_item/${t}`);
      }
    } else {
      count(unknown, String(type));
    }
    if (rows.length) rows[0].raw = bounded(sanitizeLine(line), RAW_LIMIT);
    return rows;
  }

  function finish() {
    if (firstPrompt) {
      const line = firstPrompt.trim().split('\n')[0];
      session.title = line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT)}…` : line;
      if (session.title.startsWith('[REDACTED')) session.title = null;
    }
    return session;
  }

  return { parseLine, finish, unknown, skipped };
}
