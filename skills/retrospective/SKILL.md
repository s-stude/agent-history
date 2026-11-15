---
name: retrospective
description: Write a retrospective of a project's past Claude Code and Codex sessions for a date range from the agent-history PostgreSQL database — decisions, reversals and open threads, each backed by a dated quote and session id. Use when the user asks for a retro, a summary of what happened in a project over some period, what was decided, what changed course, or what is still open.
---

# Project retrospective from agent history

All past sessions live in the `agent_history` PostgreSQL database. Query it **read-only** through the reader connection given in the "Past sessions" section of CLAUDE.md / AGENTS.md (`psql --dbname="postgresql://agent_history_reader@…/agent_history"`). Never write to it.

## Inputs

- **Project**: the `sessions.project` value (folder name of the repo). If unsure, list candidates first:
  `SELECT project, count(*), max(started_at) FROM sessions GROUP BY project ORDER BY max(started_at) DESC LIMIT 20`
- **Date range**: default the last 30 days.

## Steps

1. **Sessions in range** (main sessions first, children for detail):
   ```sql
   SELECT id, tool, started_at, ended_at, title, parent_id
     FROM sessions
    WHERE project = :project AND started_at >= :from AND started_at < :to
    ORDER BY started_at;
   ```
2. **What was asked and answered** — human prompts and final answers, oldest first:
   ```sql
   SELECT m.session_id, m.ts, m.role, m.kind, m.phase, left(m.text, 1500) AS text
     FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.project = :project AND m.ts >= :from AND m.ts < :to
      AND (m.kind = 'prompt' OR (m.role = 'assistant' AND m.kind = 'text' AND coalesce(m.phase, 'final_answer') = 'final_answer'))
      AND NOT m.provisional
    ORDER BY m.ts;
   ```
   For long ranges, page with `LIMIT 200 OFFSET …` and work session by session.
3. **Decision and reversal signals** — search, then read the surrounding messages of each hit:
   ```sql
   SELECT m.session_id, m.ts, ts_headline('simple', m.text, q, 'MaxWords=40') AS hit
     FROM messages m JOIN sessions s ON s.id = m.session_id,
          websearch_to_tsquery('simple', 'decided OR decision OR instead OR revert OR switch OR "go with" OR drop OR rollback') q
    WHERE s.project = :project AND m.ts >= :from AND m.ts < :to AND m.text_tsv @@ q
    ORDER BY m.ts;
   ```
   Also check `kind = 'summary'` rows: compacted sessions keep their summary there.
4. **Files touched** (to anchor themes): `SELECT unnest(files) AS f, count(*) FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.project = :project AND m.ts >= :from AND m.ts < :to GROUP BY f ORDER BY 2 DESC LIMIT 30`.

## Output

```markdown
# Retrospective: <project>, <from> – <to>

## Summary
<3–5 sentences: what the period was about and where it ended up>

## Decisions
- <YYYY-MM-DD> — <decision> — "<short quote, ≤ 25 words>" (`<session id>`)

## Reversals
- <YYYY-MM-DD> — <what changed, from → to> — "<quote>" (`<session id>`); supersedes <date> (`<session id>`)

## Open threads
- <item> — last touched <YYYY-MM-DD> (`<session id>`)
```

## Rules

- Every decision, reversal and open thread cites a date, a session id and a quote taken from the message text you read. No citation, no item.
- When two sessions disagree, the later one wins; list the earlier one under Reversals, not under Decisions.
- Quote only what the rows contain; text may include `[REDACTED:…]` markers — keep them as is.
- Prefer final answers and prompts over tool output; tool results are trimmed to 500 characters.
- Say plainly when the range has no sessions or the evidence for a section is thin.
