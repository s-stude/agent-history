// Records the real Codex hook payload in an isolated CODEX_HOME under ./tmp, without touching ~/.codex.
//   npm run check:codex-hooks              prepare: writes tmp/codex-probe/{config.toml,hooks.json} and prints next steps
//   npm run check:codex-hooks -- --run     after you trusted the probe hook: one `codex exec` (spends a model call), prints payloads
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROBE_HOME = fileURLToPath(new URL('../tmp/codex-probe', import.meta.url));

export async function prepare(dir = PROBE_HOME, realCodex = process.env.CODEX_HOME || path.join(homedir(), '.codex')) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(path.join(realCodex, 'config.toml'), path.join(dir, 'config.toml')).catch(() => {});
  const out = path.join(dir, 'payload.jsonl');
  const command = `cat >> '${out.replaceAll("'", `'\\''`)}'; printf '\\n' >> '${out.replaceAll("'", `'\\''`)}'`;
  const hooks = { hooks: Object.fromEntries(['SessionStart', 'Stop', 'SubagentStop'].map((e) => [e, [{ hooks: [{ type: 'command', command }] }]])) };
  await writeFile(path.join(dir, 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
  return { dir, out };
}

export function summarize(text) {
  const valid = [];
  const problems = [];
  for (const line of text.split('\n').filter(Boolean)) {
    let p;
    try {
      p = JSON.parse(line);
    } catch {
      problems.push('unparsable payload line');
      continue;
    }
    if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.hook_event_name !== 'string') {
      problems.push('payload line is not a hook event object');
      continue;
    }
    valid.push(`${p.hook_event_name}: ${Object.entries(p).map(([k, v]) => `${k}=${v === null ? 'null' : typeof v}`).join(', ')}`);
  }
  return { valid, problems };
}

export async function runProbe({ dir = PROBE_HOME, spawnFn = spawn, log = console.log } = {}) {
  const { out } = await prepare(dir);
  await writeFile(out, '', { mode: 0o600 });
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('codex', ['exec', 'Reply with OK'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: dir } });
    } catch {
      resolve(127);
      return;
    }
    child.on('error', () => resolve(127));
    child.on('close', (c) => resolve(c ?? 1));
  });
  const text = await readFile(out, 'utf8').catch(() => '');
  if (code !== 0) {
    log(`FAIL: codex exec exited ${code}`);
    return code || 1;
  }
  const { valid, problems } = summarize(text);
  for (const p of problems) log(p);
  if (!valid.length) {
    log('FAIL: no valid hook payload recorded in this run; were the probe hooks trusted via /hooks?');
    return 1;
  }
  for (const l of valid) log(l);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--run')) {
    console.error('usage: codex-probe.js [--run]');
    process.exitCode = 2;
  } else if (args[0] === '--run') {
    process.exitCode = await runProbe();
  } else {
    const { dir } = await prepare();
    console.log(`Prepared ${dir}. Manual step (hook trust stays yours):`);
    console.log(`  CODEX_HOME='${dir}' codex      # then run /hooks, review and trust the probe hooks, and quit`);
    console.log('Then: npm run check:codex-hooks -- --run');
  }
}
