# Plan: Persistent Agent Session Memory

Design: [Design Plan](../Persistent%20Agent%20Session%20Memory%20—%20Design%20Plan.md) · [Proposal](../Persistent%20Agent%20Session%20Memory%20—%20Proposal.md)

Stack: Node.js ≥ 22.15 (installed: v22.22.0 via nvm), plain JavaScript ES modules, Knex over the `pg` driver, PostgreSQL 18 in Postgres.app on `localhost:5432`. The earlier Python + SQLite implementation of Tasks 2–5 (commits `9dbd41e`…`e477aff`) was removed in `9c1605d`; use it as the behavioural reference when porting, including its tests.

Rule for every task: destructive tests (corruption, cleanup, moved or replaced files) run against isolated test homes under `./tmp/` and throwaway `agent_history_test_*` databases, never against `~/.claude`, `~/.codex`, `~/.agent-history` or the `agent_history` database.

## Run scope (decided by the user, 2026-11-16)

- Repo only during implementation. Nothing outside the repo is written: no `~/.claude/settings.json`, `~/.codex/hooks.json`, launchd, `CLAUDE.md` / `AGENTS.md` or `~/.agent-history` changes, and no `agent_history` database or roles on the server.
- Every outside step is prepared as an `agent-history setup …` command (dry-run by default, `--apply` writes with a backup) plus a runbook, `docs/RUNBOOK.md`, for the user to run.
- Live agent runs (capture, overhead, recall questions, retrospective) are left to the user with exact commands.
- Reading `~/.claude` and `~/.codex` read-only for inventory and parser checks is allowed. A trial backfill of real data goes to a throwaway `agent_history_test_trial_<rand>` database, reports aggregate measurements only, lives through the Task 10 and Task 13 checks, and is dropped after Task 13.

Server objects during implementation (approved by the user, 2026-11-16): tests create and drop only the exact `agent_history_test_<pid>_<rand>` database each run created, plus one trial DB (Task 9). No roles and nothing else on the server are created or changed.

Items marked **(user)** below are prepared but not run.

