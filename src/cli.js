import { parseArgs } from 'node:util';
import { databaseUrl, withDb } from './db.js';
import { schemaStatus } from './schema.js';
import { buildInventory, rootsFromEnv } from './inventory.js';

const COMMANDS = {
  init: 'Create or migrate the history database',
  ingest: 'Ingest one session from hook stdin JSON',
  scan: 'Ingest every known transcript source',
  export: 'Write markdown copies of sessions',
  doctor: 'Report missing, partial and failed sources',
  setup: 'Prepare outside changes (database, hooks, launchd, pointer); dry-run by default',
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
  await withDb(databaseUrl(), async (db) => {
    const [, applied] = await db.migrate.latest();
    console.log(`migrations applied: ${applied.length}`);
  });
  return 0;
}

async function doctor(args) {
  noOptions(args);
  await withDb(databaseUrl(), async (db) => {
    const { rows } = await db.raw('SELECT current_setting(?) AS version, current_database() AS database', ['server_version']);
    const schema = await schemaStatus(db);
    console.log(`server\t${rows[0].version}`);
    console.log(`database\t${rows[0].database}`);
    console.log(`schema\t${schema.state} (${schema.applied.length} applied, ${schema.pending.length} pending, ${schema.unknown.length} unknown)`);
  });
  return 0;
}

async function scan(args) {
  const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } }, strict: true });
  if (!values['dry-run']) {
    console.error('agent-history scan: only --dry-run is implemented yet');
    return 2;
  }
  const inv = await buildInventory(rootsFromEnv());
  for (const [key, n] of inv.counts()) console.log(`${key}\t${n}`);
  console.log(`sessions\t${inv.sessions().size}`);
  console.log(`duplicate_segments\t${inv.duplicateSegments().size}`);
  for (const kind of ['empty', 'skipped', 'unsupported', 'unreadable']) console.log(`${kind}\t${inv[kind].length}`);
  return 0;
}

const HANDLERS = { init, doctor, scan };

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: false,
  });
  const [command] = positionals;
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
