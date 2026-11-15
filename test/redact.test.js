import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounded, redactText, sanitize, sanitizeLine } from '../src/redact.js';
import * as S from './fixtures/secrets.js';

function assertClean(text) {
  for (const secret of S.ALL) assert.ok(!text.includes(secret), secret.slice(0, 12));
}

for (const token of S.TOKENS) {
  test(`plain token ${token.slice(0, 8)}… is redacted`, () => {
    const out = redactText(`use ${token} now`);
    assert.ok(!out.includes(token));
    assert.match(out, /^use \[REDACTED:\w+\] now$/);
  });
}

test('bearer, env assignments and PEM', () => {
  const text = `Authorization: Bearer ${S.BEARER}\nexport OPENAI_API_KEY=${S.ENV_VALUE}\nDB_PASSWORD='${S.ENV_VALUE}'\n${S.PEM}\nafter`;
  const out = redactText(text);
  assertClean(out);
  assert.ok(out.includes('OPENAI_API_KEY=[REDACTED:env]'));
  assert.ok(out.endsWith('after'));
});

test('escaped PEM inside a raw JSON line', () => {
  const line = JSON.stringify({ type: 'user', message: { content: `key:\n${S.PEM}` } });
  assert.ok(line.includes('\\n'));
  assertClean(sanitizeLine(line));
  assertClean(redactText(line));
});

test('truncated PEM without an end marker', () => {
  assertClean(redactText(`-----BEGIN PRIVATE KEY-----\n${S.PEM_BODY}`));
});

test('nested stringified tool arguments', () => {
  const args = JSON.stringify({ cmd: `curl -H 'Authorization: Bearer ${S.BEARER}'`, env: { api_key: S.FIELD_VALUE } });
  const record = { type: 'response_item', payload: { type: 'function_call', arguments: args, input: JSON.stringify([S.GITHUB]) } };
  const out = sanitizeLine(JSON.stringify(record));
  assertClean(out);
  assert.equal(JSON.parse(JSON.parse(out).payload.arguments).env.api_key, '[REDACTED:field]');
});

test('metadata fields and tool results', () => {
  const record = {
    cwd: `/tmp/${S.AWS}`,
    title: `debug ${S.SLACK}`,
    toolUseResult: { stdout: `OPENAI_API_KEY=${S.ENV_VALUE}\nok`, password: S.FIELD_VALUE },
    headers: { Authorization: `Bearer ${S.BEARER}`, 'x-api-key': S.FIELD_VALUE },
  };
  assertClean(JSON.stringify(sanitize(record)));
});

test('a secret straddling the trim boundary is removed', () => {
  const out = bounded(`${'x'.repeat(489)} ${S.ANTHROPIC} ${'y'.repeat(100)}`, 500);
  assert.ok(!out.includes('sk-ant-'));
  assert.ok(!out.includes(S.ANTHROPIC.slice(0, 20)));
  assert.ok(out.endsWith('chars]'));
});

test('bounded keeps short text and passes null through', () => {
  assert.equal(bounded('hello', 500), 'hello');
  assert.equal(bounded(null, 500), null);
  assert.equal(bounded(undefined, 500), undefined);
});

const BENIGN = [
  'commit 9f0a007c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a',
  'session 43cec861-2203-414b-bfc7-b732d4b880f0',
  '/Users/me/projects/sk-learn-notes/token_count.py',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'max_tokens: 4096',
  'token_count = 12',
  'the PASSWORD field is required',
  'MAX_TOKENS: 4096',
  "api_key = os.environ['API_KEY']",
];
for (const benign of BENIGN) {
  test(`false positive left intact: ${benign.slice(0, 30)}`, () => assert.equal(redactText(benign), benign));
}

test('a key prefix inside a long base64url blob is not a key', () => {
  const blob = `iVBORw0KGgo${'Ab3_x'.repeat(40)}sk-${'Zq9_Lm'.repeat(60)}xoxb-${'Pq7'.repeat(30)}`;
  assert.equal(redactText(blob), blob);
});

test('a key next to punctuation is still caught', () => {
  for (const wrapped of [`"${S.OPENAI}"`, `(${S.ANTHROPIC})`, `key=${S.GITHUB};`, `<${S.SLACK}>`]) assertClean(redactText(wrapped));
});

test('benign JSON keys are untouched', () => {
  const record = { token_count: 12, input_tokens: 5, key: 'value', tokenizer: 'cl100k' };
  assert.deepEqual(sanitize(record), record);
});

