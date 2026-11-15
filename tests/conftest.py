import tempfile
from pathlib import Path

import pytest

from agent_history.inventory import Roots

REPO = Path(__file__).resolve().parents[1]


def pytest_configure(config):
    if config.option.basetemp is None:
        base = REPO / "tmp" / "pytest"
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        config.option.basetemp = tempfile.mkdtemp(prefix="run-", dir=base)


@pytest.fixture
def roots(tmp_path: Path, monkeypatch) -> Roots:
    r = Roots(tmp_path / "claude/projects", tmp_path / "codex/sessions", tmp_path / "codex/archived_sessions")
    for p in (r.claude_projects, r.codex_sessions, r.codex_archived):
        p.mkdir(parents=True)
    monkeypatch.setenv("AGENT_HISTORY_CLAUDE_PROJECTS", str(r.claude_projects))
    monkeypatch.setenv("AGENT_HISTORY_CODEX_SESSIONS", str(r.codex_sessions))
    monkeypatch.setenv("AGENT_HISTORY_CODEX_ARCHIVED", str(r.codex_archived))
    monkeypatch.setenv("AGENT_HISTORY_DB", str(tmp_path / "history.db"))
    return r
