import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { opendir, stat as fsStat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createZstdDecompress } from 'node:zlib';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const CODEX_NAME = new RegExp(`^rollout-(?<ts>[0-9T:-]+)-(?<thread>${UUID})(?:_(?<page>${UUID}))?\\.jsonl(?<zst>\\.zst)?$`);
const CLAUDE_MAIN = new RegExp(`^(?<sid>${UUID})\\.jsonl$`);
const CLAUDE_AGENT = /^agent-(?<aid>[0-9a-zA-Z_-]+)\.jsonl$/;
const CLAUDE_METADATA = /^(?:sessions-index\.json|agent-[0-9a-zA-Z_-]+\.meta\.json)$/;
const CLAUDE_UUID_PREFIX = new RegExp(`^${UUID}(?:\\.|$)`);

export function rootsFromEnv(env = process.env, home = homedir()) {
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return {
    claudeProjects: env.AGENT_HISTORY_CLAUDE_PROJECTS || path.join(claude, 'projects'),
    codexSessions: env.AGENT_HISTORY_CODEX_SESSIONS || path.join(codex, 'sessions'),
    codexArchived: env.AGENT_HISTORY_CODEX_ARCHIVED || path.join(codex, 'archived_sessions'),
  };
}

export function claudeSessionKey(sessionId, agentId = null) {
  return agentId ? `claude:${sessionId}/agent:${agentId}` : `claude:${sessionId}`;
}

export function codexSessionKey(threadId) {
  return `codex:${threadId}`;
}

function makeSource(fields) {
  return {
    parentKey: null,
    agentId: null,
    workflowId: null,
    ...fields,
    immutable: fields.encoding === 'zst' || fields.archived,
  };
}

export function classifyClaude(file, root) {
  const rel = path.relative(root, file).split(path.sep);
  const main = rel.length === 2 && CLAUDE_MAIN.exec(rel[1]);
  if (main) {
    const sid = main.groups.sid;
    return makeSource({
      tool: 'claude', path: file, encoding: 'plain', archived: false,
      segment: sid, sessionKey: claudeSessionKey(sid), nativeId: sid,
    });
  }
  const agent = CLAUDE_AGENT.exec(rel.at(-1));
  if (!agent || rel.length < 4 || rel[2] !== 'subagents' || !UUID_RE.test(rel[1])) return null;
  let workflowId;
  if (rel.length === 4) workflowId = null;
  else if (rel.length === 6 && rel[3] === 'workflows') workflowId = rel[4];
  else return null;
  const parent = rel[1];
  const aid = agent.groups.aid;
  return makeSource({
    tool: 'claude', path: file, encoding: 'plain', archived: false,
    segment: `${parent}/agent-${aid}`, sessionKey: claudeSessionKey(parent, aid), nativeId: parent,
    parentKey: claudeSessionKey(parent), agentId: aid, workflowId,
  });
}

export function classifyCodex(file, archived) {
  const name = path.basename(file);
  const m = CODEX_NAME.exec(name);
  if (!m) return null;
  return makeSource({
    tool: 'codex', path: file, encoding: m.groups.zst ? 'zst' : 'plain', archived,
    segment: name.replace(/\.zst$/, '').replace(/\.jsonl$/, ''),
    sessionKey: codexSessionKey(m.groups.thread), nativeId: m.groups.thread,
  });
}

function isClaudeCandidate(name) {
  if (CLAUDE_METADATA.test(name)) return false;
  return name.includes('.jsonl') || CLAUDE_UUID_PREFIX.test(name) || name.startsWith('agent-');
}

function isCodexCandidate(name) {
  return name.includes('.jsonl') || name.startsWith('rollout-');
}

async function* walk(root, reportError, statFn) {
  let info;
  try {
    info = await statFn(root);
  } catch (err) {
    if (err.code !== 'ENOENT') reportError(root);
    return;
  }
  if (!info.isDirectory()) {
    reportError(root);
    return;
  }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      reportError(dir);
      continue;
    }
    const subdirs = [];
    try {
      for await (const entry of handle) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) subdirs.push(full);
        else if (entry.isFile() || entry.isSymbolicLink()) yield full;
      }
    } catch {
      reportError(dir);
    }
    stack.push(...subdirs.sort().reverse());
  }
}

export class Inventory {
  sources = [];
  unsupported = [];
  empty = [];
  skipped = [];
  unreadable = [];

  sessions() {
    return new Set(this.sources.map((s) => s.sessionKey));
  }

  duplicateSegments() {
    const by = new Map();
    for (const s of this.sources) {
      const key = `${s.tool}:${s.segment}`;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(s.path);
    }
    return new Map([...by].filter(([, paths]) => paths.length > 1));
  }

  counts() {
    const c = new Map();
    for (const s of this.sources) {
      const key = [s.tool, s.encoding, s.archived ? 'archived' : 'active', s.parentKey ? 'child' : 'root'].join('\t');
      c.set(key, (c.get(key) || 0) + 1);
    }
    return new Map([...c].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

export async function buildInventory(roots, { stat = fsStat } = {}) {
  const inv = new Inventory();
  const unreadable = (p) => inv.unreadable.push(p);

  const add = async (file, source) => {
    if (!source) {
      inv.unsupported.push(file);
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      inv.unreadable.push(file);
      return;
    }
    if (info.size === 0) inv.empty.push(file);
    else inv.sources.push(source);
  };

  for await (const file of walk(roots.claudeProjects, unreadable, stat)) {
    const name = path.basename(file);
    if (!isClaudeCandidate(name)) continue;
    if (name === 'journal.jsonl' && file.split(path.sep).includes('workflows')) inv.skipped.push(file);
    else await add(file, classifyClaude(file, roots.claudeProjects));
  }
  for (const [root, archived] of [[roots.codexSessions, false], [roots.codexArchived, true]]) {
    for await (const file of walk(root, unreadable, stat)) {
      if (isCodexCandidate(path.basename(file))) await add(file, classifyCodex(file, archived));
    }
  }
  inv.sources.sort((a, b) => (a.tool + a.path < b.tool + b.path ? -1 : a.tool + a.path > b.tool + b.path ? 1 : 0));
  return inv;
}

export function openSource(source, { open = createReadStream } = {}) {
  const raw = open(source.path);
  if (source.encoding !== 'zst') return raw;
  return pipeline(raw, createZstdDecompress(), () => {});
}

export function recordId(source, nativeRecordId, lineNo) {
  if (source.tool === 'claude' && nativeRecordId) return nativeRecordId;
  return `${source.segment}:${lineNo}`;
}

export function rowKey(sessionKey, record, block) {
  return `${sessionKey}|${record}|${block}`;
}