test('an invalid JSON line falls back to text redaction', () => {
  assertClean(sanitizeLine(`not json ${S.GITHUB}`));
});

test('NUL characters are removed from text, values and keys', () => {
  assert.equal(redactText('a\u0000b'), 'ab');
  const out = sanitize({ 'k\u0000': ['x\u0000y', { n: 1 }] });
  assert.deepEqual(out, { k: ['xy', { n: 1 }] });
  assert.ok(!sanitizeLine(JSON.stringify({ t: 'a\u0000b' })).includes('\\u0000'));
});

test('redaction is repeatable: global regexes keep no state between calls', () => {
  for (let i = 0; i < 3; i++) assert.ok(!redactText(`x ${S.AWS} y`).includes(S.AWS));
});

test('env assignments whose value is a reference are kept', () => {
  for (const line of [
    'OPENAI_API_KEY=$OPENAI_API_KEY',
    'export GITHUB_TOKEN=${GH_TOKEN}',
    'API_KEY: process.env.ANTHROPIC_API_KEY,',
    "DB_PASSWORD: os.environ['DB_PASSWORD']",
    'SLACK_TOKEN=<your-token-here>',
    'SLACK_TOKEN="<your-token-here>"',
    'CLIENT_SECRET: {{ secrets.client }}',
    'JWT_SECRET: config.auth.jwtSecret,',
    'ACCESS_TOKEN: settings.get_token()',
  ]) {
    assert.equal(redactText(line), line, line);
  }
});

test('opaque and literal env values are fully redacted', () => {
  const cases = [
    'PASSWORD=hunter2',
    'DB_PASSWORD=1234567890',
    'DB_PASSWORD="correct horse battery staple"',
    "DB_PASSWORD='x#SecretTail123'",
    'DB_PASSWORD="my.secret.pass"',
    'DB_PASSWORD=Ab3.x9Q',
    'DB_PASSWORD=my.secret.pass',
    'DB_PASSWORD=process.env.prefix-secret',
    `DB_PASSWORD=${S.ENV_VALUE}`,
    `DB_PASSWORD="${S.ENV_VALUE}"`,
    'DB_PASSWORD="config.auth.jwtSecret,"',
  ];
  for (const line of cases) {
    assert.equal(redactText(line), 'DB_PASSWORD=[REDACTED:env]'.replace('DB_PASSWORD', line.split('=')[0]), line);
    assert.ok(!sanitizeLine(JSON.stringify({ text: `${line}\nnext` })).includes(line.split('=')[1]), line);
  }
});

test('a quoted value is removed whole, the rest of the line stays', () => {
  assert.equal(redactText('DB_PASSWORD="correct horse battery staple" # note'), 'DB_PASSWORD=[REDACTED:env] # note');
});

test('numeric token-count metrics are not credentials', () => {
  for (const line of ['MAX_TOKENS: 4096', 'MAX_OUTPUT_TOKENS=8192', 'TOKENS_USED: 1234', 'NUM_TOKENS=12']) assert.equal(redactText(line), line);
});

test('JSON strings encoded twice or more are sanitized inside', () => {
  let value = { password: 'synthetic-secret-123', note: 'ok' };
  for (let depth = 1; depth <= 3; depth++) {
    value = JSON.stringify(value);
    const out = sanitize({ text: value });
    assert.ok(!JSON.stringify(out).includes('synthetic-secret-123'), `depth ${depth}`);
    assert.ok(!sanitizeLine(JSON.stringify({ text: value })).includes('synthetic-secret-123'), `line depth ${depth}`);
  }
});

test('deep encoding stops at the depth limit and still redacts text', () => {
  let value = `PASSWORD=${S.ENV_VALUE}`;
  for (let i = 0; i < 12; i++) value = JSON.stringify(value);
  assert.ok(!JSON.stringify(sanitize({ text: value })).includes(S.ENV_VALUE));
});

test('secret field names are checked after NUL removal; only exact markers are skipped', () => {
  assert.deepEqual(sanitize({ 'pass\u0000word': 'synthetic-secret-123' }), { password: '[REDACTED:field]' });
  assert.deepEqual(sanitize({ password: '[REDACTED]synthetic-secret-123' }), { password: '[REDACTED:field]' });
  assert.deepEqual(sanitize({ password: '[REDACTED:env]' }), { password: '[REDACTED:env]' });
});

test('redaction happens before trimming for assignment values', () => {
  const out = bounded(`${'x'.repeat(480)}\nDB_PASSWORD="correct horse battery staple"`, 500);
  assert.ok(!out.includes('correct'));
  assert.ok(!out.includes('battery'));
});
