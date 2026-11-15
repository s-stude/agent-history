import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInventory } from '../src/inventory.js';
import { createClaudeParser, projectFromCwd } from '../src/parsers/claude.js';
import { makeRoots, write } from './helpers/tmp.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/claude/', import.meta.url));
const PARENT = '43cec861-2203-414b-bfc7-b732d4b880f0';

async function setup(t) {
  const { roots } = await makeRoots(t);
  const proj = path.join(roots.claudeProjects, '-Users-me-projects-demo');
  await write(path.join(proj, `${PARENT}.jsonl`), await readFile(path.join(FIXTURES, 'main.jsonl'), 'utf8'));
  for (const aid of ['a1', 'a2']) {
    await write(path.join(proj, PARENT, 'subagents', `agent-${aid}.jsonl`), await readFile(path.join(FIXTURES, `agent-${aid}.jsonl`), 'utf8'));
  }
  return buildInventory(roots);
}

async function parse(source) {
  const parser = createClaudeParser(source);
  const lines = (await readFile(source.path, 'utf8')).split('\n').filter(Boolean);
  const rows = lines.flatMap((line, i) => parser.parseLine(line, i + 1));
  return { rows, session: parser.finish(), unknown: parser.unknown, skipped: parser.skipped };
}

test('main session: golden kinds and counts', async (t) => {
  const inv = await setup(t);
  const { rows } = await parse(inv.sources.find((s) => !s.parentKey));
  const kinds = rows.map((r) => `${r.role}/${r.kind}`);
  assert.deepEqual(kinds, [
    'user/prompt',
    'assistant/tool_use',
    'tool/tool_result',
    'assistant/tool_use',
    'tool/tool_result',
    'assistant/text',
    'user/command',
    'system/notification',
    'user/summary',
    'system/compact_boundary',
    'assistant/text',
    'assistant/tool_use',
  ]);
  assert.equal(rows.filter((r) => r.kind === 'prompt').length, 1, 'tool-result wrappers are not prompts');
});

test('tool results carry tool name and call id and are trimmed after sanitizing', async (t) => {
  const inv = await setup(t);
  const { rows } = await parse(inv.sources.find((s) => !s.parentKey));
  const results = rows.filter((r) => r.kind === 'tool_result');
  assert.deepEqual(results.map((r) => [r.tool_name, r.call_id]), [['Read', 'toolu_1'], ['Bash', 'toolu_2']]);
  assert.ok(results[0].text.length < 600);
  assert.match(results[0].text, /…\[\+\d+ chars\]$/);
  const bash = rows.find((r) => r.tool_name === 'Bash' && r.kind === 'tool_use');
  assert.ok(!bash.text.includes('hunter2-super-secret-value'));
  assert.ok(!bash.raw.includes('hunter2-super-secret-value'));
});

test('file paths come from tool inputs; multi-block lines keep every block', async (t) => {
  const inv = await setup(t);
  const { rows } = await parse(inv.sources.find((s) => !s.parentKey));
  assert.deepEqual(rows.find((r) => r.tool_name === 'Read').files, ['/Users/me/projects/demo/src/net.js']);
  const multi = rows.filter((r) => r.record_id === 'a-5');
  assert.deepEqual(multi.map((r) => [r.block_ordinal, r.kind]), [[0, 'text'], [1, 'tool_use']]);
  assert.deepEqual(multi[1].files, ['src/net.js']);
  assert.ok(multi[0].raw && !multi[1].raw, 'raw is stored once per line');
});

test('session fields: project, cwd, times, version, title', async (t) => {
  const inv = await setup(t);
  const { session } = await parse(inv.sources.find((s) => !s.parentKey));
  assert.equal(session.id, `claude:${PARENT}`);
  assert.equal(session.project, 'demo');
  assert.equal(session.cwd, '/Users/me/projects/demo');
  assert.equal(session.cli_version, '2.9.1');
  assert.equal(session.started_at.toISOString(), '2026-11-01T10:00:00.000Z');
  assert.equal(session.ended_at.toISOString(), '2026-11-01T10:02:00.000Z');
  assert.equal(session.title, 'Fetch retry work');
  assert.equal(session.is_sidechain, false);
});

test('unknown types are counted; noise and meta are skipped', async (t) => {
  const inv = await setup(t);
  const { unknown, skipped } = await parse(inv.sources.find((s) => !s.parentKey));
  assert.deepEqual([...unknown], [['brand-new-type', 1]]);
  for (const k of ['permission-mode', 'mode', 'attachment', 'system/turn_duration', 'user/meta', 'assistant/thinking']) {
    assert.equal(skipped.get(k), 1, k);
  }
});

test('parent and two children parse into three linked sessions', async (t) => {
  const inv = await setup(t);
  const parsed = await Promise.all(inv.sources.map(parse));
  const sessions = parsed.map((p) => p.session);
  assert.equal(new Set(sessions.map((s) => s.id)).size, 3);
  const children = sessions.filter((s) => s.parent_id);
  assert.deepEqual(children.map((s) => [s.parent_id, s.agent_id, s.is_sidechain, s.title]).sort(), [
    [`claude:${PARENT}`, 'a1', true, 'helper a1'],
    [`claude:${PARENT}`, 'a2', true, 'helper a2'],
  ]);
  for (const p of parsed.filter((x) => x.session.parent_id)) {
    assert.deepEqual(p.rows.map((r) => r.kind), ['prompt', 'text']);
    assert.ok(p.rows.every((r) => r.session_id === p.session.id));
  }
});

test('invalid JSON lines are counted, not thrown', async (t) => {
  const inv = await setup(t);
  const parser = createClaudeParser(inv.sources[0]);
  assert.deepEqual(parser.parseLine('{"type":"user", broken', 1), []);
  assert.equal(parser.unknown.get('invalid-json'), 1);
});

test('project from cwd strips worktree folders', () => {
  assert.equal(projectFromCwd('/Users/me/projects/demo'), 'demo');
  assert.equal(projectFromCwd('/Users/me/projects/demo/.claude/worktrees/feature-x'), 'demo');
  assert.equal(projectFromCwd('/Users/me/projects/demo/.worktrees/feature-x'), 'demo');
  assert.equal(projectFromCwd(null), null);
});
