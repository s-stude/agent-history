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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dir, out } = await prepare();
  if (process.argv[2] !== '--run') {
    console.log(`Prepared ${dir}. Manual step (hook trust stays yours):`);
    console.log(`  CODEX_HOME='${dir}' codex      # then run /hooks, review and trust the probe hooks, and quit`);
    console.log('Then: npm run check:codex-hooks -- --run');
  } else {
    const child = spawn('codex', ['exec', 'Reply with OK'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: dir } });
    await new Promise((r) => child.on('close', r));
    const text = await readFile(out, 'utf8').catch(() => '');
    if (!text.trim()) console.log('No payload recorded: were the probe hooks trusted via /hooks?');
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const p = JSON.parse(line);
        console.log(`${p.hook_event_name ?? '?'}: ${Object.entries(p).map(([k, v]) => `${k}=${v === null ? 'null' : typeof v}`).join(', ')}`);
      } catch {
        console.log('unparsable payload line');
      }
    }
  }
}
