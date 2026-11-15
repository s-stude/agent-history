import { fileURLToPath } from 'node:url';
import knexFactory from 'knex';

export const DEFAULT_DATABASE_URL = 'postgresql://localhost:5432/agent_history';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function databaseUrl(env = process.env) {
  return env.AGENT_HISTORY_DATABASE_URL || DEFAULT_DATABASE_URL;
}

export function knexConfig(
  connectionString,
  { connectionTimeoutMillis = 3000, statementTimeout = 30000, migrationsDirectory = MIGRATIONS_DIR } = {},
) {
  return {
    client: 'pg',
    connection: {
      connectionString,
      connectionTimeoutMillis,
      statement_timeout: statementTimeout,
      application_name: 'agent-history',
    },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: connectionTimeoutMillis + 2000,
    migrations: { directory: migrationsDirectory, loadExtensions: ['.js'] },
  };
}

export function openDb(connectionString = databaseUrl(), options) {
  return knexFactory(knexConfig(connectionString, options));
}

export async function withDb(connectionString, fn, options) {
  const db = openDb(connectionString, options);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}
