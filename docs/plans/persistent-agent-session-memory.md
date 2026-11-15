# Plan: Persistent Agent Session Memory

Design: [Implementation Plan](../Persistent%20Agent%20Session%20Memory%20—%20Implementation%20Plan.md) · [Proposal](../Persistent%20Agent%20Session%20Memory%20—%20Proposal.md)

## Validation Commands
- `python3 -m pytest -q`
- `python3 -m agent_history --help`
- `python3 -m agent_history doctor`

### Task 1: Safety net against transcript cleanup
- [ ] Set `"cleanupPeriodDays": 36500` in `~/.claude/settings.json` (not 0; confirm in Claude Code docs that 0 does not disable transcripts)
- [ ] Optionally mirror raw transcripts: `rsync -a ~/.claude/projects/ ~/.agent-history/raw/claude/`
- [ ] Verify `jq .cleanupPeriodDays ~/.claude/settings.json` prints 36500
- [ ] Verify the `*.jsonl` count in `~/.claude/projects` does not drop after starting a new `claude` session
- [ ] If mirrored, verify source and mirror `*.jsonl` counts match

### Task 2: Project skeleton
- [ ] Create `agent_history/` package with `__main__.py`, `cli.py`, `db.py`, `redact.py`, `parsers/claude.py`, `parsers/codex.py`
- [ ] Add CLI subcommands `init`, `ingest`, `scan`, `export`, `doctor` (stubs)
- [ ] Add `pyproject.toml` with a `agent-history` console script, stdlib only, pytest as dev dependency
- [ ] Add `tests/` and `tests/fixtures/`
- [ ] Add `.gitignore` covering `*.db`, `tmp/`, `__pycache__/`
- [ ] Verify `python3 -m agent_history --help` lists all subcommands and `pytest` runs

### Task 3: Schema and database setup
- [ ] Create `sessions` (id, tool, project, cwd, started_at, ended_at, title, transcript_path, parent_session_id, is_sidechain)
- [ ] Create `messages` (id, session_id, ts, role, text, tool_name, files, raw, parser_version)
- [ ] Create FTS5 `messages_fts` over `messages.text` with insert/update/delete sync triggers
- [ ] Create `ingest_state` (transcript_path, offset, inode, size, updated_at)
- [ ] Track schema version with `PRAGMA user_version`
- [ ] Open DB at `~/.agent-history/history.db` (overridable via `AGENT_HISTORY_DB`) with WAL, `busy_timeout=5000`, file mode 600
- [ ] Add tests: `init` twice is idempotent; `journal_mode` is `wal`; file mode is 600; FTS `MATCH` finds an inserted row
- [ ] Verify the system `sqlite3` CLI can run an FTS5 `MATCH` query on the DB; if not, note `python3 -c` fallback for Task 11

### Task 4: Claude Code parser
- [ ] Parse `user` lines into prompts and `assistant` lines into text answers and tool calls
- [ ] Extract tool names and file paths from tool inputs; trim tool results to 500 characters
- [ ] Skip noise types (`attachment`, `mode`, `permission-mode`, `session-owner`, `bridge-session`, `atis-latch`, …); count unknown types instead of failing
- [ ] Detect subagent transcripts (`subagents/` path, `isSidechain`) and set `parent_session_id`
- [ ] Derive `project` from `cwd`, `started_at` / `ended_at` from timestamps
- [ ] Store the original line in `raw`
- [ ] Add anonymised real-line fixtures and golden-file tests
- [ ] Verify parser tests pass

### Task 5: Codex parser
- [ ] Read `session_meta` for session id and `cwd`
- [ ] Parse `response_item` lines (`message`, `custom_tool_call`, `custom_tool_call_output`, function calls); skip `reasoning`, `token_count` and other `event_msg` noise
- [ ] Build stable message ids from file path and line offset
- [ ] Add anonymised fixtures and golden-file tests
- [ ] Verify parser tests pass

