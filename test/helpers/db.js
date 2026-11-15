import { randomBytes } from 'node:crypto';
import { databaseUrl, openDb } from '../../src/db.js';

export const TEST_DB_PATTERN = /^agent_history_test_[a-z0-9_]+$/;

function urlFor(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

export function serverUrl(env = process.env) {
  return env.AGENT_HISTORY_TEST_SERVER_URL || urlFor(databaseUrl(env), 'postgres');
}

export function testDbName(label = '') {
  const suffix = label ? `${label}_` : '';
  return `agent_history_test_${suffix}${process.pid}_${randomBytes(4).toString('hex')}`;
}

export async function serverReachable(url = serverUrl()) {
  const admin = openDb(url);
  try {
    await admin.raw('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await admin.destroy();
  }
}

export async function createTestDb({ label = '', migrate = true } = {}) {
  const name = testDbName(label);
  if (!TEST_DB_PATTERN.test(name)) throw new Error(`refusing test database name ${name}`);
  const admin = openDb(serverUrl());
  try {
    await admin.raw('CREATE DATABASE ?? TEMPLATE template0', [name]);
  } finally {
    await admin.destroy();
  }
  const url = urlFor(serverUrl(), name);
  const instances = [];
  const open = (options) => {
    const db = openDb(url, options);
    instances.push(db);
    return db;
  };
  const db = open();
  if (migrate) await db.migrate.latest();
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    await Promise.all(instances.map((i) => i.destroy()));
    const admin = openDb(serverUrl());
    try {
      await admin.raw('DROP DATABASE IF EXISTS ?? WITH (FORCE)', [name]);
    } finally {
      await admin.destroy();
    }
  };
  return { name, url, db, open, drop };
}

export async function useTestDb(t, options) {
  if (!(await serverReachable())) {
    t.skip('PostgreSQL server unreachable');
    return null;
  }
  const handle = await createTestDb(options);
  t.after(handle.drop);
  return handle;
}
