import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pointerText, readerUrl, PSQL, POINTER_START, POINTER_END } from '../src/pointer.js';
import { useTestDb } from './helpers/db.js';

test('reader URL never carries owner identity or credentials', () => {
  for (const owner of [
    'postgresql://owner:pw@localhost:5432/agent_history',
    'postgresql://localhost:5432/agent_history?user=owner&password=pw',
    'postgresql://owner@localhost:5432/agent_history?user=owner2&statement_timeout=0',
  ]) {
    const r = readerUrl(owner);
    assert.equal(r, 'postgresql://agent_history_reader@localhost:5432/agent_history', owner);
  }
  assert.equal(readerUrl('postgresql://h:6543/x?sslmode=require'), 'postgresql://agent_history_reader@h:6543/x?sslmode=require');
});

test('pointer text has markers, the reader connection, the FTS limit and examples', () => {
  const text = pointerText({ url: 'postgresql://owner:pw@localhost:5432/agent_history', exportDir: '/Users/me/.agent-history/md' });
  assert.ok(text.startsWith(POINTER_START));
  assert.ok(text.trimEnd().endsWith(POINTER_END));
  assert.ok(text.includes('postgresql://agent_history_reader@localhost:5432/agent_history'));
  assert.ok(!text.includes('owner'));
  assert.ok(!text.includes(':pw@'));
  assert.match(text, /first 100,000 characters/);
  assert.match(text, /newer one wins/);
  assert.match(text, /md\/<project>\/<date>-<id>\.md/);
  assert.doesNotMatch(pointerText({ url: 'postgresql://localhost/agent_history' }), /Markdown copies/);
});

test('every example query in the pointer runs in a read-only transaction', async (t) => {
  const h = await useTestDb(t);
  if (!h) return;
  await h.db('sessions').insert({ id: 's1', tool: 'claude', native_id: 's1', project: 'demo', started_at: new Date() });
  await h.db('messages').insert({ session_id: 's1', record_id: 'r', block_ordinal: 0, kind: 'text', role: 'assistant', ts: new Date(), text: 'added retry backoff to src/net.js', files: ['src/net.js'] });
  const text = pointerText({ url: h.url });
  const queries = [...text.matchAll(/-c "(.+)"$/gm)].map((m) => m[1]);
  assert.equal(queries.length, 4);
  for (const q of queries) {
    const { stdout } = await promisify(execFile)(PSQL, ['--dbname', h.url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY', '-c', q, '-c', 'COMMIT']);
    assert.ok(stdout.split('\n').length >= 2, q);
  }
});