### Task 6: Redaction
- [ ] Add regex list: Anthropic and OpenAI keys, `ghp_` / `github_pat_`, `AKIA…`, `xox[bp]-`, JWTs, PEM private key blocks, `.env`-style `*_KEY=` / `*_SECRET=` / `*_TOKEN=` / `PASSWORD=` lines
- [ ] Apply redaction to `text`, `files` and `raw` before any write
- [ ] Add a fixture seeded with 20 fake secrets; test that none are found in the DB after ingest
- [ ] Add a false-positive test: git hashes, UUIDs and file paths are left intact
- [ ] Verify tests pass

### Task 7: Incremental ingest
- [ ] Read each transcript from the saved byte offset; stop at the last newline-terminated line
- [ ] Re-read from the start when the file shrank or its inode changed
- [ ] Upsert messages by id; one short transaction per ingest
- [ ] `ingest` reads hook stdin JSON (`session_id`, `transcript_path`, `cwd`, `last_assistant_message`) and treats it as untrusted
- [ ] Use `last_assistant_message` when the transcript has not yet caught up
- [ ] Add tests: 5-chunk ingest equals one-shot ingest; repeated ingest leaves row counts unchanged; 10 concurrent writer processes raise no `database is locked`
- [ ] Verify tests pass

### Task 8: Backfill via scan
- [ ] `scan` walks `~/.claude/projects` and `~/.codex/sessions` and ingests every transcript; `--tool` and `--changed-since-last` flags
- [ ] Run `python3 -m agent_history scan` over all existing transcripts
- [ ] Verify DB session count equals the number of transcript files on disk, per tool
- [ ] Verify for 3 random sessions that the user-prompt count matches a `jq` count over the JSONL
- [ ] Record DB size and scan time in the design doc

### Task 9: Doctor command
- [ ] Report transcripts on disk missing from the DB, last ingest time, parse error count, unknown line types, DB size
- [ ] Add a test with a fixture tree where one transcript is not ingested
- [ ] Verify `python3 -m agent_history doctor` reports 0 missing and 0 parse errors after Task 8

### Task 10: Hooks
- [ ] Add Claude Code `Stop` hook (`async: true`) running `agent-history ingest`, exec form with quoted paths
- [ ] Add Claude Code `SessionStart` hook running `agent-history scan --changed-since-last`
- [ ] Write hook errors to `~/.agent-history/ingest.log`; never fail the session
- [ ] Check Codex 0.163 hook support and event names; add `~/.codex/hooks.json`, or fall back to a launchd `scan` job
- [ ] Verify `claude -p "say the word pelican"` lands in the DB with that session id within one turn
- [ ] Verify `time agent-history ingest < tests/fixtures/stop_stdin.json` is well under 50 ms
- [ ] Verify a corrupted DB does not break a session and the error appears in the log
- [ ] Repeat the pelican check with Codex

### Task 11: Markdown export (optional)
- [ ] `export` writes `~/.agent-history/md/<project>/<date>-<id>.md` from DB rows
- [ ] Run export after each ingest for the touched session
- [ ] Verify `.md` file count equals session count and `rg pelican ~/.agent-history/md` finds the Task 10 session

### Task 12: Discovery pointer and recall test
- [ ] Add the 4-line "Past sessions" pointer to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`
- [ ] Write 10 recall test questions from real history, each with its expected session id, in `tests/recall_cases.md`
- [ ] Run each question in a fresh session; record queries used and whether the right session was found
- [ ] Verify at least 8 of 10 found in 3 queries or fewer; if not, add a `/recall` skill and re-run

### Task 13: Retrospective skill
- [ ] Write a skill that pulls a project's sessions for a date range and summarises decisions, reversals and open threads with dates and session ids
- [ ] Run it on a busy project over 30 days
- [ ] Verify by hand that every cited session id and date exists in the DB

### Task 14: Maintenance and 30-day check
- [ ] Add a monthly launchd job running `PRAGMA optimize` and `VACUUM`
- [ ] Move an ingested transcript out of `~/.claude/projects` to simulate cleanup
- [ ] Verify it is still fully searchable and `doctor` still reports the session
- [ ] After a week of normal use, verify `doctor` shows 0 missing sessions
