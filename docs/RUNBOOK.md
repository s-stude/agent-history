# Runbook: turning on agent history on this Mac

Everything below changes things outside the repository, so it is yours to run. Each step says how to check it and how to undo it. Every step is an `npm run …` script, run from the repository root. `setup:*` scripts are dry runs; add `-- --apply` to write. With `--apply`, any file that changes is first backed up to `<file>.bak-<timestamp>`.

## 0. Prepare

```sh
cd /Users/ahalilov/Documents/projects/harness-sessions-postgres
nvm use 22.22.0          # the node that runs setup is recorded for hooks and launchd (already allowed in Postgres.app)
npm ci
cp .env.example .env     # then edit if you need a non-default endpoint, history home or transcript roots
```

Postgres.app 18 must be running (it starts at login).

**Where settings come from**, highest first:
1. The shell environment.
2. `.env` in the repository (git-ignored; `.env.example` lists every variable).
3. `~/.agent-history/config.json`, written by `npm run setup:database|setup:hooks|setup:launchd`.
4. Defaults.

Hooks and launchd jobs run the CLI from this repository, so they read the same `.env`. Variables are prefixed (`AGENT_HISTORY_DATABASE_URL`, not `DATABASE_URL`) because hooks run inside the agent's shell, where another project's `DATABASE_URL` may be set.

