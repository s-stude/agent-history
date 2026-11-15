# Persistent Agent Session Memory — Implementation Plan

Nov 16, 2026 · Implements [Persistent Agent Session Memory — Proposal](Persistent%20Agent%20Session%20Memory%20—%20Proposal.md)

Evidence marks: **[code+check]** checked on this machine; **[code]** traced, not all re-checked; **[docs]** from docs only; **[inferred]** reasoned, not run.

## Findings that shape the plan

- **The 30-day deletion is close.** `cleanupPeriodDays` is not set in `~/.claude/settings.json`, so the default applies. The oldest transcripts left are from about Nov 1, so cleanup starts deleting them around Dec 1. Backfilling existing transcripts happens in the first steps, not at the end. **[code+check]**
- **There is more data than the proposal assumes.** `~/.claude/projects` holds 6.7 GB in 1095 JSONL files, 723 of them subagent transcripts. `~/.codex/sessions` holds 125 rollout files. Trimming tool output matters for keeping the database small. **[code+check]**
- **The tools are already there.** Python 3.14's stdlib `sqlite3` (3.53) builds FTS5 tables. The system `sqlite3` CLI is 3.43; whether it can run FTS5 `MATCH` queries is not yet confirmed, and that is how the agent will search. Codex is 0.163, Claude Code is 2.1.325. **[code+check]**
- **The two transcript formats differ.** Claude Code writes lines of type `user` and `assistant`, plus noise such as `attachment`, `mode`, `permission-mode` and `bridge-session`. Codex writes `response_item` lines (`message`, `custom_tool_call`, `custom_tool_call_output`, `reasoning`) and `event_msg` lines. Each tool needs its own parser. **[code+check]**

## Decisions on the open questions

| Question | Decision | Why |
| --- | --- | --- |
| Which tools? | Claude Code and Codex | Both are in active use **[code+check]** |
| Which machines? | One Mac, no merging | A non-goal in the proposal |
| Language? | Python, stdlib only, one `agent-history` CLI | No dependencies, FTS5 works **[code+check]** |
| Backfill old transcripts? | Yes, as step 3 | The Dec 1 deletion deadline |
| Subagent transcripts? | Store them, with `parent_session_id` and `is_sidechain` columns | There are 723 of them and they hold real work |
| LLM summary per session? | Not in v1 | Costs tokens; add only if the recall test fails |
| Redaction? | Regex list, plus tool output trimmed to about 500 characters | Matches the proposal |
| `/recall`? | Not at first; CLAUDE.md pointer only | Add if the recall test shows the agent struggling |
| Retrospective? | A skill | It needs multi-step instructions |

## Steps

Steps 0–6 are urgent because of the Dec 1 deletion. Steps 7 onward can follow.

### Step 0: Safety net

- Set `"cleanupPeriodDays": 36500` in `~/.claude/settings.json`. Do not use 0: in some versions 0 turns transcript saving off entirely **[inferred]**, confirm in the docs first.
- Optional: mirror raw transcripts with `rsync -a ~/.claude/projects/ ~/.agent-history/raw/claude/` as protection against parser bugs.

**Verify:** `jq .cleanupPeriodDays ~/.claude/settings.json` prints 36500. Start a new `claude` session and confirm the file count in `~/.claude/projects` does not drop. If mirrored, `find … -name '*.jsonl' | wc -l` gives the same count for source and mirror.

### Step 1: Project skeleton

- `agent_history/` package with `cli.py` (commands `init`, `ingest`, `scan`, `export`, `doctor`), `db.py`, `parsers/claude.py`, `parsers/codex.py`, `redact.py`. Pytest and a `tests/fixtures/` folder.

**Verify:** `agent-history --help` runs; `pytest` runs and passes with no tests yet.

### Step 2: Schema and database setup

- Tables `sessions`, `messages`, and FTS5 `messages_fts` with sync triggers.
- `ingest_state` table (transcript path, byte offset, inode, size) and a `messages.raw` column for the original line.
- `PRAGMA user_version` for migrations.
- WAL mode, `busy_timeout=5000`, database file `chmod 600`.

**Verify (pytest):** running `init` twice changes nothing. `PRAGMA journal_mode` returns `wal`. `stat -f %Lp history.db` returns `600`. An inserted row is found with `MATCH`. Also run `sqlite3 history.db "select … from messages_fts where messages_fts match 'x'"` with the system CLI; if that fails, the pointer tells the agent to use `python3 -c` instead.

### Step 3: Claude Code parser and backfill

