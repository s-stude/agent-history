# Runbook: turning on agent history on this Mac

Everything below changes things outside the repository, so it is yours to run. Each step says how to check it and how to undo it. `agent-history setup …` is a dry run unless you add `--apply`; with `--apply` it backs up any file it changes to `<file>.bak-<timestamp>`.

Shorthands used below (paste into your shell first):

```sh
REPO=/Users/ahalilov/Documents/projects/harness-sessions-postgres
NODE=/Users/ahalilov/.nvm/versions/node/v22.22.0/bin/node
AH() { "$NODE" --max-old-space-size=192 "$REPO/bin/agent-history" "$@"; }
PGBIN="/Applications/Postgres 18.app/Contents/Versions/latest/bin"
```

Postgres.app 18 must be running (it starts at login). `cd "$REPO" && npm ci` once.

Where the CLI finds its settings: environment variables first (`AGENT_HISTORY_DATABASE_URL`, `AGENT_HISTORY_*` roots), then `~/.agent-history/config.json` (written by `setup database|hooks|launchd`: endpoint without password, transcript roots, node path), then defaults. launchd jobs get `AGENT_HISTORY_HOME` in their plist so they read the same config. If your endpoint needs a password, put it in `~/.pgpass` (0600), never in the config.

## 1. Stop Claude Code from deleting old transcripts (Task 1) — do this first

```sh
AH setup cleanup-period            # shows the new settings.json
AH setup cleanup-period --apply
```

- Check: `jq .cleanupPeriodDays ~/.claude/settings.json` prints `36500`; the `*.jsonl` count in `~/.claude/projects` does not drop after you start a new `claude` session.
- Undo: restore `~/.claude/settings.json.bak-<timestamp>`.

Optional private raw copy of all transcripts (unredacted, kept 0700, keep it out of cloud sync):

```sh
AH setup mirror            # prints the rsync commands
AH setup mirror --apply
```

- Check: file counts per folder match the sources; `stat -f %Lp ~/.agent-history/raw` prints `700`.
- Undo: `rm -rf ~/.agent-history/raw`.

## 2. Create the database and the read-only role

```sh
AH setup database           # prints the SQL
AH setup database --apply   # creates agent_history, migrates, creates agent_history_reader, writes ~/.agent-history/config.json
```

- Check:
  - `AH doctor` shows `ok schema current` and `ok reader_role ok`.
  - Reader can read but not write:
    ```sh
    "$PGBIN/psql" --dbname=postgresql://agent_history_reader@localhost:5432/agent_history -c 'SELECT count(*) FROM sessions'
    "$PGBIN/psql" --dbname=postgresql://agent_history_reader@localhost:5432/agent_history -c "INSERT INTO sessions (id, tool, native_id) VALUES ('x','x','x')"   # must fail
    ```
    and `SELECT current_user` through that URL prints `agent_history_reader`.
- Postgres.app may show its permission dialog for `psql`, `pg_dump` and `node` the first time each connects. Click **Allow** for the Postgres.app `psql` and `pg_dump` and for `$NODE` (already allowed on this Mac).
- Undo: `AH backup` first if it holds data, then `"$PGBIN/dropdb" agent_history` and `"$PGBIN/psql" -d postgres -c 'DROP ROLE agent_history_reader'`.

## 3. Backfill all existing transcripts (Task 9)

```sh
/usr/bin/time -l "$NODE" --max-old-space-size=192 "$REPO/bin/agent-history" scan
"$PGBIN/psql" -d agent_history -c 'ANALYZE'
AH doctor
```

- Expect (trial on a throwaway DB, Nov 16): about 3–4 minutes, ~860 MB database, 0 errors. `doctor` should show no `fail` lines.
- Re-running `scan` is safe: finished sources are skipped.
- Undo: drop and recreate the database (step 2).

## 4. Hooks and the 15-minute recovery scan (Task 11)

```sh
AH setup hooks             # shows ~/.claude/settings.json and ~/.codex/hooks.json after the merge
AH setup hooks --apply
AH setup launchd --apply
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-history.scan.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-history.backup.plist
```

- Claude Code: `Stop` and `SubagentStop` run `ingest` (async); `SessionStart` runs `scan --changed-since-last`. Other hooks you have are kept.
- Codex: open Codex, run `/hooks`, review and trust the three new hooks. Before relying on them, probe the real payload once in an isolated home:
  ```sh
  mkdir -p /tmp/codex-probe && cp ~/.codex/config.toml /tmp/codex-probe/ 2>/dev/null
  cat > /tmp/codex-probe/hooks.json <<'JSON'
  {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"cat >> /tmp/codex-probe/payload.jsonl"}]}]}}
  JSON
  CODEX_HOME=/tmp/codex-probe codex exec "say hi"; cat /tmp/codex-probe/payload.jsonl
  ```
  Check that `session_id`, `transcript_path`, `turn_id` and `last_assistant_message` are present (or note which are null), and that the `hooks.json` shape above is the one Codex 0.163 reads.
