import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { stat as realStat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { buildInventory, openSource, recordId, rowKey } from '../src/inventory.js';
import { makeRoots, REPO, tmpDir, write, writeZst } from './helpers/tmp.js';

const PARENT = '43cec861-2203-414b-bfc7-b732d4b880f0';
const THREAD = '01a0813d-de8d-7a63-885f-1777a897b70c';
const PAGE = '01a081dc-35cd-70a2-a4ae-9c854f58da93';
const LINE = `{"type":"session_meta","payload":{"id":"${THREAD}"}}\n`;
const ROLLOUT = `rollout-2026-09-08T16-38-30-${THREAD}.jsonl`;
const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));

async function claudeTree(root) {
  const proj = path.join(root, '-Users-me-proj');
  await write(path.join(proj, `${PARENT}.jsonl`));
  await write(path.join(proj, PARENT, 'subagents', 'agent-a1.jsonl'));
  await write(path.join(proj, PARENT, 'subagents', 'agent-a2.jsonl'));
  await write(path.join(proj, PARENT, 'subagents', 'workflows', 'wf_x', 'agent-a3.jsonl'));
}

test('parent and children get distinct ids', async (t) => {
  const { roots } = await makeRoots(t);
  await claudeTree(roots.claudeProjects);
  const inv = await buildInventory(roots);
  assert.deepEqual(inv.sessions(), new Set([
    `claude:${PARENT}`, `claude:${PARENT}/agent:a1`, `claude:${PARENT}/agent:a2`, `claude:${PARENT}/agent:a3`,
  ]));
  const children = inv.sources.filter((s) => s.parentKey);
  assert.deepEqual(new Set(children.map((s) => s.parentKey)), new Set([`claude:${PARENT}`]));
  assert.deepEqual(new Set(children.map((s) => s.nativeId)), new Set([PARENT]));
  assert.equal(children.find((s) => s.agentId === 'a3').workflowId, 'wf_x');
});

test('codex plain, zst and archived copies share one identity and segment', async (t) => {
  const { roots } = await makeRoots(t);
  await write(path.join(roots.codexSessions, '2026/09/08', ROLLOUT), LINE);
  await writeZst(path.join(roots.codexSessions, '2026/09/08', `${ROLLOUT}.zst`), LINE);
  await writeZst(path.join(roots.codexArchived, `${ROLLOUT}.zst`), LINE);
  const inv = await buildInventory(roots);
  assert.deepEqual(inv.sessions(), new Set([`codex:${THREAD}`]));
  assert.equal(new Set(inv.sources.map((s) => s.segment)).size, 1);
  assert.equal([...inv.duplicateSegments().values()][0].length, 3);
  assert.deepEqual(
    new Set(inv.sources.map((s) => `${s.encoding}/${s.archived}/${s.immutable}`)),
    new Set(['plain/false/false', 'zst/false/true', 'zst/true/true']),
  );
});

test('codex page file is an extra segment of the same thread', async (t) => {
  const { roots } = await makeRoots(t);
  await writeZst(path.join(roots.codexSessions, '2026/09/08', `${ROLLOUT}.zst`), LINE);
  await writeZst(path.join(roots.codexSessions, '2026/09/08', `rollout-2026-09-08T19-31-27-${THREAD}_${PAGE}.jsonl.zst`), LINE);
  const inv = await buildInventory(roots);
  assert.deepEqual(inv.sessions(), new Set([`codex:${THREAD}`]));
  assert.equal(new Set(inv.sources.map((s) => s.segment)).size, 2);
  assert.equal(inv.duplicateSegments().size, 0);
});

test('unsupported, empty and skipped files are reported', async (t) => {
  const { roots } = await makeRoots(t);
  const p = path.join(roots.claudeProjects, '-p');
  await write(path.join(p, 'notes.jsonl'));
  await write(path.join(p, PARENT, 'subagents', 'deep', 'x', 'y', 'agent-z.jsonl'));
  await write(path.join(roots.codexSessions, 'weird.jsonl'));
  await write(path.join(p, `${PARENT}.jsonl`), '');
  await write(path.join(p, 'sessions-index.json'), '{}');
  await write(path.join(p, PARENT, 'subagents', 'workflows', 'wf_x', 'journal.jsonl'));
  const inv = await buildInventory(roots);
  assert.deepEqual(inv.sources, []);
  assert.equal(inv.skipped.length, 1);
  assert.equal(inv.unsupported.length, 3);
  assert.equal(inv.empty.length, 1);
});

test('record and row keys', async (t) => {
  const { roots } = await makeRoots(t);
  await write(path.join(roots.codexSessions, ROLLOUT), LINE);
  await claudeTree(roots.claudeProjects);
  const inv = await buildInventory(roots);
  const codex = inv.sources.find((s) => s.tool === 'codex');
  const claude = inv.sources.find((s) => s.tool === 'claude');
  assert.equal(recordId(codex, 'ignored', 7), `rollout-2026-09-08T16-38-30-${THREAD}:7`);
  assert.equal(recordId(claude, 'uuid-1', 7), 'uuid-1');
  assert.equal(recordId(claude, null, 7), `${claude.segment}:7`);
  assert.notEqual(rowKey('claude:s', 'uuid-1', 0), rowKey('claude:s', 'uuid-1', 1));
});