- Turn each transcript into rows:
  - user prompts
  - assistant text answers
  - tool names, plus file paths from tool inputs
  - tool results trimmed to 500 characters
- Skip noise line types. Count unknown line types instead of failing on them.
- Fixtures built from real, anonymised lines. Then run `agent-history scan --tool claude` over all transcript files.

**Verify:**
- Golden-file tests on the fixtures.
- After the scan, `doctor` reports 0 parse errors and lists unknown types.
- Session rows equal the number of transcript files on disk.
- For 3 random sessions, the user-prompt count matches a `jq` count over the JSONL.
- Record the database size; the guess is a few hundred MB **[inferred]**.

### Step 4: Codex parser

- Read `session_meta` for session id and `cwd`, then `response_item` message and tool lines. Stable message id from file path and line offset.

**Verify:** the same checks as step 3, across the Codex rollout files.

### Step 5: Redaction

- Regex list: Anthropic and OpenAI keys, `ghp_` / `github_pat_`, `AKIA…`, `xox[bp]-`, JWTs, PEM blocks, `.env`-style `SECRET=…` lines. Redact before rows are written, including the `raw` column.
- Rerun the backfill afterwards so older rows are redacted too.

**Verify:** ingest a fixture seeded with 20 fake secrets, then search the database for each; 0 matches (success criterion 6). Run the regex list over 50 real sessions to check for false positives such as hashes or UUIDs being redacted.

### Step 6: Incremental ingest

- Read from the saved byte offset. Stop at the last newline-terminated line so a half-written line is not saved. If the file shrank or its inode changed, re-read from the start. One short transaction per turn.

**Verify (pytest):**
- Reading a file in 5 chunks gives the same rows as reading it once.
- Running ingest twice does not change row counts.
- 10 concurrent writer processes produce no `database is locked` errors.

### Step 7: Hooks

- Claude Code, in `~/.claude/settings.json`: `Stop` hook with `async: true` runs `agent-history ingest`, reading hook stdin and using `last_assistant_message` for the final turn. `SessionStart` runs `scan --changed-since-last`. Exec form with quoted paths. Hook errors go to `~/.agent-history/ingest.log`, never to the session.
- Codex: `~/.codex/hooks.json` does not exist yet. Check that Codex 0.163 supports hooks and the event names **[docs, unverified]**. If not, fall back to running `scan` from a Claude `SessionStart` hook or from launchd.

**Verify:**
- Run `claude -p "say the word pelican"`, then query the database for `pelican` with that session id; the row is there within one turn (success criterion 1).
- `time agent-history ingest < fixtures/stop_stdin.json` well under 50 ms of foreground time; the hook is async, so the session should not notice (criterion 5).
- Corrupt the database on purpose; the session still works and the error is in the log.
- Repeat for Codex.

### Step 8: Markdown export (optional)

- Write `~/.agent-history/md/<project>/<date>-<id>.md` from database rows, so files are already redacted.

**Verify:** number of `.md` files equals number of sessions; `rg pelican ~/.agent-history/md` finds the step 7 session.

### Step 9: Pointer in CLAUDE.md / AGENTS.md and recall test

- Add the 4-line pointer from the proposal. Before running anything, write 10 test questions ("remember when we…") from real history, each with the session id it should find.

**Verify:** run each question in a fresh session; count database queries and whether the right session is found. Target: 8 of 10 found in 3 queries or fewer (criterion 3). On misses, try a `/recall` skill or per-session summaries.

### Step 10: Retrospective skill

**Verify:** run it on a busy project over 30 days (criterion 4). By hand, confirm every listed decision or reversal cites a real session id and date.

### Step 11: Maintenance and the 30-day check

- `doctor` shows transcripts on disk not in the database, last ingest time, parse error count, database size.
- Monthly launchd job runs `PRAGMA optimize` and `VACUUM`.

**Verify (criterion 2):** move an ingested transcript out of `~/.claude/projects` to simulate cleanup; it is still fully searchable and `doctor` still reports the session. After a week of normal use, `doctor` shows 0 missing sessions.

## Success criteria coverage

| Success criterion | Verified in |
| --- | --- |
| 1. Every session saved within one turn | Steps 7 and 11 |
| 2. Searchable after the 30-day cleanup | Step 11 |
| 3. 8 of 10 test questions answered in 3 queries or fewer | Step 9 |
| 4. Retrospective in one request | Step 10 |
| 5. Under 50 ms of visible delay | Step 7 |
| 6. No unredacted keys | Step 5 |