- Check capture in a real interactive session (one-shot `claude -p` / `codex exec` cancel unfinished async hooks at exit, so they cannot prove capture):
  ```sh
  "$REPO/scripts/capture-check.sh" claude   # prints a prompt with a random word; send it in an interactive claude session
  "$REPO/scripts/capture-check.sh" codex    # same for codex
  ```
  Each must print `PASS: captured in <session id>`: a final, non-provisional answer equal to the word, in a session updated after the script started.
- Check subagents: run one subagent task in each tool, then
  `"$PGBIN/psql" -d agent_history -c "SELECT id, parent_id, agent_id FROM sessions WHERE parent_id IS NOT NULL ORDER BY updated_at DESC LIMIT 5"`.
- Check recovery: kill a session mid-turn; exit right after a turn; and run one turn with Postgres.app stopped (then start it). Within 15 minutes of the server being back, `AH doctor` exits 0 and all three turns are in the DB.
- Check the launchd job connects without a permission prompt: after its first run, `~/.agent-history/com.agent-history.scan.err.log` is empty and `AH doctor` shows no `log_after_last_ingest` warning. If Postgres.app denied it, open Postgres.app → Settings → App Permissions and allow `$NODE`.
- Overhead: `"$REPO/scripts/overhead.sh" <some transcript.jsonl> 10` reports (1) dispatch: background fork/exec of the hook command and return, compared with the 50 ms budget; (2) worker latency: the full run, which happens in the background. `--e2e` adds `claude -p` medians with hooks on vs off as an observation only (spends 20 model calls; model/network noise dominates). Dry run on this Mac: dispatch ~5 ms, worker ~90 ms.
- Undo: restore the `.bak-` files of `~/.claude/settings.json` and `~/.codex/hooks.json`; `launchctl bootout gui/$(id -u)/com.agent-history.scan` (and `.backup`), then delete the two plists.

## 5. Tell the agents where history lives (Task 13)

```sh
AH setup export --apply     # optional: markdown copies in ~/.agent-history/md
AH setup pointer            # shows the block for ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
AH setup pointer --apply    # inserted between markers; rerun to update, delete the marked block to remove
```

- Recall test: write 10 questions from real history with the expected session ids in `tests/private/recall_cases.md` (git-ignored, `chmod 600`). Ask each in a fresh session; note the queries used and whether the right session came back. Target: 8 of 10 within 3 queries. If below, ask for a `/recall` skill.
- Undo: restore the `.bak-` files or delete the marked block.

## 6. Retrospective skill (Task 14)

```sh
ln -s "$REPO/skills/retrospective" ~/.claude/skills/retrospective
```

- Run in a fresh session: "run a retrospective of <project> for the last 30 days".
- Check by hand that every decision and reversal is backed by the quoted text in the cited session, and later reversals supersede earlier decisions.
- Undo: `rm ~/.claude/skills/retrospective`.

## 7. Backups and Postgres.app upgrades (Task 15)

- Weekly dumps come from the launchd job in step 4; run one now: `AH backup`. Files: `~/.agent-history/backups/<timestamp>.dump` (0600), the newest 8 kept.
- Test a restore (into a new database, never over the live one):
  ```sh
  AH restore ~/.agent-history/backups/<newest>.dump --to agent_history_restore_check
  AGENT_HISTORY_DATABASE_URL=postgresql://localhost:5432/agent_history_restore_check AH doctor
  "$PGBIN/dropdb" agent_history_restore_check
  ```
- Postgres.app major upgrade (a new major version starts with an empty data directory):
  1. `AH backup` on the old server.
  2. Start the new server in Postgres.app.
  3. `AH setup database --roles-only --apply`
  4. `AH restore <dump> --to agent_history`
  5. `AH doctor`
- Check after a week of normal use: `AH doctor` exits 0.
- Retention proof: once the oldest ingested transcript has actually been deleted by Claude Code's cleanup (or the 30-day window has passed), search for a phrase from it and record the result in the design doc. To exercise cleanup safely now, use an isolated `CLAUDE_CONFIG_DIR` with an aged copy of one transcript (`touch -t 202601010000 <file>`), set `cleanupPeriodDays` to 1 there, start `claude` with that config dir, and confirm the file is gone while its rows are still searchable.