Transcript roots resolve as `AGENT_HISTORY_*` variables (shell or `.env`), then `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, then the saved config, then `~/.claude` / `~/.codex`. Passwords belong in `~/.pgpass` (0600), never in `.env` or the config.

## Snapshot your agent config first

Before anything changes, keep a copy of everything setup can touch: `~/.claude/settings.json` (hooks and `cleanupPeriodDays`), `~/.codex/hooks.json`, `CLAUDE.md`, `AGENTS.md` and the agent-history launchd plists.

```sh
npm run backup:agent-config
```

It writes them to `~/.agent-history/config-backups/<timestamp>/` (folder 0700, files 0600) with a `manifest.json`, and prints a `cp …` restore command per file. Each run makes a new folder; nothing is overwritten. On top of this, every `setup … -- --apply` also saves the previous version of a file it changes as `<file>.bak-<timestamp>` next to it.

## 1. Stop Claude Code from deleting old transcripts — do this first

```sh
npm run setup:cleanup-period               # shows the new ~/.claude/settings.json
npm run setup:cleanup-period -- --apply
```

- Check: `jq .cleanupPeriodDays ~/.claude/settings.json` prints `36500`; the `*.jsonl` count in `~/.claude/projects` does not drop after you start a new `claude` session.
- Undo: restore `~/.claude/settings.json.bak-<timestamp>`.

Optional private raw copy of all transcripts (unredacted, kept 0700, keep it out of cloud sync):

```sh
npm run setup:mirror                       # prints the rsync commands
npm run setup:mirror -- --apply
```

- Check: file counts per folder match the sources; `stat -f %Lp ~/.agent-history/raw` prints `700`.
- Undo: `rm -rf ~/.agent-history/raw`.

## 2. Create the database and the read-only role

```sh
npm run setup:database                     # prints the SQL
npm run setup:database -- --apply          # creates agent_history, migrates, creates agent_history_reader, writes config.json
npm run doctor                             # expect "ok schema current" and "ok reader_role ok"
```

- Check that the reader can read but not write:
  ```sh
  npm run psql:reader -- -c 'SELECT current_user, count(*) FROM sessions'
  npm run psql:reader -- -c "INSERT INTO sessions (id, tool, native_id) VALUES ('x','x','x')"   # must fail
  ```
- Postgres.app may show its permission dialog the first time `psql`, `pg_dump` or `node` connects. Click **Allow** for each.
- Undo: `npm run backup` if it holds data, then `npm run psql -- --db postgres -c 'DROP DATABASE agent_history' -c 'DROP ROLE agent_history_reader'`.

## 3. Backfill all existing transcripts

```sh
npm run scan:dry                           # counts per tool, nothing written
npm run scan                               # the backfill
npm run psql -- -c 'ANALYZE'
npm run doctor
```

- Expect, from the trial on a throwaway database (Nov 16): about 3–4 minutes, ~860 MB database, 0 errors. `doctor` should show no `fail` lines.
- Re-running is safe: finished sources are skipped. `npm run scan:changed` is the fast catch-up.
- Undo: drop and recreate the database (step 2).

## 4. Hooks and the 15-minute recovery scan

```sh
npm run backup:agent-config                # fresh snapshot right before the hooks change
npm run setup:hooks                        # shows ~/.claude/settings.json and ~/.codex/hooks.json after the merge
npm run setup:hooks -- --apply
npm run setup:launchd -- --apply            # writes the two plists
npm run launchd:load                        # shows the launchctl bootstrap commands
npm run launchd:load -- --apply             # loads the 15-minute scan and the weekly backup
```

- **Claude Code:** `Stop` and `SubagentStop` run `ingest` (async), and `SessionStart` runs `scan --changed-since-last`. Your other hooks are kept.
- **Codex:** open Codex, run `/hooks`, then review and trust the three new hooks (manual: trust is your decision). Before relying on them, record the real payload once in an isolated home under `./tmp` (your `~/.codex` is not touched):
  ```sh
  npm run check:codex-hooks                   # prepares tmp/codex-probe and prints the manual trust step
  CODEX_HOME="$PWD/tmp/codex-probe" codex     # run /hooks, trust the probe hooks, quit
  npm run check:codex-hooks -- --run          # one codex exec (one model call); prints each payload's field names and types
  ```
  Check that `session_id`, `transcript_path`, `turn_id` and `last_assistant_message` are present (or note which are null).
- **Capture,** in a real interactive session. One-shot `claude -p` and `codex exec` runs cancel unfinished async hooks at exit, so they can't prove capture.
  ```sh
  npm run check:capture:claude      # starts claude with a known session id and a random-word prompt
  npm run check:capture:codex       # starts codex; the session is found by its rollout containing the word
  ```
  Let the agent answer, then exit the session normally. `PASS` means a final, non-provisional row equal to the word appeared in exactly that session within 60 s of the answer. Your preparation time is not counted.
- **Subagents:** run one subagent task in each tool, then
  `npm run psql -- -c "SELECT id, parent_id, agent_id FROM sessions WHERE parent_id IS NOT NULL ORDER BY updated_at DESC LIMIT 5"`.
- **Recovery:** kill a session mid-turn, exit right after a turn, and run one turn with Postgres.app stopped (then start it again). Within 15 minutes of the server coming back, `npm run doctor` exits 0 and all three turns are in the database.
- **launchd permissions:** after the scan job's first run, `~/.agent-history/com.agent-history.scan.err.log` should be empty, and `npm run doctor` should show no `log_after_last_ingest` warning. If Postgres.app denied the connection, open Postgres.app → Settings → App Permissions and allow the recorded node.
- **Overhead:** no tool here measures the foreground dispatch/return cost of the installed async hook, because neither agent exposes those timings. The 50 ms acceptance check therefore stays open. Run `npm run check:overhead -- <some transcript.jsonl> 10` for unbudgeted diagnostics: shell spawn (~5 ms here) and background worker latency (~90 ms here). Adding `--dispatch` measures answer-to-probe-start (10 model calls); `--e2e` adds hooks on/off `claude -p` medians (20 model calls). If hooks ever feel slow, compare an interactive session with and without them (`claude --settings` with `{"disableAllHooks": true}`).
- **Undo:** run the `cp …` restore commands printed by `backup:agent-config` (or restore the `.bak-` files of `~/.claude/settings.json` and `~/.codex/hooks.json`). Run `npm run launchd:unload -- --apply`, then delete the two plists in `~/Library/LaunchAgents`.

## 5. Tell the agents where history lives

```sh
npm run setup:export -- --apply            # optional: markdown copies in ~/.agent-history/md
npm run setup:pointer                      # shows the block for ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
npm run setup:pointer -- --apply           # inserted between markers; rerun to update, delete the marked block to remove
```

- **Recall test:** write 10 questions from real history, with the expected session ids, in `tests/private/recall_cases.md` (git-ignored, `chmod 600`). Ask each in a fresh session, noting the queries used and whether the right session came back. The target is 8 of 10 within 3 queries; if below, ask for a `/recall` skill.
- **Undo:** restore the `.bak-` files or delete the marked block.

## 6. Retrospective skill

```sh
npm run skill:install                       # shows the symlink it would create
npm run skill:install -- --apply
```

- Run it in a fresh session: "run a retrospective of <project> for the last 30 days".
- Check by hand that every decision and reversal is backed by the quoted text in the cited session, and that later reversals supersede earlier decisions.
- Undo: `npm run skill:uninstall -- --apply` (removes the link only if it points to this repository's skill).

## 7. Backups and Postgres.app upgrades

- Weekly dumps come from the launchd job in step 4. Run one now with `npm run backup`. Files go to `~/.agent-history/backups/<timestamp>.dump` (0600), and the newest 8 are kept.
- Test a restore into a new database, never over the live one:
  ```sh
  npm run restore -- ~/.agent-history/backups/<newest>.dump --to agent_history_restore_check
  AGENT_HISTORY_DATABASE_URL=postgresql://localhost:5432/agent_history_restore_check npm run doctor
  npm run psql -- --db postgres -c 'DROP DATABASE agent_history_restore_check'
  ```
- Postgres.app major upgrade (a new major version starts with an empty data directory):
  1. `npm run backup` on the old server.
  2. Start the new server in Postgres.app.
  3. `npm run setup:roles -- --apply`
  4. `npm run restore -- <dump> --to agent_history`
  5. `npm run doctor`
- After a week of normal use, `npm run doctor` should exit 0.
- **Retention proof:** once the oldest ingested transcript has actually been deleted by Claude Code's cleanup, search for a phrase from it and record the result in the design doc. To exercise cleanup safely now:
  1. Make an isolated `CLAUDE_CONFIG_DIR` holding an aged copy of one transcript (`touch -t 202601010000 <file>`).
  2. Set `cleanupPeriodDays` to 1 there.
  3. Start `claude` with that config dir.
  4. Confirm the file is gone while its rows are still searchable.

## Script reference

| Script | Runs |
| --- | --- |
| `npm run init` / `doctor` / `scan` / `scan:changed` / `scan:dry` / `export` / `backup` / `restore -- <dump> --to <db>` | the CLI command of the same name |
| `npm run setup:<target>` (`cleanup-period`, `mirror`, `database`, `roles`, `hooks`, `launchd`, `export`, `pointer`) | `setup <target>`, dry run; add `-- --apply` |
| `npm run launchd:load` / `launchd:unload` | `launchctl bootstrap` / `bootout` for both jobs; dry run, add `-- --apply` |
| `npm run skill:install` / `skill:uninstall` | retrospective skill symlink in `~/.claude/skills`; dry run, add `-- --apply` |
| `npm run check:codex-hooks [-- --run]` | Codex hook payload probe in `tmp/codex-probe` (trust step stays manual) |
| `npm run backup:agent-config` | snapshot of agent settings, hooks, CLAUDE.md/AGENTS.md and plists into `~/.agent-history/config-backups/` |
| `npm run psql [-- [--db NAME] args]` / `psql:reader [-- args]` | Postgres.app `psql` on the resolved endpoint, as owner / read-only role; `--db` swaps only the database name |
| `npm run check:capture:claude` / `check:capture:codex` / `check:overhead` / `check:redaction` / `check:doctor` | live checks and diagnostics |
| `npm run ah -- <command>` | any other CLI command |
| `npm test` | test suite (ignores `.env`; uses throwaway databases) |
