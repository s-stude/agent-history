# Plan: Persistent Agent Session Memory

Design: [Design Plan](../Persistent%20Agent%20Session%20Memory%20—%20Design%20Plan.md) · [Proposal](../Persistent%20Agent%20Session%20Memory%20—%20Proposal.md)

Rule for every task: destructive tests (corruption, cleanup, moved or replaced files) run against isolated test homes and DBs under `./tmp/`, never against `~/.claude`, `~/.codex` or `~/.agent-history`.

## Run scope (decided by the user, 2026-11-16)

- Repo only during implementation. Nothing outside the repo is written: no `~/.claude/settings.json`, `~/.codex/hooks.json`, launchd, `CLAUDE.md` / `AGENTS.md` or `~/.agent-history` changes.
- Every outside step is prepared as an `agent-history setup …` command (dry-run by default, `--apply` writes with a backup) plus a runbook, `docs/RUNBOOK.md`, for the user to run.
- Live agent runs (capture, overhead, recall questions, retrospective) are left to the user with exact commands.
- Reading `~/.claude` and `~/.codex` read-only for inventory and parser checks is allowed. A trial backfill of real data goes to `./tmp/` (git-ignored, 0600) and is deleted after measuring.

Items marked **(user)** below are prepared but not run.

## Validation Commands
- `python3 -m pytest -q`
- `agent-history --help`
- `agent-history doctor`

### Task 1: Safety net against transcript cleanup
- [ ] **(user)** Confirm in Claude Code docs that `cleanupPeriodDays: 0` does not disable transcripts; then set `"cleanupPeriodDays": 36500` in `~/.claude/settings.json`
- [ ] **(user)** Optionally mirror raw transcripts to `~/.agent-history/raw/` (`claude/`, `codex/sessions/`, `codex/archived_sessions/`); create `~/.agent-history` and `raw/` with mode 0700; keep out of cloud sync
- [ ] **(user)** Verify `jq .cleanupPeriodDays ~/.claude/settings.json` prints 36500
- [ ] **(user)** Verify the `*.jsonl` count in `~/.claude/projects` does not drop after starting a new `claude` session
- [ ] **(user)** If mirrored, verify per-tool file counts (`.jsonl` and `.jsonl.zst`) match source and `stat -f %Lp ~/.agent-history/raw` prints 700

### Task 2: Project skeleton and install
- [ ] Create `agent_history/` package with `__main__.py`, `cli.py`, `db.py`, `inventory.py`, `redact.py`, `ingest.py`, `parsers/claude.py`, `parsers/codex.py`
- [ ] Add CLI subcommands `init`, `ingest`, `scan`, `export`, `doctor` (stubs)
- [ ] Add `pyproject.toml`: `requires-python = ">=3.14"`, stdlib only, `agent-history` console script, pytest as dev dependency
- [ ] Install with `python3 -m pip install --user -e .` (or `pipx install -e .`); record the absolute interpreter and `agent-history` paths in the README for hooks and launchd
- [ ] Add `.gitignore`: `*.db`, `*.db-wal`, `*.db-shm`, `*.db-journal`, `tmp/`, `__pycache__/`, `.peer-chats/`, `tests/private/`
- [ ] Add a CLI smoke test (`--help` exits 0 and lists all subcommands) so pytest never collects zero tests
- [ ] Verify `agent-history --help` runs from a fresh shell and pytest passes

### Task 3: Source inventory and identity contract
- [ ] Inventory roots: `~/.claude/projects` (main and `*/subagents/*.jsonl`), `~/.codex/sessions` and `~/.codex/archived_sessions` (`.jsonl` and `.jsonl.zst`); roots overridable for tests
- [ ] Read `.zst` with `compression.zstd.open` as a stream
- [ ] Define session identity: roots `(tool, native_id)`; Claude children `(claude, parent_id, agent_id)`; keep native ids in their own columns
- [ ] Define message identity: Claude line `uuid`; Codex `(session_id, decompressed line number)` plus content hash
- [ ] Define read positions: plain active files by byte offset; `.zst` and archived files immutable, replayed whole once, keyed by content hash
- [ ] Deduplicate a logical session seen as plain, compressed and archived copies; report duplicates
- [ ] Classify unsupported layouts (unknown extension, paginated/migrated rollout layout, unreadable file) instead of skipping silently
- [ ] Add tests with fixture trees: parent + 2 Claude children get 3 distinct ids; the same Codex session as `.jsonl`, `.jsonl.zst` and archived maps to one identity
- [ ] Verify `agent-history scan --dry-run` inventory counts match `find` counts per tool and encoding on this machine