Paths used below: `PGBIN="/Applications/Postgres 18.app/Contents/Versions/latest/bin"` (the `psql` on `PATH` is Homebrew 16 and is not used); `NODE=~/.nvm/versions/node/v22.22.0/bin/node` (already allowed in Postgres.app's permission dialog).

## Validation Commands
- `npm test` (runs `node --test`; each run creates and drops its own test DB)
- `./bin/agent-history --help`
- `npm run check:doctor` (creates a unique test DB, runs `doctor` against it, drops it; never the real DB)

### Task 1: Safety net against transcript cleanup
- [ ] **(user)** Verify the documented cleanup setting and set `"cleanupPeriodDays": 36500` in `~/.claude/settings.json`; do not set it to 0
- [ ] **(user)** Optionally mirror raw transcripts to `~/.agent-history/raw/` (`claude/`, `codex/sessions/`, `codex/archived_sessions/`); create `~/.agent-history` and `raw/` with mode 0700; keep out of cloud sync
- [ ] **(user)** Verify `jq .cleanupPeriodDays ~/.claude/settings.json` prints 36500
- [ ] **(user)** Verify the `*.jsonl` count in `~/.claude/projects` does not drop after starting a new `claude` session
- [ ] **(user)** If mirrored, verify per-tool file counts (`.jsonl` and `.jsonl.zst`) match source and `stat -f %Lp ~/.agent-history/raw` prints 700

### Task 2: Project skeleton, install, test DB harness
- [x] `package.json`: `"type": "module"`, `"engines": {"node": ">=22.15"}`, `bin: {"agent-history": "bin/agent-history"}`, runtime dependencies `knex` and `pg`, no dev dependencies; `"test": "node --test"`; `package-lock.json` committed
- [x] Source layout (plain JavaScript): `src/cli.js`, `src/db.js` (Knex factory; owner/reader split lands in Task 13), `src/schema.js`; `src/inventory.js`, `src/redact.js`, `src/ingest.js`, `src/parsers/claude.js`, `src/parsers/codex.js` land with their tasks; `migrations/*.js` (Knex); `src/db.js` builds the Knex config including `migrations: { directory: fileURLToPath(new URL('../migrations/', import.meta.url)), loadExtensions: ['.js'] }`; `knexfile.js` only re-exports that config
- [x] `bin/agent-history`: `#!/usr/bin/env node` launcher importing `../src/cli.js`; hooks and launchd call it as `"$NODE" /abs/repo/bin/agent-history …`, never through `PATH`
- [x] CLI subcommands `init`, `ingest`, `scan`, `export`, `doctor`, `setup` (stubs), parsed with `node:util` `parseArgs`
- [x] Install with `npm ci`; npm cache pinned to `tmp/npm-cache` via repo `.npmrc` (`cache=${PWD}/tmp/npm-cache`, so npm runs from the repo root); record the absolute `node` and `bin/agent-history` paths in the README for hooks and launchd
- [x] `.gitignore`: `node_modules/`, `tmp/`, `.peer-chats/`, `tests/private/`, `*.dump`, `.idea/`
- [x] Test harness `test/helpers/db.js`: through Knex on the `postgres` maintenance DB, outside any transaction, creates `agent_history_test_<pid>_<rand>` from `template0` (`knex.raw('CREATE DATABASE ?? TEMPLATE template0', [name])`), applies Knex migrations, and after the run destroys every Knex instance pointing at it, then drops with `WITH (FORCE)` only the exact name it created successfully; never lists or drops other databases by prefix; never creates roles; skips with a clear message when the server is unreachable
- [x] `npm run check:doctor` script wrapping the harness for the validation command; `doctor` already reports server version and the read-only schema state (`src/schema.js`, added early after the Codex note in msg-009)
- [x] CLI smoke test (`--help` exits 0 and lists all subcommands) so `node --test` never collects zero tests
- [x] Every CLI path ends with `await knex.destroy()` (in `finally`), so no command hangs on an open pool; smoke-test that `--help` and a failed connection both exit
- [x] Verify `"$NODE" bin/agent-history --help` runs from a fresh shell, `npm test` passes, and no `agent_history_test_*` DB is left on the server afterwards

### Task 3: Source inventory and identity contract
- [x] Inventory roots: `~/.claude/projects` (main and `*/subagents/*.jsonl`), `~/.codex/sessions` and `~/.codex/archived_sessions` (`.jsonl` and `.jsonl.zst`); roots overridable for tests
- [x] Read `.zst` with `fs.createReadStream(…).pipe(zlib.createZstdDecompress())` into `readline`, as a stream
- [x] Define session identity: roots `(tool, native_id)`; Claude children `(claude, parent_id, agent_id)`; keep native ids in their own columns
- [x] Define record identity: Claude line `uuid`; Codex `(segment, decompressed line number)` where segment is the rollout file name without extensions, so plain, `.zst` and archived copies share ids
- [x] Row key is `(logical session, record id, block ordinal)`: one row per retained block, so a line with text and several tool calls keeps every block; multi-block and replay tests land with the parsers (Tasks 6–7) and ingest (Task 8)
- [x] Treat Codex paginated continuation files (`rollout-…-<thread>_<page>.jsonl*`) as extra segments of the same thread, and legacy 2025-10 files without the `{type, payload}` envelope as supported; legacy record parsing lands in Task 7
- [x] Define read positions: plain active files by byte offset; `.zst` and archived files immutable, replayed whole once, keyed by content hash
- [x] Deduplicate a logical session seen as plain, compressed and archived copies; report duplicates
- [x] Classify unsupported layouts (unknown extension, unreadable file) as `unsupported`; recognized page segments are included; workflow `journal.jsonl` orchestration logs are `skipped`; inventory survives filesystem errors (port the `3d2d99c` fix)
- [x] Add tests with fixture trees: parent + 2 Claude children get 3 distinct ids; the same Codex session as `.jsonl`, `.jsonl.zst` and archived maps to one identity
- [x] Verify `agent-history scan --dry-run` inventory counts match `find` counts per tool and encoding on this machine (last Python run: Claude 371 root + 721 child + 2 skipped; Codex 126 plain + 687 zst active + 99 zst archived; 2002 sessions). Node run 2026-11-16 matches `find` exactly: Claude 362 root + 694 child + 2 skipped; Codex 129 plain + 687 zst active + 99 zst archived; 1969 sessions; 0 empty, 0 unsupported, 0 unreadable, 0 duplicate segments. Claude counts dropped since the Python run (371 → 362 root, 721 → 694 child); the 30-day cleanup is the likely cause, not verified file by file

### Task 4: Schema, roles, diagnostics
- [x] Knex migration `001_init.js` (`up` and `down`): `knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')`, then the tables below with `knex.schema.createTable`; Knex tracks applied migrations in `knex_migrations`
- [x] `sessions` (id text pk, tool, native_id, parent_id (no foreign key: a child can arrive before its parent), agent_id, is_sidechain bool, project, cwd, started_at timestamptz, ended_at timestamptz, title, source_path, cli_version)
- [x] `messages` (id bigserial pk, session_id fk, record_id, block_ordinal, ts timestamptz, role, phase, kind, turn_id, text, tool_name, files text[], provisional bool, raw text, source_path, source_line, content_hash, parser_version); unique `(session_id, record_id, block_ordinal)`
- [x] Search: `table.specificType('text_tsv', "tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(coalesce(text, ''), 100000))) STORED")` with `table.index('text_tsv', 'messages_text_tsv_gin', { storageEngineIndexType: 'gin' })` (not `indexType`, which only means unique in Knex); trigram index via `knex.schema.raw('CREATE INDEX … USING gin (text gin_trgm_ops)')` in its own migration so it can be dropped after the Task 9 size measurement; btree indexes on `messages (session_id, ts)`, `sessions (project, started_at)`, GIN on `files` (`storageEngineIndexType: 'gin'`)
- [x] `sources` (path pk, session_id, encoding, content_hash, inode, size, byte_offset, last_line, prefix_fingerprint, generation bigint, status, updated_at) for coverage and checkpoints
- [x] `ingest_errors` (id, ts, source_path, line, error_class, detail without message text, resolved_at) and `unknown_types` (tool, type, subtype, count, primary key on the first three)
- [x] `init` runs `db.transaction(trx => { pg_advisory_xact_lock(<fixed key>); trx.migrate.latest() })`: the lock, Knex's metadata bootstrap and every migration share one connection and one transaction, so losing the connection or a failing migration commits nothing (replaced a separate lock connection after Codex msg-015)
- [ ] `ingest` and `scan` never run migrations (the read-only `schemaStatus` check exists and has its pristine-DB test; wiring into ingest/scan lands in Task 8). They check the schema read-only (`src/schema.js`: `to_regclass('public.knex_migrations')`, `SELECT name FROM knex_migrations`, compared with the migration files), never `knex.migrate.list()`, which creates Knex's metadata tables. Missing metadata = uninitialized; pending or unknown names = incompatible; hooks log and exit 0, `doctor` reports. Test: inspecting a pristine DB leaves zero `knex_migrations*` tables
- [x] Tests: terminating the init backend during a paused migration and a migration that throws both leave no `knex_migrations`, lock table or partial tables behind
- [x] Role setup SQL generated by code (applied only by `setup database`, Task 16): `agent_history_reader` `LOGIN`, `GRANT CONNECT`, `USAGE` on schema, `SELECT` on all tables plus default privileges, `ALTER ROLE … SET default_transaction_read_only = on`; idempotent (`DO` block checking `pg_roles`)
- [x] Add tests: `init` twice is idempotent; generated `text_tsv` finds inserted rows, reflects updated text, drops deleted rows; a 5 MB text block inserts without a `tsvector` size error and its first 100,000 chars are searchable; a unique token past char 100,000 is missed by full-text search and found by the project/date-filtered `ILIKE` fallback; trigram `ILIKE '%…%'` finds a path fragment; a DB with an unknown extra row in `knex_migrations` is refused; two simultaneous first-time `init` runs on a pristine DB both succeed with one lock row; `init` and `doctor` work when started from an unrelated working directory; `pg_indexes.indexdef` for `text_tsv` and `files` contains `USING gin`; the generated role SQL contains only `SELECT` grants and the read-only default
- [x] Verify Postgres.app `psql` can run the pointer's example query (`websearch_to_tsquery`, `ts_headline`) on the test DB inside `SET TRANSACTION READ ONLY`; record the exact command for the Task 13 pointer
- [ ] **(user)** After `setup database`, verify the reader role can `SELECT` and that `INSERT` fails

### Task 5: Sanitizer
- [x] Port the Python patterns: Anthropic and OpenAI keys, `ghp_` / `github_pat_`, `AKIA…`, `xox[bp]-`, JWTs, PEM private key blocks (raw and `\n`-escaped), `.env`-style `*_KEY=` / `*_SECRET=` / `*_TOKEN=` / `PASSWORD=` lines; key patterns must not start or end inside a longer token and are length-capped
- [x] Sanitize structured records: walk every string value, decode strings that hold JSON (tool arguments, custom call input) and sanitize inside them, then re-serialize
- [x] Redact before any trimming, so a secret cut at the 500-char or 2 KB boundary is still removed
- [x] Apply to every stored field: text, files, title, cwd, project, raw; logs record ids and error classes only, never message text
- [x] Remove NUL (`\u0000`) from stored strings; PostgreSQL `text` rejects it
- [x] Add a seeded fixture with fake secrets in: plain text, escaped PEM, nested stringified tool arguments, tool results, metadata fields, and straddling the trim boundary
- [x] Add false-positive tests: git hashes, UUIDs, file paths, base64 images and long base64url blobs containing `sk-` are left intact
- [x] Verify sanitizer unit tests pass (persistence checks follow in Tasks 8 and 9)
- [x] Re-run the real-data false-positive check (50 random sessions, label counts only; `scripts/redaction-sample.js`) and compare with the Python result: 4 `env` redactions, 0 key-pattern hits. First Node run: 87 and 15 `env` hits. A shape-only breakdown over all data (variable name side and value class, no values printed) showed most were references (`KEY: config.x`, `${VAR}`, `process.env.X`, `<placeholder>`). After Codex msg-017 the exemption is narrow: only complete, unquoted reference syntax (`$VAR`, `${VAR}`, `process.env.X`, `process.env['X']`, `import.meta.env.X`, `os.environ['X']`, `os.environ.get('X')`, `os.getenv('X')`), `<placeholder>` / `{{ … }}` values, and numeric values of token-count names (`MAX_TOKENS: 4096`) are kept; everything else after a credential name is redacted, including dotted identifiers like `config.auth.secret,` (after msg-019: punctuation does not prove code), quoted literals, numeric secrets and 1–3 character values. Object/array nesting beyond 64 levels becomes `[REDACTED:depth]`. Re-run: 3 × 50 sessions gave 48 / 19 / 3 `env` hits. Key-pattern hits appeared in these samples (and not in earlier ones by chance); across all data most are this project's fixture or fake-looking tokens, ~76 look like real keys pasted into past sessions, which is what the sanitizer is for

### Task 6: Claude Code parser
- [x] Prompts: `user` lines with human text only; tool-result blocks inside `user` lines become `kind=tool_result`, not prompts
- [x] Assistant text answers, tool names, file paths from tool inputs; tool results trimmed to 500 chars after sanitizing
- [x] Skip noise types (`attachment`, `mode`, `permission-mode`, `session-owner`, `bridge-session`, `atis-latch`, …); count unknown types and subtypes
- [x] Children: use identity from Task 3, set `parent_id`, `agent_id`, `is_sidechain`
- [x] Derive `project` from `cwd`; `started_at` / `ended_at` from timestamps
- [x] `raw`: sanitized line truncated to 2 KB plus a short `…[+N chars]` marker, stored once per line (first block), with source path and line number
- [x] Add anonymised fixtures and golden tests: prompt vs tool-result wrapper counts, parent + 2 children, unknown type counted
- [x] Tool inputs and tool results are sanitized structurally (`sanitize`) before serializing and trimming; redacting the serialized JSON missed env assignments not at line start
- [x] Migration `003_call_id`: `messages.call_id` (tool_use id / tool_result `tool_use_id`) + index, so ingest can recover a tool name after resuming mid-file
- [x] Real data (1056 Claude files, 601,188 lines): 154,245 rows in 80 s at 180 MB RSS; every tool result resolved its tool name; 0 unknown types after adding `frame-link`, `artifact-comment-monitor`, `artifact-autoreact-ledger` to noise
- [x] Verify parser tests pass

### Task 7: Codex parser
- [x] Read `session_meta` for id, `cwd`, `cli_version`, `source`, parent/fork info
- [x] Canonical source: `response_item` records. `message` keeps `role` and `phase` (commentary vs final); `developer` and injected context are not user prompts
- [x] Tool calls: `function_call` (string `arguments`) and `custom_tool_call` (`input`); correlate outputs by `call_id`; extract tool name and file paths; trim outputs to 500 chars after sanitizing
- [x] Skip `reasoning`, `token_count` and `event_msg` records that mirror response items; keep turn ids and lifecycle timestamps as metadata
- [x] Handle compaction, resume and fork without reinserting replayed history
- [x] Count unknown types including `response_item` subtypes
- [x] Add anonymised fixtures (plain and `.zst`) and golden tests: call/output pairing, phases, no double count from `event_msg.item_completed` / `task_complete`, a resumed session
- [x] User messages: each plain `input_text` block is a prompt row (keeps its block ordinal); blocks starting with an injected-context marker (`<environment_context>`, other `<tag>` wrappers, `# AGENTS.md`, `# Files`) are skipped and counted
- [x] Guardian (approval reviewer) children: user messages that start with "The following is the Codex agent history" are transcript copies of the parent and are skipped (2,509 such messages, ~57k blocks in real data); the guardian's own verdicts are kept; `agent_id` = nickname or subagent kind (`guardian`)
- [x] Replayed parent history: only when a foreign `session_meta` follows line 1, lines before `subagent_history_start_ordinal` are skipped (checked on all 256 real children: the one replaying child shares 7 records, all before the ordinal; no other child shares any record with its parent)
- [x] Turn ids from `task_started` / `turn_context` go on every row (Task 8 matches provisional final answers by them); title = first prompt line (120 chars)
- [x] Legacy files: line 1 `{id, instructions, timestamp}` is the meta; bare `{type: message|function_call|…}` lines are response items; `record_type: state` is skipped
- [x] All text through `cleanText` / `cleanBounded` / `safeDate` (shared with the Claude parser)
- [x] Real data (915 Codex files, 234,552 lines): 63,669 rows in 18 s at 260 MB; 3,044 prompts; every tool result resolved its tool name; 0 unknown types
- [x] Verify parser tests pass

### Task 8: Incremental ingest with atomic checkpoints
- [ ] Stream sources line by line; stop at the last newline-terminated line; tolerate a partial UTF-8 sequence at the end (track byte offsets on raw `Buffer`s, decode only complete lines)
- [ ] Write rows in bounded batches (e.g. 500 lines) with `trx('messages').insert(rows).onConflict(['session_id', 'record_id', 'block_ordinal']).merge()`; each batch commits rows and the `sources` checkpoint in one `knex.transaction`
- [ ] Each batch transaction: `trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [path])`, then re-read the checkpoint row and re-validate the prefix fingerprint under the lock (parse work done before the lock is discarded if the generation moved); write rows; advance with `trx('sources').where({ path, generation: expected }).update({ …, generation: trx.raw('generation + 1') })` (Knex returns the pg `rowCount`; `generation` is a `bigint` kept as a string); a returned count of 0 throws, which rolls back the whole batch, and the caller restarts from the newer checkpoint. Resets for truncation or replacement also increment `generation`
- [ ] Detect truncation and replacement with a fingerprint of the already-checkpointed prefix (size, inode, hash of the last checkpointed bytes window), not a full-file hash; ordinary appends never replay the prefix; full-content hashes only identify immutable copies
- [ ] Tests: an append does not reparse the prior prefix; a same-size rewrite is detected and replayed; a stale writer that parsed the old file cannot commit after another writer reset and replayed a replacement back to the same offset
- [ ] Connect with `knex({ client: 'pg', connection: { connectionString, connectionTimeoutMillis: 3000, statement_timeout: 30000, application_name: 'agent-history' }, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 5000 })`; the endpoint resolver drops URL query options other than host, port, database, user and SSL, so timeouts cannot be overridden; hooks make a single connection attempt
- [ ] On serialization, deadlock or connection errors: bounded retries, then record in `ingest_errors` and leave the source `pending` for the next scan; if the DB is unreachable, append an id-only line to `~/.agent-history/ingest.log` (0600) and exit 0
- [ ] `ingest` reads hook stdin JSON as untrusted data (`session_id`, `transcript_path`, `agent_transcript_path`, `cwd`, `turn_id`, `last_assistant_message`); paths must sit under a known root; all SQL goes through the Knex builder or `raw` with `?` / `??` bindings, never string interpolation
- [ ] Store `last_assistant_message` as a provisional row; replace it when the matching transcript record arrives (Codex by `turn_id`, Claude by last assistant reply after the turn's prompt); two identical real answers both survive
- [ ] Tests with exact expected rows and checkpoints: chunked vs one-shot ingest; repeated ingest; crash between batches; 2 ingesters on the same file while it grows; partial line and partial UTF-8; transcript delayed then arriving; duplicate hook calls; plain file later replaced by its `.zst` copy; truncated and replaced file; 10 concurrent writers on different sessions; server unreachable (refused port) and a TCP listener that never completes the handshake both exit 0 within 5 s and log
- [ ] Persistence check: ingest the Task 5 seeded fixture; no seeded secret appears in `messages` (text and `raw`), `sessions`, `text_tsv` lexemes or the log
- [ ] Verify tests pass

### Task 9: Backfill via scan
- [ ] `scan` walks the Task 3 inventory; flags `--tool`, `--changed-since-last`, `--dry-run`; resumable from `sources` checkpoints after interruption
- [ ] Set budgets before running: peak RSS < 300 MB for the Node process, full scan < 30 min, DB size (`pg_database_size`) < 2 GB; revise only with a written reason
- [ ] Trial in a throwaway `agent_history_test_trial_<rand>` DB: run the full scan read-only over real transcripts, measure peak memory (`/usr/bin/time -l`), duration, `pg_database_size`, and separately the `messages` heap, `text_tsv` GIN and trigram GIN sizes (`pg_relation_size`) plus substring query latency; drop the trigram index if it does not pay for itself; keep the trial DB until Task 13's timed queries are done
- [ ] **(user)** Run `agent-history scan` into the real `agent_history` DB after `setup database`, then `ANALYZE`
- [ ] During the trial scan, ingest a synthetic appended turn from an isolated source and record its latency; live-agent checks stay user-run
- [ ] Verify unique logical sessions in the DB equal the inventory, with empty, malformed, unsupported and duplicate sources listed separately
- [ ] Verify for 3 random Claude sessions that prompt counts match `jq` over `type=="user"` lines whose content is human text (not `tool_result`), and for 3 Codex sessions that user `message` counts match
- [ ] Verify no seeded or known real key prefixes (`sk-ant-`, `ghp_`, `AKIA`) match in the DB outside `[REDACTED]`
- [ ] Record measured memory, time, size and live-ingest latency in the design doc

### Task 10: Doctor command
- [ ] Report per tool: sources missing from the DB, partial sources (checkpoint behind readable end), stale sources (not updated after their file changed), unsupported layouts, pending retries, provisional rows older than 10 minutes
- [ ] Report parse errors, unknown types, last ingest time, DB size, server version, applied schema version, and file modes of `~/.agent-history` and its contents
- [ ] Report connection health: server unreachable, `ingest.log` entries newer than the last successful ingest, current `process.execPath` differs from the `node` path recorded by `setup`, `agent_history_reader` missing or able to write, newest backup older than 8 days
- [ ] Exit non-zero only for defined unresolved failures (missing, partial, stale, unsupported, unresolved errors, stale provisional rows, wrong file modes, server unreachable, reader can write); show historical/recovered errors and unknown-type counts separately; known skipped types never fail it
- [ ] Test that a recovered source returns `doctor` to exit 0
- [ ] Add tests with fixture trees: one missing, one partial, one unsupported, one stale provisional row, one unreachable server
- [ ] Verify `agent-history doctor` exits 0 against the Task 9 trial DB

### Task 11: Hooks and recovery scan
- [ ] **(user)** Claude Code `~/.claude/settings.json`: `Stop` and `SubagentStop` (`async: true`) run `"$NODE" "/abs/repo/bin/agent-history" ingest`; `SessionStart` runs `scan --changed-since-last`; command is a fixed string with quoted absolute paths, stdin never interpolated into shell
- [ ] **(user)** Codex `~/.codex/hooks.json`: `Stop`, `SubagentStop`, `SessionStart` the same way; review and trust them via `/hooks`
- [ ] **(user)** Probe Codex 0.163 with a logging hook in an isolated `CODEX_HOME` to record the real stdin payload and which fields are null
- [ ] **(user)** Add a launchd agent running `scan --changed-since-last` every 15 minutes with the same absolute `node`, covering interrupted turns, immediate exits, missed hooks and server downtime without a new session
- [ ] **(user)** Verify the launchd job connects without a Postgres.app permission prompt (check `doctor` and `ingest.log` after the first run); if denied, allow the `node` path in Postgres.app once
- [ ] Hook failures go to `~/.agent-history/ingest.log` (0600) and `ingest_errors`, never to the session
- [ ] **(user)** Ask for a randomized reply word and verify it in the correct session with `role=assistant` and `provisional=false` within 60 s; a match in the prompt is not success
- [ ] **(user)** Verify a subagent run in both tools produces a child session linked to its parent
- [ ] **(user)** Verify recovery: kill a session mid-turn, exit immediately after a turn, and run one turn with Postgres.app stopped; the launchd scan captures all three within 15 minutes of the server being back and `doctor` exits 0
- [ ] **(user)** Measure foreground hook dispatch/return time against the 50 ms budget independently of model and network time; report paired end-to-end runs and worker latency separately as observations
- [ ] Verify a synthetic hook invocation against an unreachable server and against a DB with a broken schema exits 0 and records a private diagnostic; **(user)** verify real session completion with that setup
- [ ] **(user)** Repeat the capture and overhead checks with Codex

### Task 12: Markdown export (optional)
- [ ] `export` writes `~/.agent-history/md/<project>/<date>-<id>.md` from sanitized DB rows; directories 0700, files 0600
- [ ] Run export after each ingest for the touched session
- [ ] Verify tmp export count equals fixture session count, expected assistant fixture text is present, and no seeded secret appears; **(user)** check the live Task 11 session export

### Task 13: Discovery pointer and recall test
- [ ] Connection helpers: `ownerConnection()` and `readerConnection()` from one resolved endpoint; the reader URL sets `user=agent_history_reader` and drops any owner user or password. Tests: an owner user in the URI authority and in query parameters never leaks into the reader URL
- [ ] Generate the "Past sessions" pointer from config: the reader connection as an explicit `--dbname` URL, the absolute Postgres.app `psql` path, one tested example query per filter (project + date, keyword via `websearch_to_tsquery`, substring via `ILIKE`), the note that full-text covers only the first 100,000 characters of a message and the `ILIKE` fallback for longer ones, markdown path only if export is enabled
- [ ] **(user)** Run the pointer's connection and verify `SELECT current_user` prints `agent_history_reader`
- [ ] Pointer tells the agent to show dates and prefer newer sessions when decisions conflict
- [ ] **(user)** Add it to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`
- [ ] **(user)** Write 10 recall questions from real history with expected session ids in `tests/private/recall_cases.md` (git-ignored, 0600)
- [ ] **(user)** Run each question in a fresh session; record queries used and whether the right session was found
- [ ] **(user)** Verify at least 8 of 10 found in 3 queries or fewer; if not, add a `/recall` skill and re-run
- [ ] Verify timed queries (`EXPLAIN ANALYZE`) by date range, project, file path and keyword each return in < 1 s on the Task 9 trial DB, using the indexes from Task 4; then drop the trial DB and confirm it is gone

### Task 14: Retrospective skill
- [ ] Write a skill that pulls a project's sessions for a date range through the reader role and summarises decisions, reversals and open threads, each with date, session id and a short quote
- [ ] **(user)** Run it on a busy project over 30 days in one request
- [ ] **(user)** Verify by hand that each listed decision and reversal is supported by the quoted content in the cited session, and that later reversals supersede earlier decisions

### Task 15: Backups, maintenance and retention
- [ ] `agent-history backup`: `"$PGBIN/pg_dump" -Fc --dbname=<resolved URL>` to a temp file in `~/.agent-history/backups/`, renamed to `<date>.dump` (0600) on success; only then rotate to the last 8; credentials never logged
- [ ] `agent-history restore <dump>`: create an empty DB from `template0`, require roles to exist (provisioned by `setup database --roles-only`), `pg_restore --exit-on-error --single-transaction`, then `knex.migrate.latest()` applies only migrations newer than the dump, run `doctor`
- [ ] On the fresh restore destination only: if `knex_migrations_lock.is_locked = 1`, report it and call `knex.migrate.forceFreeMigrationsLock()` before `latest()`; never unlock a live DB automatically
- [ ] Test on test DBs: dump, restore by that exact sequence into another `agent_history_test_*` DB (also from a dump with a stale lock row), row counts and a full-text query match, no duplicate `knex_migrations` rows; no seeded secret appears in the restored rows or in `pg_restore -f -` SQL output
- [ ] **(user)** Allow Postgres.app's `pg_dump` and `psql` in the permission dialog once, interactively
- [ ] **(user)** Add a weekly launchd job running `backup`
- [ ] Test that search still works after deleting an ingested disposable fixture source
- [ ] **(user)** Exercise Claude Code's real cleanup in an isolated `CLAUDE_CONFIG_DIR` on an aged transcript and record the result
- [ ] Document the Postgres.app major-upgrade path in the runbook: `backup` on the old server, start the new one, `setup database --roles-only`, `restore`, `doctor`
- [ ] **(user)** Verify `doctor` exits 0 after a week of normal use
- [ ] **(user)** Record the real 30-day observation in the design doc as pending until the oldest ingested transcript has actually been cleaned up and is still searchable

### Task 16: Setup commands and runbook for outside steps
- [ ] `agent-history setup database|cleanup-period|hooks|launchd|pointer|mirror`, each dry-run by default (prints the exact change or SQL), `--apply` writes with a timestamped backup where a file is changed; `--home` override for tests
- [ ] `setup database` creates the `agent_history` database (owner: current user), applies migrations, creates `agent_history_reader`, and records the `node` path and connection URL in `~/.agent-history/config.json` (0600); `--roles-only` creates just the role for a restore; idempotent; tested only for its dry-run output during implementation
- [ ] `setup hooks` merges into existing `settings.json` / `hooks.json` without removing other hooks, and is idempotent
- [ ] `setup launchd` writes plists for the 15-minute scan and the weekly backup, with absolute `node` and repo paths
- [ ] `setup pointer` appends the generated pointer once, between markers, so it can be updated or removed
- [ ] Add `scripts/overhead.sh` (hook-on vs hook-off timing) and `scripts/capture-check.sh` (random reply word) for the live checks
- [ ] Write `docs/RUNBOOK.md`: ordered commands for Tasks 1, 9, 11, 13, 14, 15 user items, with how to verify and undo each (undo for `setup database` is `"$PGBIN/dropdb" agent_history` after a dump)
- [ ] Tests on temp homes and test DBs: dry-run writes nothing; apply is idempotent; existing unrelated hooks and settings survive; backups are created

## Decisions

| Question | Decision | Reason | Who |
| --- | --- | --- | --- |
| Touch global config during implementation? | No; prepare `setup` commands and a runbook | User is away until tomorrow and will run them | user |
| Live agent runs and recall questions | Left to the user, with scripts | They spend quota and need the user's memory | user |
| Stack | Node.js + PostgreSQL in Postgres.app on this Mac | Replaces Python + SQLite | user |
| Code and DB layer | Plain JavaScript (no TypeScript); Knex for queries and migrations over `pg` | User request; Knex import ~37 ms, fine for async hooks | user |
| Corrections from Codex review of `5ed0d17` | `storageEngineIndexType: 'gin'`; absolute migrations directory; advisory lock around first-time bootstrap; hooks never migrate; single connect attempt in hooks; stale restored lock freed only on the fresh destination | Checked against Knex 3.3.0 source | peer |
| Install location | Repo-local `node_modules` via `npm ci`, npm cache in `tmp/npm-cache`; hooks use absolute `node` and `bin/agent-history` paths | Repo-only scope; `PATH` and nvm defaults can change | default |
| Server objects during implementation | Only the exact throwaway `agent_history_test_*` databases each run created; no roles; the real DB and reader role come from `setup database` | Shared server with ~50 other databases; roles are cluster-wide | user |
| Corrections from Codex review of the Node/Postgres docs | Node minimum (now 22.15 again: no type stripping needed with plain JS); no role creation in tests; restore into an empty DB before migrations; `connectionTimeoutMillis`; generation-based checkpoint CAS; capped `tsvector` input; one resolved endpoint for all clients; trial DB lifetime; redrawn diagram | Verified against Node, node-postgres and PostgreSQL docs | peer |
| Plan corrections from Codex review of `ef2d173` | Block-level row keys, prefix fingerprint instead of full hash, batch rollback on CAS failure, isolated validation DB, synthetic hook tests, explicit doctor health rules | Verified against the plan text and real data | peer |
| Where setup logic lives | `agent-history setup …` subcommands instead of loose shell scripts | Testable on temp homes, dry-run by default | default |
