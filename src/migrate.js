import { openDb } from './db.js';

export const INIT_LOCK_KEY = 7_420_001;

export class NewerSchemaError extends Error {
  name = 'NewerSchemaError';
}

export async function migrateWithLock(url, options = {}) {
  const lockDb = openDb(url, options);
  const db = openDb(url, options);
  let conn;
  let lockLost = null;
  try {
    conn = await lockDb.client.acquireConnection();
    conn.on('error', (err) => {
      lockLost = err;
    });
    await lockDb.raw('SELECT pg_advisory_lock(?)', [INIT_LOCK_KEY]).connection(conn);
    let applied;
    try {
      [, applied] = await db.migrate.latest();
    } catch (err) {
      if (/migration directory is corrupt/.test(err.message)) {
        throw new NewerSchemaError(`database has migrations this code does not know: ${err.message.split(': ').at(-1)}`);
      }
      throw err;
    }
    if (lockLost) throw new Error(`init lock connection lost: ${lockLost.message}`);
    await lockDb.raw('SELECT pg_advisory_unlock(?)', [INIT_LOCK_KEY]).connection(conn);
    return applied;
  } finally {
    if (conn) await lockDb.client.releaseConnection(conn);
    await Promise.all([db.destroy(), lockDb.destroy()]);
  }
}
