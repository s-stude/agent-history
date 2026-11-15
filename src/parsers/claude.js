import { createHash } from 'node:crypto';
import path from 'node:path';
import { recordId } from '../inventory.js';
import { bounded, redactText, sanitize, sanitizeLine } from '../redact.js';
import { cleanBounded, cleanText, safeDate } from './common.js';

export const PARSER_VERSION = 1;
export const TOOL_TEXT_LIMIT = 500;
export const RAW_LIMIT = 2048;

const NOISE_TYPES = new Set([
  'attachment', 'api-request', 'api-request-blob', 'api-request-shape', 'last-prompt', 'atis-latch', 'mode',
  'bridge-session', 'permission-mode', 'session-owner', 'queue-operation', 'file-history-snapshot',
  'file-history-delta', 'tools-used', 'cost-state', 'relocated', 'continued-in', 'fork-context-ref', 'summary',
  'frame-link', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
]);
const NOISE_SYSTEM = new Set([
  'turn_duration', 'stop_hook_summary', 'informational', 'bridge_status', 'model_refusal_no_fallback', 'local_command',
  'api_error', 'away_summary',
]);
const KEPT_SYSTEM = new Set(['compact_boundary', 'scheduled_task_fire']);
const SKIPPED_BLOCKS = new Set(['thinking', 'redacted_thinking']);
const FILE_KEYS = ['file_path', 'path', 'notebook_path', 'filePath'];

const TAG_KIND = {
  'task-notification': ['system', 'notification'],
  'command-name': ['user', 'command'],
  'command-message': ['user', 'command'],
  'bash-input': ['user', 'command'],
  'local-command-stdout': ['system', 'command_output'],
  'local-command-stderr': ['system', 'command_output'],
  'bash-stdout': ['system', 'command_output'],
  'bash-stderr': ['system', 'command_output'],
  'local-command-caveat': null,
  'system-reminder': null,
};

export function projectFromCwd(cwd) {
  if (!cwd) return null;
  const parts = cwd.split(path.sep).filter(Boolean);
  for (const marker of ['.claude', '.worktrees', 'worktrees']) {
    const i = parts.lastIndexOf(marker);
    if (i > 0 && (marker !== '.claude' || parts[i + 1] === 'worktrees')) return parts[i - 1];
  }
  return parts.at(-1) || null;
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

function filesFromInput(input) {
  if (!input || typeof input !== 'object') return [];
  const out = [];
  for (const key of FILE_KEYS) if (typeof input[key] === 'string') out.push(input[key]);
  if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === 'string') out.push(p);
  return out.map(redactText);
}

function userText(kind, text) {
  return kind === 'command_output' ? cleanBounded(text, TOOL_TEXT_LIMIT) : cleanText(text);
}

function classifyUserString(text) {
  const tag = /^\s*<([a-z-]+)[\s>]/.exec(text)?.[1];
  if (tag && tag in TAG_KIND) return TAG_KIND[tag];
  return ['user', 'prompt'];
}

