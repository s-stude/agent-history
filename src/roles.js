export const READER_ROLE = 'agent_history_reader';

function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

export function readerRoleSql({ database = 'agent_history', role = READER_ROLE, owner } = {}) {
  const r = ident(role);
  const d = ident(database);
  const defaults = owner ? `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT SELECT ON TABLES TO ${r}` : `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${r}`;
  return [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${r} LOGIN; END IF; END $$`,
    `ALTER ROLE ${r} SET default_transaction_read_only = on`,
    `GRANT CONNECT ON DATABASE ${d} TO ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${r}`,
    defaults,
  ];
}