### Task 4: Schema, private files, diagnostics
- [ ] Create `sessions` (id, tool, native_id, parent_id, agent_id, is_sidechain, project, cwd, started_at, ended_at, title, source_path, cli_version)
- [ ] Create `messages` (id, session_id, ts, role, phase, kind, text, tool_name, files, provisional, raw, source_path, source_line, content_hash, parser_version)
- [ ] Create FTS5 `messages_fts` over `messages.text` with insert/update/delete sync triggers
- [ ] Create `sources` (path, session_id, encoding, content_hash, inode, size, offset, last_line, status, updated_at) for coverage and checkpoints
- [ ] Create `ingest_errors` (ts, source_path, line, error_class, detail without message text) and `unknown_types` (tool, type, subtype, count)
- [ ] Track schema version with `PRAGMA user_version`; refuse a DB with a newer version than the code knows
- [ ] DB path `~/.agent-history/history.db`, overridable by `AGENT_HISTORY_DB`; parent dir created 0700; DB and WAL/SHM files 0600 via umask
- [ ] Open with WAL and `busy_timeout=5000`
- [ ] Add tests: `init` twice is idempotent; `journal_mode` is `wal`; DB, `-wal`, `-shm` and parent dir modes are 600/600/600/700 for both default and custom paths; FTS finds inserted, reflects updated, drops deleted rows; newer `user_version` is refused
- [ ] Verify whether the system `sqlite3` CLI can run an FTS5 `MATCH` on the DB; record the result for the Task 13 pointer

### Task 5: Sanitizer
- [ ] Redact patterns: Anthropic and OpenAI keys, `ghp_` / `github_pat_`, `AKIA…`, `xox[bp]-`, JWTs, PEM private key blocks (raw and `\n`-escaped), `.env`-style `*_KEY=` / `*_SECRET=` / `*_TOKEN=` / `PASSWORD=` lines
- [ ] Sanitize structured records: walk every string value, decode strings that hold JSON (tool arguments, custom call input) and sanitize inside them, then re-serialize
- [ ] Redact before any trimming, so a secret cut at the 500-char or 2 KB boundary is still removed
- [ ] Apply to every stored field: text, files, title, cwd, project, raw; logs record ids and error classes only, never message text
- [ ] Add a seeded fixture with fake secrets in: plain text, escaped PEM, nested stringified tool arguments, tool results, metadata fields, and straddling the trim boundary
- [ ] Add false-positive tests: git hashes, UUIDs, file paths, base64 images are left intact
- [ ] Verify sanitizer unit tests pass (persistence checks follow in Tasks 8 and 9)

### Task 6: Claude Code parser
- [ ] Prompts: `user` lines with human text only; tool-result blocks inside `user` lines become `kind=tool_result`, not prompts
- [ ] Assistant text answers, tool names, file paths from tool inputs; tool results trimmed to 500 chars after sanitizing
- [ ] Skip noise types (`attachment`, `mode`, `permission-mode`, `session-owner`, `bridge-session`, `atis-latch`, …); count unknown types and subtypes
- [ ] Children: use identity from Task 3, set `parent_id`, `agent_id`, `is_sidechain`
- [ ] Derive `project` from `cwd`; `started_at` / `ended_at` from timestamps
- [ ] `raw`: sanitized line truncated to 2 KB, with source path and line number
- [ ] Add anonymised fixtures and golden tests: prompt vs tool-result wrapper counts, parent + 2 children, unknown type counted
- [ ] Verify parser tests pass

### Task 7: Codex parser
- [ ] Read `session_meta` for id, `cwd`, `cli_version`, `source`, parent/fork info
- [ ] Canonical source: `response_item` records. `message` keeps `role` and `phase` (commentary vs final); `developer` and injected context are not user prompts
- [ ] Tool calls: `function_call` (string `arguments`) and `custom_tool_call` (`input`); correlate outputs by `call_id`; extract tool name and file paths; trim outputs to 500 chars after sanitizing
- [ ] Skip `reasoning`, `token_count` and `event_msg` records that mirror response items; keep turn ids and lifecycle timestamps as metadata
- [ ] Handle compaction, resume and fork without reinserting replayed history
- [ ] Count unknown types including `response_item` subtypes
- [ ] Add anonymised fixtures (plain and `.zst`) and golden tests: call/output pairing, phases, no double count from `event_msg.item_completed` / `task_complete`, a resumed session
- [ ] Verify parser tests pass

