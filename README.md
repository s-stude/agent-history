# agent-history

Permanent, searchable store of Claude Code and Codex sessions in one local SQLite database.

Design: [docs/Persistent Agent Session Memory — Design Plan.md](docs/Persistent%20Agent%20Session%20Memory%20—%20Design%20Plan.md) · Tasks: [docs/plans/persistent-agent-session-memory.md](docs/plans/persistent-agent-session-memory.md)

## Install

Requires Python 3.14+ and [uv](https://docs.astral.sh/uv/).

```bash
uv sync --python python3.14
.venv/bin/python -m pytest -q
```

Run from the repository root with Python 3.14 already installed. `pyproject.toml` pins uv's cache to `tmp/uv-cache` and disables managed Python downloads, so the environment and cache stay inside the repository. Hooks and launchd jobs call the CLI by absolute path:

- interpreter: `<repo>/.venv/bin/python`
- CLI: `<repo>/.venv/bin/agent-history`

On this machine `<repo>` is `/Users/ahalilov/Documents/projects/harness-sessions-sqlite`.
