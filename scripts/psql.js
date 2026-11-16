// Opens Postgres.app psql on the endpoint the CLI uses (shell > .env > config.json > default).
// Usage: npm run psql [-- [--db NAME] psql args]   |   npm run psql:reader [-- psql args]   (read-only role)
// --db swaps only the database name, keeping host, port and user from the resolved endpoint.
import { spawn } from 'node:child_process';
import { loadDotenv } from '../src/dotenv.js';
import { databaseUrl, normalizeUrl } from '../src/db.js';
import { readerUrl, PSQL } from '../src/pointer.js';

loadDotenv();
let rest = process.argv.slice(2);
const reader = rest[0] === '--reader';
if (reader) rest = rest.slice(1);
let database = null;
if (rest[0] === '--db') {
  database = rest[1];
  rest = rest.slice(2);
}
const url = new URL(reader ? process.env.AGENT_HISTORY_READER_URL || readerUrl(databaseUrl()) : normalizeUrl(databaseUrl()));
if (database) url.pathname = `/${database}`;
const child = spawn(PSQL, [`--dbname=${url}`, ...rest], { stdio: 'inherit' });
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
