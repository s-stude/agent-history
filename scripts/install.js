// Installs or removes the pieces that live outside the repository and are not files written by `setup`.
// Dry run by default: prints the exact commands; add --apply to run them.
// Usage: node scripts/install.js launchd:load|launchd:unload|skill:install|skill:uninstall [--apply]
import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

async function apply(step) {
  if (step.cmd) {
    try {
      await run(step.cmd, step.args);
    } catch (err) {
      if (!step.tolerate) throw err;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, flag] = process.argv.slice(2);
  const doApply = flag === '--apply';
  try {
    for (const step of plan(action)) {
      if (doApply) {
        await apply(step);
        console.log(`ran\t${describe(step)}`);
      } else console.log(`would run\t${describe(step)}`);
    }
  } catch (err) {
    console.error(`install ${action}: ${err.message}`);
    process.exitCode = 1;
  }
}
