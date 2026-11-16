// Installs or removes the pieces that live outside the repository and are not files written by `setup`.
// Dry run by default: prints the exact commands; add --apply to run them.
// Usage: node scripts/install.js launchd:load|launchd:unload|skill:install|skill:uninstall [--apply]
import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { loadDotenv } from '../src/dotenv.js';
import { BACKUP_LABEL, SCAN_LABEL, layout } from '../src/setup.js';
import { shellQuote } from '../src/shell.js';

loadDotenv();
const run = promisify(execFile);
const SKILL = fileURLToPath(new URL('../skills/retrospective', import.meta.url));

export function plan(action, { env = process.env, home, uid = process.getuid() } = {}) {
  const L = layout({ env, home });
  const claude = path.dirname(L.claudeSettings);
  const target = path.join(claude, 'skills', 'retrospective');
  const plists = [SCAN_LABEL, BACKUP_LABEL].map((label) => ({ label, file: path.join(L.launchAgents, `${label}.plist`) }));
  switch (action) {
    case 'launchd:load':
      return plists.map((p) => ({ cmd: 'launchctl', args: ['bootstrap', `gui/${uid}`, p.file] }));
    case 'launchd:unload':
      return plists.map((p) => ({ cmd: 'launchctl', args: ['bootout', `gui/${uid}/${p.label}`], tolerate: true }));
    case 'skill:install':
      return [{ link: target, to: SKILL }];
    case 'skill:uninstall':
      return [{ unlink: target, expected: SKILL }];
    default:
      throw new Error(`unknown action ${action}`);
  }
}

function describe(step) {
  if (step.cmd) return [step.cmd, ...step.args].map(shellQuote).join(' ');
  if (step.link) return `ln -s ${shellQuote(step.to)} ${shellQuote(step.link)}`;
  return `rm ${shellQuote(step.unlink)}   # only if it is the symlink to ${step.expected}`;
}

const NOT_LOADED = /No such process|Could not find service|not loaded/i;

export async function apply(step, { exec = run } = {}) {
  if (step.cmd) {
    try {
      await exec(step.cmd, step.args);
    } catch (err) {
      if (!(step.tolerate && (NOT_LOADED.test(String(err.stderr ?? '')) || err.code === 3))) throw err;
    }
  } else if (step.link) {
    await mkdir(path.dirname(step.link), { recursive: true });
    const existing = await readlink(step.link).catch(() => null);
    if (existing === step.to) return;
    await symlink(step.to, step.link);
  } else {
    const st = await lstat(step.unlink).catch(() => null);
    if (!st) return;
    if (!st.isSymbolicLink() || (await readlink(step.unlink)) !== step.expected) throw new Error(`${step.unlink} is not our symlink; left alone`);
    await rm(step.unlink);
  }
}

export const ACTIONS = ['launchd:load', 'launchd:unload', 'skill:install', 'skill:uninstall'];

export function parseCommand(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: { apply: { type: 'boolean' } }, allowPositionals: true, strict: true });
  if (positionals.length !== 1 || !ACTIONS.includes(positionals[0])) {
    throw new Error(`usage: install.js ${ACTIONS.join('|')} [--apply]`);
  }
  return { action: positionals[0], apply: Boolean(values.apply) };
}

export async function main(argv, { exec = run, log = console.log, error = console.error, env = process.env } = {}) {
  let cmd;
  try {
    cmd = parseCommand(argv);
  } catch (err) {
    error(`install: ${err.message}`);
    return 2;
  }
  try {
    for (const step of plan(cmd.action, { env })) {
      if (cmd.apply) {
        await apply(step, { exec });
        log(`ran\t${describe(step)}`);
      } else log(`would run\t${describe(step)}`);
    }
    return 0;
  } catch (err) {
    error(`install ${cmd.action}: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
