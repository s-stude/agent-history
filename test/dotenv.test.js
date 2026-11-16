import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.js';

const BIN = fileURLToPath(new URL('../bin/agent-history', import.meta.url));
const run = promisify(execFile);

async function tree(t) {
  const dir = await tmpDir(t);
  const a = path.join(dir, 'a', '-p');
  const b = path.join(dir, 'b', '-p');
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await writeFile(path.join(a, '43cec861-2203-414b-bfc7-b732d4b880f0.jsonl'), '{"type":"mode"}\n');
  for (const id of ['43cec861-2203-414b-bfc7-b732d4b880f1', '43cec861-2203-414b-bfc7-b732d4b880f2']) {
    await writeFile(path.join(b, `${id}.jsonl`), '{"type":"mode"}\n');
  }
  const envFile = path.join(dir, '.env');
  await writeFile(envFile, [
    `AGENT_HISTORY_CLAUDE_PROJECTS=${path.join(dir, 'a')}`,
    `AGENT_HISTORY_CODEX_SESSIONS="${path.join(dir, 'none')}" # quoted, with a comment`,
    `AGENT_HISTORY_CODEX_ARCHIVED=${path.join(dir, 'none')}`,
    '',
  ].join('\n'));
  return { dir, envFile, b: path.join(dir, 'b') };
}

const sessions = (stdout) => Number(/^sessions\t(\d+)$/m.exec(stdout)[1]);

test('the CLI reads settings from .env', async (t) => {
  const { envFile } = await tree(t);
  const env = { ...process.env, AGENT_HISTORY_DOTENV: '1', AGENT_HISTORY_DOTENV_FILE: envFile };
  for (const k of ['AGENT_HISTORY_CLAUDE_PROJECTS', 'AGENT_HISTORY_CODEX_SESSIONS', 'AGENT_HISTORY_CODEX_ARCHIVED']) delete env[k];
  const { stdout } = await run(process.execPath, [BIN, 'scan', '--dry-run'], { env, cwd: '/' });
  assert.equal(sessions(stdout), 1);
});

test('the shell environment wins over .env, and AGENT_HISTORY_DOTENV=0 skips it', async (t) => {
  const { envFile, b } = await tree(t);
  const base = { ...process.env, AGENT_HISTORY_DOTENV_FILE: envFile };
  const shell = await run(process.execPath, [BIN, 'scan', '--dry-run'], { env: { ...base, AGENT_HISTORY_DOTENV: '1', AGENT_HISTORY_CLAUDE_PROJECTS: b }, cwd: '/' });
  assert.equal(sessions(shell.stdout), 2);
  const off = { ...base, AGENT_HISTORY_DOTENV: '0', AGENT_HISTORY_CLAUDE_PROJECTS: path.join(b, 'missing'), AGENT_HISTORY_CODEX_SESSIONS: path.join(b, 'missing'), AGENT_HISTORY_CODEX_ARCHIVED: path.join(b, 'missing') };
  assert.equal(sessions((await run(process.execPath, [BIN, 'scan', '--dry-run'], { env: off, cwd: '/' })).stdout), 0);
});

test('a missing .env file is fine', async (t) => {
  const dir = await tmpDir(t);
  const env = { ...process.env, AGENT_HISTORY_DOTENV: '1', AGENT_HISTORY_DOTENV_FILE: path.join(dir, 'nope.env') };
  await run(process.execPath, [BIN, '--help'], { env });
});
