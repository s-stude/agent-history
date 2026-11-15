import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildInventory, openSource } from '../src/inventory.js';
import { createCodexParser } from '../src/parsers/codex.js';
import { makeRoots, write, writeZst } from './helpers/tmp.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/codex/', import.meta.url));
const MAIN = '01a0813d-de8d-7a63-885f-1777a897b70c';
const GUARDIAN = '01a0813d-de8d-7a63-885f-1777a897b70d';
const REPLAY = '01a0813d-de8d-7a63-885f-1777a897b70e';
const LEGACY = '01a07000-0000-7000-8000-000000000001';

async function setup(t, { zst = false } = {}) {
  const { roots } = await makeRoots(t);
  for (const name of await readdir(FIXTURES)) {
    const text = await readFile(path.join(FIXTURES, name), 'utf8');
    if (zst) await writeZst(path.join(roots.codexArchived, `${name}.zst`), text);
    else await write(path.join(roots.codexSessions, '2026/11/02', name), text);
  }
  const inv = await buildInventory(roots);
  return (id) => inv.sources.find((s) => s.nativeId === id);
}

async function parse(source) {
  const parser = createCodexParser(source);
  const rows = [];
  let n = 0;
  for await (const line of createInterface({ input: openSource(source), crlfDelay: Infinity })) rows.push(...parser.parseLine(line, ++n));
  return { rows, session: parser.finish(), unknown: parser.unknown, skipped: parser.skipped };
}

const strip = (rows) => rows.map(({ source_path, ...r }) => r);

test('main session: golden kinds, phases and turn ids; no double count from event_msg', async (t) => {
  const source = await setup(t);
  const { rows } = await parse(source(MAIN));
  assert.deepEqual(rows.map((r) => [r.role, r.kind, r.phase, r.turn_id]), [
    ['user', 'prompt', null, 'turn-1'],
    ['assistant', 'text', 'commentary', 'turn-1'],
    ['assistant', 'tool_use', null, 'turn-1'],
    ['tool', 'tool_result', null, 'turn-1'],
    ['assistant', 'tool_use', null, 'turn-1'],
    ['tool', 'tool_result', null, 'turn-1'],
    ['assistant', 'text', 'final_answer', 'turn-1'],
    ['system', 'summary', null, 'turn-1'],
    ['user', 'prompt', null, 'turn-2'],
    ['assistant', 'text', 'final_answer', 'turn-2'],
  ]);
  const prompt = rows[0];
  assert.equal(prompt.block_ordinal, 1, 'injected environment block skipped, prompt keeps its block ordinal');
  assert.equal(prompt.text, 'Rename fetchJson to getJson in src/net.js');
});

test('tool calls pair with outputs by call id; files from args and patches; secrets removed; outputs trimmed', async (t) => {
  const source = await setup(t);
  const { rows } = await parse(source(MAIN));
  const tools = rows.filter((r) => r.call_id);
  assert.deepEqual(tools.map((r) => [r.kind, r.tool_name, r.call_id]), [
    ['tool_use', 'exec_command', 'call_1'],
    ['tool_result', 'exec_command', 'call_1'],
    ['tool_use', 'apply_patch', 'call_2'],
    ['tool_result', 'apply_patch', 'call_2'],
  ]);
  assert.deepEqual(tools[0].files, ['src/net.js']);
  assert.deepEqual(tools[2].files, ['src/net.js', 'src/new.js']);
  for (const r of rows) {
    assert.ok(!r.text.includes('hunter2-super-secret-value'));
    if (r.raw) assert.ok(!r.raw.includes('hunter2-super-secret-value'));
  }
  assert.match(tools[1].text, /…\[\+\d+ chars\]$/);
  assert.ok(tools[1].text.length < 520);
});

test('session fields; resume meta does not reset; unknown and skipped counts', async (t) => {
  const source = await setup(t);
  const { session, unknown, skipped } = await parse(source(MAIN));
  assert.equal(session.id, `codex:${MAIN}`);
  assert.equal(session.project, 'demo');
  assert.equal(session.cli_version, '0.163.0');
  assert.equal(session.title, 'Rename fetchJson to getJson in src/net.js');
  assert.equal(session.parent_id, null);
  assert.equal(session.started_at.toISOString(), '2026-11-02T09:00:00.000Z');
  assert.equal(session.ended_at.toISOString(), '2026-11-02T09:00:17.000Z');
  assert.deepEqual([...unknown], [['response_item/brand_new_item', 1]]);
  assert.equal(skipped.get('response_item/reasoning'), 1);
  assert.equal(skipped.get('message/developer'), 1);
  assert.equal(skipped.get('user/injected'), 1);
  assert.equal(skipped.get('event_msg/item_completed'), 2);
});

test('guardian child: linked to parent, transcript copy skipped, verdict kept', async (t) => {
  const source = await setup(t);
  const { rows, session, skipped } = await parse(source(GUARDIAN));
  assert.equal(session.parent_id, `codex:${MAIN}`);
  assert.equal(session.is_sidechain, true);
  assert.equal(session.agent_id, 'guardian');
  assert.equal(skipped.get('user/guardian-input'), 1);
  assert.deepEqual(rows.map((r) => [r.role, r.kind]), [['assistant', 'text']]);
});

