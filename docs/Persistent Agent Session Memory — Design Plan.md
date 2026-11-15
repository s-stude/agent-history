# Persistent Agent Session Memory — Design Plan

Nov 16, 2026 · Implements [Persistent Agent Session Memory — Proposal](Persistent%20Agent%20Session%20Memory%20—%20Proposal.md) · Task list: [plans/persistent-agent-session-memory.md](plans/persistent-agent-session-memory.md)

The task list is the execution authority. This doc records the facts and decisions behind it. Revised after a Codex peer review (findings folded in below).

Evidence marks: **[code+check]** checked on this machine; **[code]** traced, not all re-checked; **[docs]** from docs only; **[inferred]** reasoned, not run.

## Findings that shape the plan

- **The 30-day deletion is close.** `cleanupPeriodDays` is not set in `~/.claude/settings.json`, so the default applies. The oldest transcripts left are from about Nov 1, so cleanup starts deleting them around Dec 1. Backfill happens early, but only after redaction exists, so unredacted production data never lands in the DB. **[code+check]**
- **Claude Code data is large.** `~/.claude/projects` holds about 6.7 GB in 1095 JSONL files, 723 of them subagent transcripts. 4 files exceed 100 MB; the largest is about 170 MB. Ingest must stream and batch. **[code+check]**
- **Most Codex history is compressed or archived.** `~/.codex/sessions` has 126 `.jsonl` and 687 `.jsonl.zst` files; `~/.codex/archived_sessions` has 99 more. A plain-JSONL scanner would miss about 786 sessions. Python 3.14's `compression.zstd` reads them, so the minimum Python is 3.14. **[code+check]**
- **Claude subagents share the parent's session id.** In a subagent transcript, `sessionId` equals the parent's id; only `agentId` tells children apart. Keying sessions by `sessionId` would merge children into their parent. **[code+check]**
- **Both tools support hooks.** Codex 0.163 reports `hooks stable true` in `codex features list` **[code+check]**. Codex reads `~/.codex/hooks.json` with `SessionStart`, `Stop`, `SubagentStop`; user hooks must be trusted via `/hooks`; async hooks may finish out of order and are cancelled at session end **[docs]**. Claude Code `SubagentStop` gives the child transcript in `agent_transcript_path` **[docs]**.
- **Tooling.** Python 3.14 stdlib `sqlite3` (3.53) builds FTS5 tables **[code+check]**. The system `sqlite3` CLI is 3.43; FTS5 `MATCH` from the CLI is not yet confirmed.
- **Transcript formats differ.** Claude Code: `user` / `assistant` lines, where `user` lines also wrap tool results, plus noise (`attachment`, `mode`, `permission-mode`, `bridge-session`, …). Codex: `{timestamp, type, payload}` records; `session_meta`, `response_item` (`message` with `phase`, `function_call`, `custom_tool_call`, outputs by `call_id`, `reasoning`), and `event_msg` records that mirror the same content. **[code+check]** for types; details of `phase` and mirroring are from the Codex review **[docs]**.
- **Codex retention is unknown.** No age-based deletion was found, but Codex has archive, delete and `migrate-rollouts` commands, and ephemeral sessions are never written. The DB stays the independent store either way.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Which tools? | Claude Code and Codex, including compressed and archived Codex sessions | Both in active use **[code+check]** |
| Which machines? | One Mac, no merging | Non-goal in the proposal |
| Language? | Python 3.14+, stdlib only, one `agent-history` CLI | `sqlite3` + `compression.zstd`, no dependencies |
| Session identity | Roots: `(tool, native_id)`. Claude children: `(claude, parent_id, agent_id)`. Native ids kept in their own columns | Avoids merging subagents into parents |
| Message identity | Claude: line `uuid`. Codex: `(session_id, line number in the decompressed stream)` plus a content hash | Stable when a file is compressed or archived; hash detects replacement |
| Read position | Plain active files: byte offset in the file. `.zst` and archived files: treated as immutable, replayed whole once, keyed by content hash | Compressed files have no stable byte offsets |
| Checkpoints | Rows and checkpoint commit in one transaction; checkpoint only moves forward (compare-and-set) | No lost or duplicated turns under crashes or concurrent ingests |
| Final answer from hook | Store `last_assistant_message` as a provisional row; replace it when the matching transcript record arrives (Codex by `turn_id`, Claude by last assistant reply after the turn's prompt) | Transcript can lag; avoids duplicates without text-based dedup |
| `raw` column | Sanitized source line, bounded to 2 KB, plus source path and line number | Full fidelity stays in the source or the optional mirror; keeps trimming meaningful |
| Redaction | Parse each record, walk every string value (decoding JSON-in-strings), redact before trimming; applies to all stored fields, exports and logs. Logs never contain message text | Escaped PEM, nested tool args and metadata otherwise slip through |
| Capture guarantee | Turns whose hook fires are in the DB within 60 s. Missed hooks, interrupts and immediate exits are recovered by `SessionStart` scan and a 15-minute launchd scan | Async hooks can be cancelled; recovery must not depend on a future session |
| Subagents | Captured live via `SubagentStop` in both tools, with parent link | 723 Claude child transcripts hold real work |
| Failure handling | Hooks never fail the session, but every failure is recorded in the DB and shown by `doctor` | Fail-open must stay observable |
| File privacy | `~/.agent-history` is 0700; DB, WAL/SHM, logs, exports 0600; optional raw mirror is unredacted and also 0700 | Sidecars and logs hold the same text |
| LLM summary per session | Not in v1 | Add only if the recall test fails |
| `/recall` | Not at first; pointer only | Add if the recall test shows the agent struggling |
| Retrospective | A skill | Needs multi-step instructions |

## Steps

Tasks 1–9 are urgent because of the Dec 1 deletion. All destructive tests (corruption, cleanup, moved files) run against isolated test homes and DBs, never against the real archive.

| Task | What | Key check |
| --- | --- | --- |
| 1 | Raise `cleanupPeriodDays` to 36500; optional private raw mirror | Setting reads back; transcript count does not drop |
| 2 | Skeleton, install, CLI smoke test, `.gitignore` for DB sidecars and private data | Installed `agent-history --help` runs; smoke test passes |
| 3 | Source inventory and identity contract | Inventory matches `find` counts per tool and encoding; parent + 2 children get distinct ids |
| 4 | Schema, private file setup, coverage and diagnostics tables | FTS insert/update/delete stay in sync; 0700/0600 on DB, sidecars, custom path |
| 5 | Sanitizer (unit level) | Seeded secrets in every form are removed; hashes and UUIDs survive |
| 6 | Claude Code parser | Golden tests incl. tool-result wrappers and parent + children |
| 7 | Codex parser (plain and `.zst`) | Golden tests incl. call/output pairs, `phase`, no double count from `event_msg` |
| 8 | Incremental ingest with atomic checkpoints | Exact rows and checkpoints after crash, concurrent append, partial line, truncation, compression |
| 9 | Backfill, bounded and resumable | Inventory reconciles; seeded secrets absent; memory/time within budget |
| 10 | `doctor` | Reports missing, partial, stale, unsupported sources and errors |
| 11 | Hooks for both tools, plus launchd recovery scan | Final answer captured within 60 s; foreground overhead < 50 ms |
| 12 | Markdown export (optional) | Count matches; seeded secrets absent |
| 13 | Discovery pointer and recall test | 8/10 found in ≤ 3 queries; timed filter queries |
| 14 | Retrospective skill | One request; every decision/reversal backed by cited content |
| 15 | Maintenance and retention | Disposable aged fixture survives real cleanup; real 30-day observation pending until seen |

Per-task steps and checks live in the task list.

## Success criteria coverage

| Success criterion | Verified in | Note |
| --- | --- | --- |
| 1. Every session saved within one turn | Tasks 10, 11 | Narrowed: within 60 s when the hook fires; otherwise at the next recovery scan (≤ 15 min) |
| 2. Searchable after the 30-day cleanup | Task 15 | Disposable aged fixture now; real observation recorded later |
| 3. 8 of 10 test questions answered in 3 queries or fewer | Task 13 | Private recall cases, not committed |
| 4. Retrospective in one request | Task 14 | Checked against cited content, not ids only |
| 5. Under 50 ms of visible delay | Task 11 | Hook-enabled vs disabled foreground time |
| 6. No unredacted keys | Tasks 5, 8, 9, 12 | Seeded set only; regexes cannot catch arbitrary credentials |
