import { parseArgs } from 'node:util';
import { databaseUrl, withDb } from './db.js';
import { schemaStatus } from './schema.js';
import { migrateWithLock } from './migrate.js';
import { logLine, readStdin, runHook } from './hook.js';
import { scan } from './scan.js';
import { doctor as runDoctor } from './doctor.js';
import { exportRoot, exportSessions } from './export.js';
import { setup as runSetup } from './setup.js';
import { backup, restore } from './backup.js';
import { historyHome } from './paths.js';
import path from 'node:path';
import { buildInventory, rootsFromEnv } from './inventory.js';

const COMMANDS = {
  init: 'Create or migrate the history database',
  ingest: 'Ingest one session from hook stdin JSON',
  scan: 'Ingest every known transcript source',
  export: 'Write markdown copies of sessions',
  doctor: 'Report missing, partial and failed sources',
  setup: 'Prepare outside changes: database|cleanup-period|hooks|launchd|pointer|mirror|export; dry-run unless --apply',
  backup: 'Dump the database to ~/.agent-history/backups (keeps 8)',
  restore: 'Restore a dump into a new database: restore <dump> --to <name>',
};

export function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const lines = Object.entries(COMMANDS).map(([name, help]) => `  ${name.padEnd(width)}  ${help}`);
  return ['Usage: agent-history <command> [options]', '', 'Commands:', ...lines, ''].join('\n');
}

function noOptions(args) {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
}

async function init(args) {
  noOptions(args);
  const applied = await migrateWithLock(databaseUrl());
  console.log(`migrations applied: ${applied.length}`);
  return 0;
}

async function doctorCommand(args) {
  noOptions(args);
  return withDb(databaseUrl(), async (db) => {
    const { checks, failed } = await runDoctor(db);
    for (const c of checks) console.log(`${c.level}\t${c.check}\t${c.detail}`);
    return failed ? 1 : 0;
  });
}

async function printInventory() {
  const inv = await buildInventory(rootsFromEnv());
  for (const [key, n] of inv.counts()) console.log(`${key}\t${n}`);
  console.log(`sessions\t${inv.sessions().size}`);
  console.log(`duplicate_segments\t${inv.duplicateSegments().size}`);
  for (const kind of ['empty', 'skipped', 'unsupported', 'unreadable']) console.log(`${kind}\t${inv[kind].length}`);
  return 0;
}

async function scanCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      'dry-run': { type: 'boolean' },
      'changed-since-last': { type: 'boolean' },
      tool: { type: 'string' },
    },
    strict: true,
  });
  if (values.tool && !['claude', 'codex'].includes(values.tool)) {
    console.error('agent-history scan: --tool must be claude or codex');
    return 2;
  }
  if (values['dry-run']) return printInventory();
  return withDb(databaseUrl(), async (db) => {
    const schema = await schemaStatus(db);
    if (schema.state !== 'current') {
      console.error(`agent-history scan: schema is ${schema.state}; run agent-history init`);
      return 1;
    }
    const started = Date.now();
    const summary = await scan(db, { tool: values.tool ?? null, changedSinceLast: Boolean(values['changed-since-last']) });
    summary.seconds = Math.round((Date.now() - started) / 100) / 10;
    for (const [k, v] of Object.entries(summary)) console.log(`${k}\t${v}`);
    return summary.errors ? 1 : 0;
  });
}

async function ingest(args) {
  try {
    noOptions(args);
    const input = await readStdin();
    await runHook(input);
  } catch (err) {
    await logLine(['-', '-', err.code || err.name]).catch(() => {});
  }
  return 0;
}

async function exportCommand(args) {
  const { values } = parseArgs({
    args,
    options: { session: { type: 'string', multiple: true }, out: { type: 'string' } },
    strict: true,
  });
  return withDb(databaseUrl(), async (db) => {
    const files = await exportSessions(db, { root: values.out ?? exportRoot(), sessionIds: values.session ?? null });
    console.log(`exported\t${files.length}`);
    return 0;
  });
}

const SETUP_TARGETS = ['database', 'cleanup-period', 'hooks', 'launchd', 'pointer', 'mirror', 'export'];

async function setupCommand(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { apply: { type: 'boolean' }, home: { type: 'string' }, 'roles-only': { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  });
  const [what] = positionals;
  if (!SETUP_TARGETS.includes(what) || positionals.length !== 1) {
    console.error(`agent-history setup: target must be one of ${SETUP_TARGETS.join(', ')}`);
    return 2;
  }
  await runSetup(what, { apply: Boolean(values.apply), home: values.home, rolesOnly: Boolean(values['roles-only']) });
  return 0;
}

async function backupCommand(args) {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' } }, strict: true });
  const r = await backup(databaseUrl(), values.dir ?? path.join(historyHome(), 'backups'));
  console.log(`backup\t${r.file}`);
  for (const old of r.removed) console.log(`removed\t${old}`);
  return 0;
}

async function restoreCommand(args) {
  const { values, positionals } = parseArgs({ args, options: { to: { type: 'string' } }, allowPositionals: true, strict: true });
  if (positionals.length !== 1 || !values.to) {
    console.error('agent-history restore: usage: restore <dump> --to <new database name>');
    return 2;
  }
  const r = await restore(positionals[0], { serverUrl: databaseUrl(), database: values.to });
  console.log(`restored\t${values.to}\tmigrations applied ${r.migrationsApplied}${r.freedLock ? '\tfreed stale migration lock' : ''}`);
  console.log(`next: AGENT_HISTORY_DATABASE_URL=<url of ${values.to}> agent-history doctor`);
  return 0;
}

const HANDLERS = {
  init,
  doctor: doctorCommand,
  scan: scanCommand,
  ingest,
  export: exportCommand,
  setup: setupCommand,
  backup: backupCommand,
  restore: restoreCommand,
};

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: false,
  });
  const [command] = positionals;
  const leading = command ? argv.slice(0, argv.indexOf(command)) : argv;
  const badLeading = leading.find((a) => a !== '--help' && a !== '-h');
  if (badLeading && !values.help) {
    console.error(`agent-history: unknown option before the command: ${badLeading}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!command || !(command in COMMANDS)) {
    process.stderr.write(usage());
    return 2;
  }
  const handler = HANDLERS[command];
  if (!handler) {
    console.error(`agent-history ${command}: not implemented yet`);
    return 2;
  }
  try {
    return await handler(argv.slice(argv.indexOf(command) + 1));
  } catch (err) {
    if (err.code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`agent-history ${command}: ${err.message}`);
      return 2;
    }
    console.error(`agent-history ${command}: ${err.code || err.name}: ${err.message}`);
    return 1;
  }
}