export function createClaudeParser(source) {
  const toolNames = new Map();
  const unknown = new Map();
  const skipped = new Map();
  const session = {
    id: source.sessionKey,
    tool: 'claude',
    native_id: source.nativeId,
    parent_id: source.parentKey,
    agent_id: source.agentId,
    workflow_id: source.workflowId,
    is_sidechain: Boolean(source.parentKey),
    project: null,
    cwd: null,
    started_at: null,
    ended_at: null,
    title: null,
    source_path: source.path,
    cli_version: null,
  };
  let aiTitle = null;
  let customTitle = null;
  let agentName = null;

  const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  function touch(r) {
    if (r.cwd && !session.cwd) {
      session.cwd = redactText(r.cwd);
      session.project = redactText(projectFromCwd(r.cwd));
    }
    if (r.version && !session.cli_version) session.cli_version = String(r.version);
    const ts = safeDate(r.timestamp);
    if (ts) {
      if (!session.started_at || ts < session.started_at) session.started_at = ts;
      if (!session.ended_at || ts > session.ended_at) session.ended_at = ts;
    }
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
    const type = r.type;
    if (type === 'ai-title') {
      if (typeof r.aiTitle === 'string') aiTitle = r.aiTitle;
      return [];
    }
    if (type === 'custom-title') {
      if (typeof r.customTitle === 'string') customTitle = r.customTitle;
      return [];
    }
    if (type === 'agent-name') {
      if (typeof r.agentName === 'string') agentName = r.agentName;
      return [];
    }
    if (NOISE_TYPES.has(type)) {
      count(skipped, type);
      return [];
    }
    if (type === 'system' && NOISE_SYSTEM.has(r.subtype)) {
      count(skipped, `system/${r.subtype}`);
      return [];
    }
    if (type !== 'user' && type !== 'assistant' && !(type === 'system' && KEPT_SYSTEM.has(r.subtype))) {
      count(unknown, type === 'system' ? `system/${r.subtype}` : String(type));
      return [];
    }
    touch(r);
    const base = {
      session_id: session.id,
      record_id: recordId(source, r.uuid, lineNo),
      ts: safeDate(r.timestamp, () => count(unknown, 'invalid-timestamp')),
      phase: null,
      turn_id: null,
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

    if (type === 'system') {
      push(0, { role: 'system', kind: r.subtype, text: cleanText(String(r.content ?? r.prompt ?? '')) });
    } else if (type === 'user') {
      const content = r.message?.content;
      if (r.isCompactSummary) {
        push(0, { role: 'user', kind: 'summary', text: cleanText(blockText(content)) });
      } else if (r.isMeta) {
        count(skipped, 'user/meta');
      } else if (typeof content === 'string') {
        const kind = classifyUserString(content);
        if (!kind) count(skipped, 'user/injected');
        else {
          push(0, { role: kind[0], kind: kind[1], text: userText(kind[1], content) });
        }
      } else if (Array.isArray(content)) {
        content.forEach((block, i) => {
          if (block?.type === 'tool_result') {
            push(i, {
              role: 'tool',
              kind: 'tool_result',
              tool_name: toolNames.get(block.tool_use_id) ?? null,
              call_id: block.tool_use_id ?? null,
              text: bounded(blockText(sanitize(block.content)), TOOL_TEXT_LIMIT),
            });
          } else if (block?.type === 'text') {
            const kind = classifyUserString(block.text ?? '');
            if (kind) push(i, { role: kind[0], kind: kind[1], text: userText(kind[1], block.text ?? '') });
            else count(skipped, 'user/injected');
          } else if (block?.type === 'image' || block?.type === 'document') {
            push(i, { role: 'user', kind: block.type, text: `[${block.type}]` });
          } else {
            count(unknown, `user/block:${block?.type}`);
          }
        });
      }
    } else {
      const content = r.message?.content;
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
      blocks.forEach((block, i) => {
        if (block?.type === 'text') {
          push(i, { role: 'assistant', kind: 'text', text: cleanText(block.text ?? '') });
        } else if (block?.type === 'tool_use') {
          if (block.id) toolNames.set(block.id, block.name);
          push(i, {
            role: 'assistant',
            kind: 'tool_use',
            tool_name: block.name ?? null,
            call_id: block.id ?? null,
            files: filesFromInput(block.input),
            text: bounded(JSON.stringify(sanitize(block.input ?? {})), TOOL_TEXT_LIMIT),
          });
        } else if (SKIPPED_BLOCKS.has(block?.type)) {
          count(skipped, `assistant/${block.type}`);
        } else {
          count(unknown, `assistant/block:${block?.type}`);
        }
      });
    }
    if (rows.length) rows[0].raw = bounded(sanitizeLine(line), RAW_LIMIT);
    return rows;
  }

  function finish() {
    const title = customTitle ?? aiTitle ?? agentName;
    session.title = title ? cleanText(title) : null;
    return session;
  }

  return { parseLine, finish, unknown, skipped };
}