### Task 8: Incremental ingest with atomic checkpoints
- [ ] Stream sources line by line; stop at the last newline-terminated line; tolerate a partial UTF-8 sequence at the end
- [ ] Write rows in bounded batches (e.g. 500 lines); each batch commits rows and the `sources` checkpoint in one transaction
- [ ] Advance checkpoints with compare-and-set so a stale writer cannot move one backwards; on conflict, re-read from the newer checkpoint
- [ ] Re-read from the start when a plain file shrank or its inode or content hash changed; upsert by message id
- [ ] On `busy` or decode errors: bounded retries, then record in `ingest_errors` and leave the source `pending` for the next scan
- [ ] `ingest` reads hook stdin JSON as untrusted data (`session_id`, `transcript_path`, `agent_transcript_path`, `cwd`, `turn_id`, `last_assistant_message`); paths must sit under a known root
- [ ] Store `last_assistant_message` as a provisional row; replace it when the matching transcript record arrives (Codex by `turn_id`, Claude by last assistant reply after the turn's prompt); two identical real answers both survive
- [ ] Tests with exact expected rows and checkpoints: chunked vs one-shot ingest; repeated ingest; crash between batches; 2 ingesters on the same file while it grows; partial line and partial UTF-8; transcript delayed then arriving; duplicate hook calls; plain file later replaced by its `.zst` copy; truncated and replaced file; 10 concurrent writers on different sessions
- [ ] Persistence check: ingest the Task 5 seeded fixture; no seeded secret appears in `messages`, `messages_fts`, `sessions`, `raw` or the log
- [ ] Verify tests pass

### Task 9: Backfill via scan
- [ ] `scan` walks the Task 3 inventory; flags `--tool`, `--changed-since-last`, `--dry-run`; resumable from `sources` checkpoints after interruption
- [ ] Set budgets before running: peak memory < 300 MB, full scan < 30 min, DB < 2 GB; revise only with a written reason
- [ ] **(user)** Run `agent-history scan` over all existing transcripts, measuring peak memory (`/usr/bin/time -l`), duration and DB size
- [ ] While the scan runs, ingest a live turn and record its latency
- [ ] Verify unique logical sessions in the DB equal the inventory, with empty, malformed, unsupported and duplicate sources listed separately
- [ ] Verify for 3 random Claude sessions that prompt counts match `jq` over `type=="user"` lines whose content is human text (not `tool_result`), and for 3 Codex sessions that user `message` counts match
- [ ] Verify no seeded or known real key prefixes (`sk-ant-`, `ghp_`, `AKIA`) match in the DB outside `[REDACTED]`
- [ ] Record measured memory, time, size and live-ingest latency in the design doc

### Task 10: Doctor command
- [ ] Report per tool: sources missing from the DB, partial sources (checkpoint behind readable end), stale sources (not updated after their file changed), unsupported layouts, pending retries, provisional rows older than 10 minutes
- [ ] Report parse errors, unknown types, last ingest time, DB size and file modes
- [ ] Exit non-zero when anything above is non-empty, so it can gate checks
- [ ] Add tests with fixture trees: one missing, one partial, one unsupported, one stale provisional row
- [ ] Verify `agent-history doctor` exits 0 after Task 9

### Task 11: Hooks and recovery scan
- [ ] **(user)** Claude Code `~/.claude/settings.json`: `Stop` and `SubagentStop` (`async: true`) run the absolute `agent-history ingest` path; `SessionStart` runs `scan --changed-since-last`; command is a fixed string with quoted absolute paths, stdin never interpolated into shell
- [ ] **(user)** Codex `~/.codex/hooks.json`: `Stop`, `SubagentStop`, `SessionStart` the same way; review and trust them via `/hooks`
- [ ] **(user)** Probe Codex 0.163 with a logging hook in an isolated `CODEX_HOME` to record the real stdin payload and which fields are null
- [ ] **(user)** Add a launchd agent running `scan --changed-since-last` every 15 minutes, covering interrupted turns, immediate exits and missed hooks without a new session
- [ ] Hook failures go to `~/.agent-history/ingest.log` (0600) and `ingest_errors`, never to the session
- [ ] **(user)** Verify `claude -p "reply with the single word: kumquat-<random>"` (prompt does not contain the reply) lands with the assistant reply `kumquat-<random>` as a non-provisional row within 60 s
- [ ] **(user)** Verify a subagent run in both tools produces a child session linked to its parent
- [ ] **(user)** Verify recovery: kill a session mid-turn and exit immediately after a turn; the launchd scan captures both within 15 minutes and `doctor` exits 0
- [ ] **(user)** Verify visible overhead: 10 runs each of `claude -p` with hooks enabled vs disabled; median foreground difference < 50 ms; ingest latency reported separately
- [ ] Verify with a corrupted DB in an isolated test home: the session completes and the error is in the log and visible to `doctor`
- [ ] **(user)** Repeat the capture and overhead checks with Codex

### Task 12: Markdown export (optional)
- [ ] `export` writes `~/.agent-history/md/<project>/<date>-<id>.md` from sanitized DB rows; directories 0700, files 0600
- [ ] Run export after each ingest for the touched session
- [ ] Verify `.md` count equals session count, `rg kumquat ~/.agent-history/md` finds the Task 11 session, and no seeded secret appears in exports

### Task 13: Discovery pointer and recall test
- [ ] Generate the "Past sessions" pointer from config: actual DB path, the query tool that works (system `sqlite3` or a tested `python3 -c` example from Task 4), markdown path only if export is enabled
- [ ] Pointer tells the agent to show dates and prefer newer sessions when decisions conflict
- [ ] **(user)** Add it to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`
- [ ] **(user)** Write 10 recall questions from real history with expected session ids in `tests/private/recall_cases.md` (git-ignored, 0600)
- [ ] **(user)** Run each question in a fresh session; record queries used and whether the right session was found
- [ ] **(user)** Verify at least 8 of 10 found in 3 queries or fewer; if not, add a `/recall` skill and re-run
- [ ] Verify timed queries by date range, project, file path and keyword each return in < 1 s on the full DB

### Task 14: Retrospective skill
- [ ] Write a skill that pulls a project's sessions for a date range and summarises decisions, reversals and open threads, each with date, session id and a short quote
- [ ] **(user)** Run it on a busy project over 30 days in one request
- [ ] **(user)** Verify by hand that each listed decision and reversal is supported by the quoted content in the cited session, and that later reversals supersede earlier decisions

### Task 15: Maintenance and retention
- [ ] **(user)** Add a monthly launchd job running `PRAGMA optimize` and `VACUUM`; ingest during maintenance retries and recovers
- [ ] Test retention in an isolated `CLAUDE_CONFIG_DIR`: an ingested transcript with mtime aged past a short `cleanupPeriodDays` is deleted by Claude Code's own cleanup, and stays fully searchable in the DB
- [ ] Verify an ingest that hits `VACUUM` contention is recorded and recovered by the next scan
- [ ] **(user)** Verify `doctor` exits 0 after a week of normal use
- [ ] **(user)** Record the real 30-day observation in the design doc as pending until the oldest ingested transcript has actually been cleaned up and is still searchable

### Task 16: Setup commands and runbook for outside steps
- [ ] `agent-history setup cleanup-period|hooks|launchd|pointer|mirror`, each dry-run by default (prints the exact change), `--apply` writes with a timestamped backup; `--home` override for tests
- [ ] `setup hooks` merges into existing `settings.json` / `hooks.json` without removing other hooks, and is idempotent
- [ ] `setup launchd` writes plists for the 15-minute scan and the monthly maintenance job, with absolute paths
- [ ] `setup pointer` appends the generated pointer once, between markers, so it can be updated or removed
- [ ] Add `scripts/overhead.sh` (hook-on vs hook-off timing) and `scripts/capture-check.sh` (random reply word) for the live checks
- [ ] Write `docs/RUNBOOK.md`: ordered commands for Tasks 1, 9, 11, 13, 14, 15 user items, with how to verify and undo each
- [ ] Tests on temp homes: dry-run writes nothing; apply is idempotent; existing unrelated hooks and settings survive; backups are created

## Decisions

| Question | Decision | Reason | Who |
| --- | --- | --- | --- |
| Touch global config during implementation? | No; prepare `setup` commands and a runbook | User is away until tomorrow and will run them | user |
| Live agent runs and recall questions | Left to the user, with scripts | They spend quota and need the user's memory | user |
| Where setup logic lives | `agent-history setup …` subcommands instead of loose shell scripts | Testable on temp homes, dry-run by default | default |
