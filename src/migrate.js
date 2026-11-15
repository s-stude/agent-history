import { openDb } from './db.js';

export const INIT_LOCK_KEY = 7_420_001;

export class NewerSchemaError extends Error {
  name = 'NewerSchemaError';
}

export async function migrateWithLock(url, options = {}) {
  const db = openDb(url, options);
  try {
    return await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [INIT_LOCK_KEY]);
      try {
        const [, applied] = await trx.migrate.latest();
        return applied;
      } catch (err) {
        if (/migration directory is corrupt/.test(err.message)) {
          throw new NewerSchemaError(`database has migrations this code does not know: ${err.message.split(': ').at(-1)}`);
        }
        throw err;
      }
    });
  } finally {
    await db.destroy();
  }
}
