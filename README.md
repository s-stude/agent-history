# agent-history

Permanent, searchable store of Claude Code and Codex sessions in a local PostgreSQL database (Postgres.app).

Design: [docs/Persistent Agent Session Memory — Design Plan.md](docs/Persistent%20Agent%20Session%20Memory%20—%20Design%20Plan.md) · Tasks: [docs/plans/persistent-agent-session-memory.md](docs/plans/persistent-agent-session-memory.md)

## Install

Requires Node.js 22.15+ and a running PostgreSQL server (Postgres.app 18 on `localhost:5432` on this machine). Run from the repository root:

```bash
npm ci
npm test
```

`.npmrc` pins the npm cache to `tmp/npm-cache` (resolved from the current directory, so run npm from the repo root). Tests create and drop their own `agent_history_test_*` databases and never touch `agent_history`.

## Configuration

- `AGENT_HISTORY_DATABASE_URL`: database endpoint, default `postgresql://localhost:5432/agent_history`.
- `AGENT_HISTORY_TEST_SERVER_URL`: maintenance DB used by tests to create and drop test databases, default: the endpoint above with database `postgres`.

## Absolute paths for hooks and launchd

Hooks and launchd jobs call the CLI by absolute path, never through `PATH`:

- node: `/Users/ahalilov/.nvm/versions/node/v22.22.0/bin/node` (already allowed in Postgres.app's permission dialog)
- CLI: `/Users/ahalilov/Documents/projects/harness-sessions-postgres/bin/agent-history`
- Postgres.app client tools: `/Applications/Postgres 18.app/Contents/Versions/latest/bin` (the `psql` on `PATH` is Homebrew 16)
