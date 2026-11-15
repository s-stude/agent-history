import { readdir } from 'node:fs/promises';
import { MIGRATIONS_DIR } from './db.js';

export async function migrationFiles(dir = MIGRATIONS_DIR) {
  const names = await readdir(dir);
  return names.filter((n) => n.endsWith('.js')).sort();
}

export async function schemaStatus(db, dir = MIGRATIONS_DIR) {
  const known = await migrationFiles(dir);
  const { rows } = await db.raw('SELECT to_regclass(?) AS t', ['public.knex_migrations']);
  if (!rows[0].t) return { state: 'uninitialized', applied: [], pending: known, unknown: [] };
  const applied = (await db('knex_migrations').select('name').orderBy('id')).map((r) => r.name);
  const appliedSet = new Set(applied);
  const knownSet = new Set(known);
  const pending = known.filter((n) => !appliedSet.has(n));
  const unknown = applied.filter((n) => !knownSet.has(n));
  const state = unknown.length ? 'newer' : pending.length ? 'pending' : 'current';
  return { state, applied, pending, unknown };
}
