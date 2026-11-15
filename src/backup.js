import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { normalizeUrl, openDb } from './db.js';
import { migrateWithLock } from './migrate.js';
import { READER_ROLE } from './roles.js';

const run = promisify(execFile);
export const PG_BIN = '/Applications/Postgres 18.app/Contents/Versions/latest/bin';
export const KEEP_BACKUPS = 8;
const DUMP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.dump$/;

function stamp(now = new Date()) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
}

export async function backup(url, dir, { now = new Date(), keep = KEEP_BACKUPS, pgBin = PG_BIN } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const final = path.join(dir, `${stamp(now)}.dump`);
  const tmp = `${final}.partial`;
  try {
    await run(path.join(pgBin, 'pg_dump'), ['-Fc', `--dbname=${normalizeUrl(url)}`, '-f', tmp]);
    await chmod(tmp, 0o600);
    await rename(tmp, final);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new Error(`pg_dump failed (${err.code ?? 'error'})`);
  }
  const dumps = (await readdir(dir)).filter((n) => DUMP_NAME.test(n)).sort();
  const removed = [];
  for (const old of dumps.slice(0, Math.max(0, dumps.length - keep))) {
    await rm(path.join(dir, old));
    removed.push(old);
  }
  return { file: final, removed };
}

function withDatabase(url, database) {
  const u = new URL(normalizeUrl(url));
  u.pathname = `/${database}`;
  return u.toString();
}

export async function restore(dumpFile, { serverUrl, database, pgBin = PG_BIN }) {
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error(`unsafe database name: ${database}`);
  const admin = openDb(withDatabase(serverUrl, 'postgres'));
  try {
    const exists = await admin('pg_database').where({ datname: database }).first();
    if (exists) throw new Error(`database ${database} already exists; restore only into a new database`);
    const { stdout: toc } = await run(path.join(pgBin, 'pg_restore'), ['-l', dumpFile], { maxBuffer: 64 * 1024 * 1024 });
    if (toc.includes(READER_ROLE) && !(await admin('pg_roles').where({ rolname: READER_ROLE }).first())) {
      throw new Error(`dump grants to ${READER_ROLE}, which does not exist here; run: agent-history setup database --roles-only --apply`);
    }
    await admin.raw('CREATE DATABASE ?? TEMPLATE template0', [database]);
  } finally {
    await admin.destroy();
  }
  const target = withDatabase(serverUrl, database);
  await run(path.join(pgBin, 'pg_restore'), ['--exit-on-error', '--single-transaction', `--dbname=${target}`, dumpFile]);
  const db = openDb(target);
  let freedLock = false;
  try {
    const lock = await db('knex_migrations_lock').first().catch(() => null);
    if (lock?.is_locked) {
      await db.migrate.forceFreeMigrationsLock();
      freedLock = true;
    }
  } finally {
    await db.destroy();
  }
  const applied = await migrateWithLock(target);
  return { url: target, freedLock, migrationsApplied: applied.length };
}
