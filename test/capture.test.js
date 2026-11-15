import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { answerTime, captureReaderUrl, waitForCapture } from '../src/capture.js';
import { tmpDir } from './helpers/tmp.js';

function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('a row in another session never passes; the expected session is queried', async () => {
  const c = clock();
  const asked = [];
  const r = await waitForCapture({
    ...c,
    sessionReady: async () => ({ sessionId: 'claude:expected', answeredAt: c.now() }),
    query: async (sessionId) => {
      asked.push(sessionId);
      return sessionId === 'claude:other' ? { session_id: 'claude:other' } : null;
    },
    captureMs: 5000,
  });
  assert.equal(r.ok, false);
  assert.ok(asked.every((s) => s === 'claude:expected'));
});

test('a capture after the 60 s deadline fails; within it passes', async () => {
  for (const [arrivesAfter, ok] of [[30_000, true], [61_000, false]]) {
    const c = clock();
    const answeredAt = c.now();
    const r = await waitForCapture({
      ...c,
      sessionReady: async () => ({ sessionId: 's', answeredAt }),
      query: async () => (c.now() - answeredAt >= arrivesAfter ? { session_id: 's' } : null),
    });
    assert.equal(r.ok, ok, String(arrivesAfter));
  }
});

test('the preparation window is separate from the capture window', async () => {
  const c = clock();
  let calls = 0;
  const r = await waitForCapture({
    ...c,
    sessionReady: async () => (++calls > 200 ? { sessionId: 's', answeredAt: c.now() } : null),
    query: async () => ({ session_id: 's' }),
  });
  assert.equal(r.ok, true, 'a long human preparation time does not count against the 60 s');
  const never = await waitForCapture({ ...clock(), sessionReady: async () => null, query: async () => null, prepareMs: 5000 });
  assert.match(never.reason, /never appeared/);
});

test('the reader URL comes from the saved endpoint, without owner credentials', async (t) => {
  const dir = await tmpDir(t);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ url: 'postgresql://owner@localhost:6543/custom_history' }));
  assert.equal(captureReaderUrl({ AGENT_HISTORY_HOME: dir }), 'postgresql://agent_history_reader@localhost:6543/custom_history');
});

test('answer time is read from the final assistant text equal to the word', () => {
  const w = 'capture1234';
  const claude = [
    JSON.stringify({ type: 'user', timestamp: '2026-11-16T10:00:00Z', message: { content: `say ${w}` } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-11-16T10:00:05Z', message: { content: [{ type: 'text', text: ` ${w}\n` }] } }),
  ].join('\n');
  assert.equal(answerTime(claude, w, 'claude'), Date.parse('2026-11-16T10:00:05Z'));
  const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-11-16T10:00:07Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: w }] } });
  assert.equal(answerTime(codex, w, 'codex'), Date.parse('2026-11-16T10:00:07Z'));
  assert.equal(answerTime(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `not ${w}` }] } }), w, 'claude'), null);
});