test('child with replayed parent history skips lines before the history ordinal', async (t) => {
  const source = await setup(t);
  const { rows, session, skipped } = await parse(source(REPLAY));
  assert.equal(session.agent_id, 'Ada');
  assert.equal(session.parent_id, `codex:${MAIN}`);
  assert.equal(skipped.get('replayed-parent-history'), 2);
  assert.deepEqual(rows.map((r) => r.text), ['Check the tests for getJson', 'Tests cover getJson.']);
  assert.equal(session.started_at.toISOString(), '2026-11-02T09:00:30.000Z');
});

test('legacy rollout without the type/payload envelope', async (t) => {
  const source = await setup(t);
  const { rows, session } = await parse(source(LEGACY));
  assert.deepEqual(rows.map((r) => [r.role, r.kind, r.tool_name]), [
    ['user', 'prompt', null],
    ['assistant', 'tool_use', 'shell'],
    ['tool', 'tool_result', 'shell'],
    ['assistant', 'text', null],
  ]);
  assert.equal(session.started_at.toISOString(), '2025-10-01T08:00:00.000Z');
});

test('.zst copies parse to the same rows as plain files', async (t) => {
  const plain = await setup(t);
  const zst = await setup(t, { zst: true });
  for (const id of [MAIN, GUARDIAN, REPLAY, LEGACY]) {
    const a = await parse(plain(id));
    const b = await parse(zst(id));
    assert.equal(zst(id).encoding, 'zst');
    assert.deepEqual(strip(b.rows), strip(a.rows), id);
  }
});

test('JSON-shaped prompt and answer text are sanitized structurally', async (t) => {
  const source = await setup(t);
  const parser = createCodexParser(source(MAIN));
  const secret = JSON.stringify({ password: 'synthetic-secret-123' });
  const lines = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: secret }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(secret) }] } },
    { type: 'compacted', payload: { message: secret } },
  ];
  const rows = lines.flatMap((l, i) => parser.parseLine(JSON.stringify({ timestamp: 'bad', ...l }), i + 2));
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.ok(!r.text.includes('synthetic-secret-123'));
    assert.ok(!r.raw.includes('synthetic-secret-123'));
    assert.equal(r.ts, null);
  }
  assert.equal(parser.unknown.get('invalid-timestamp'), 3);
});

function rootParser(source) {
  const parser = createCodexParser(source(MAIN));
  parser.parseLine(JSON.stringify({ type: 'session_meta', payload: { id: MAIN, cwd: '/w/demo' } }), 1);
  return parser;
}

const userMsg = (text) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

test('patch lines that add or remove credentials are redacted in text and raw', async (t) => {
  const source = await setup(t);
  const parser = rootParser(source);
  for (const [i, sign] of [['+', 2], ['-', 3]].map(([s, n]) => [n, s])) {
    const input = `*** Begin Patch\n*** Update File: .env\n${sign}DB_PASSWORD=synthetic-secret-123\n${sign}export API_TOKEN="two words secret"\n*** End Patch`;
    const [row] = parser.parseLine(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: `c${i}`, input } }), i);
    for (const field of [row.text, row.raw]) {
      assert.ok(!field.includes('synthetic-secret-123'), sign);
      assert.ok(!field.includes('two words secret'), sign);
    }
    assert.ok(row.text.includes(`${sign}DB_PASSWORD=[REDACTED:env]`), sign);
  }
});

test('only known injected blocks are skipped; ordinary tags and headings stay prompts', async (t) => {
  const source = await setup(t);
  const parser = rootParser(source);
  const keep = [
    '<html>\nFix this page for mobile.\n</html>',
    '# Files to update\nPlease change src/a.js.',
    '# Files mentioned by the user:\n\n## a.js: /x/a.js\n\n## My request for Codex:\nRefactor a.js',
    'The following is the Codex agent history. Please summarize it.',
    '<environment_context>unclosed and then a real question',
  ];
  const drop = ['<environment_context>\n<cwd>/x</cwd>\n</environment_context>', '# AGENTS.md instructions for /x\n\nrules', '<skill>\nname\n</skill>'];
  let n = 2;
  for (const text of keep) {
    const rows = parser.parseLine(userMsg(text), n++);
    assert.deepEqual(rows.map((r) => r.kind), ['prompt'], text);
  }
  for (const text of drop) assert.deepEqual(parser.parseLine(userMsg(text), n++), [], text);
  const [note] = parser.parseLine(userMsg('<subagent_notification>\n{"done":true}\n</subagent_notification>'), n++);
  assert.deepEqual([note.role, note.kind], ['system', 'notification']);
  assert.equal(parser.skipped.get('user/injected'), 3);
});

test('guardian state survives a snapshot and restore', async (t) => {
  const source = await setup(t);
  const first = createCodexParser(source(GUARDIAN));
  first.parseLine(JSON.stringify({ type: 'session_meta', payload: { id: GUARDIAN, parent_thread_id: MAIN, source: { subagent: { other: 'guardian' } } } }), 1);
  const resumed = createCodexParser(source(GUARDIAN), JSON.parse(JSON.stringify(first.snapshot())));
  assert.deepEqual(resumed.parseLine(userMsg('[1] user: anything'), 2), []);
  assert.equal(resumed.skipped.get('user/guardian-input'), 1);
});