test('scan --dry-run prints counts', async (t) => {
  const { roots, env } = await makeRoots(t);
  await claudeTree(roots.claudeProjects);
  const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'scan', '--dry-run'], {
    env: { ...process.env, ...env }, cwd: '/',
  });
  assert.match(stdout, /^claude\tplain\tactive\tchild\t3$/m);
  assert.match(stdout, /^sessions\t4$/m);
});

test('openSource streams plain and zst identically', async (t) => {
  const { roots } = await makeRoots(t);
  await write(path.join(roots.codexSessions, ROLLOUT), LINE.repeat(3));
  await writeZst(path.join(roots.codexArchived, `${ROLLOUT}.zst`), LINE.repeat(3));
  const contents = new Set();
  for (const src of (await buildInventory(roots)).sources) contents.add(await text(openSource(src)));
  assert.deepEqual(contents, new Set([LINE.repeat(3)]));
});

test('openSource on a corrupt zst file errors instead of hanging', async (t) => {
  const { roots } = await makeRoots(t);
  await write(path.join(roots.codexArchived, `${ROLLOUT}.zst`), 'not zstd at all');
  const [src] = (await buildInventory(roots)).sources;
  await assert.rejects(text(openSource(src)));
});

test('unknown transcript-like files are unsupported', async (t) => {
  const { roots } = await makeRoots(t);
  const p = path.join(roots.claudeProjects, '-p');
  await write(path.join(roots.codexSessions, `rollout-2026-09-08T16-38-30-${THREAD}.bin`));
  await write(path.join(p, `${PARENT}.jsonl.zst`));
  await write(path.join(p, PARENT, 'subagents', 'agent-a1.jsonl.zst'));
  await write(path.join(p, 'sessions-index.json'), '{}');
  await write(path.join(p, PARENT, 'tool-results', 'out.txt'));
  await write(path.join(p, PARENT, 'subagents', 'agent-a1.meta.json'), '{}');
  const inv = await buildInventory(roots);
  assert.deepEqual(inv.sources, []);
  assert.deepEqual(inv.unsupported.map((f) => path.basename(f)).sort(), [
    `rollout-2026-09-08T16-38-30-${THREAD}.bin`, `${PARENT}.jsonl.zst`, 'agent-a1.jsonl.zst',
  ].sort());
});

test('a root that is a file is unreadable; a missing root is fine', async (t) => {
  const { roots } = await makeRoots(t);
  await rm(roots.codexArchived, { recursive: true });
  await rm(roots.codexSessions, { recursive: true });
  await writeFile(roots.codexSessions, 'not a dir');
  await claudeTree(roots.claudeProjects);
  const inv = await buildInventory(roots);
  assert.deepEqual(inv.unreadable, [roots.codexSessions]);
  assert.equal(inv.sources.length, 4);
});

test('a denied subtree is reported and the scan continues', async (t) => {
  const { roots } = await makeRoots(t);
  await claudeTree(roots.claudeProjects);
  const denied = path.join(roots.claudeProjects, '-denied');
  await mkdir(denied);
  await chmod(denied, 0o000);
  let inv;
  try {
    inv = await buildInventory(roots);
  } finally {
    await chmod(denied, 0o700);
  }
  assert.ok(inv.unreadable.includes(denied));
  assert.equal(inv.sources.length, 4);
});

test('a stat failure or vanished file is isolated', async (t) => {
  const { roots } = await makeRoots(t);
  await claudeTree(roots.claudeProjects);
  const bad = await write(path.join(roots.codexSessions, ROLLOUT), LINE);
  const gone = await write(path.join(roots.codexArchived, `rollout-2026-09-08T19-31-27-${THREAD}_${PAGE}.jsonl`), LINE);
  const stat = async (p) => {
    if (p === bad) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (p === gone) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return realStat(p);
  };
  const inv = await buildInventory(roots, { stat });
  assert.deepEqual(inv.unreadable.sort(), [bad, gone].sort());
  assert.equal(inv.sources.length, 4);
});

test('test temp dirs live inside the repo tmp folder', async (t) => {
  const dir = await tmpDir(t);
  assert.ok(dir.startsWith(path.join(REPO, 'tmp')));
});

function closed(stream) {
  if (stream.closed) return Promise.resolve();
  stream.on('error', () => {});
  return new Promise((resolve) => stream.once('close', resolve));
}

function trackedOpen() {
  const opened = [];
  const open = (p) => {
    const s = createReadStream(p, { highWaterMark: 1024 });
    opened.push(s);
    return s;
  };
  return { opened, open };
}

test('corrupt zst larger than one read buffer closes its input file', { timeout: 5000 }, async (t) => {
  const { roots } = await makeRoots(t);
  await write(path.join(roots.codexArchived, `${ROLLOUT}.zst`), randomBytes(1 << 20).toString('binary'));
  const [src] = (await buildInventory(roots)).sources;
  const { opened, open } = trackedOpen();
  await assert.rejects(text(openSource(src, { open })));
  await closed(opened[0]);
  assert.equal(opened[0].destroyed, true);
});

test('a consumer that stops early closes the zst input file', { timeout: 5000 }, async (t) => {
  const { roots } = await makeRoots(t);
  await writeZst(path.join(roots.codexArchived, `${ROLLOUT}.zst`), LINE.repeat(200_000));
  const [src] = (await buildInventory(roots)).sources;
  const { opened, open } = trackedOpen();
  const stream = openSource(src, { open });
  for await (const chunk of stream) {
    assert.ok(chunk.length > 0);
    break;
  }
  await closed(opened[0]);
  assert.equal(opened[0].destroyed, true);
});
