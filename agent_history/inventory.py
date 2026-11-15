import compression.zstd as zstd
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CODEX_NAME = re.compile(rf"^rollout-(?P<ts>[0-9T:-]+)-(?P<thread>{UUID})(?:_(?P<page>{UUID}))?\.jsonl(?P<zst>\.zst)?$")
CLAUDE_MAIN = re.compile(rf"^(?P<sid>{UUID})\.jsonl$")
CLAUDE_AGENT = re.compile(r"^agent-(?P<aid>[0-9a-zA-Z_-]+)\.jsonl$")


@dataclass(frozen=True)
class Roots:
    claude_projects: Path
    codex_sessions: Path
    codex_archived: Path

    @classmethod
    def from_env(cls, home: Path | None = None) -> "Roots":
        home = home or Path.home()
        claude = Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude"))
        codex = Path(os.environ.get("CODEX_HOME", home / ".codex"))
        return cls(
            Path(os.environ.get("AGENT_HISTORY_CLAUDE_PROJECTS", claude / "projects")),
            Path(os.environ.get("AGENT_HISTORY_CODEX_SESSIONS", codex / "sessions")),
            Path(os.environ.get("AGENT_HISTORY_CODEX_ARCHIVED", codex / "archived_sessions")),
        )


@dataclass(frozen=True)
class Source:
    tool: str
    path: Path
    encoding: str
    archived: bool
    segment: str
    session_key: str
    native_id: str
    parent_key: str | None = None
    agent_id: str | None = None
    workflow_id: str | None = None

    @property
    def immutable(self) -> bool:
        return self.encoding == "zst" or self.archived


@dataclass
class Inventory:
    sources: list[Source] = field(default_factory=list)
    unsupported: list[Path] = field(default_factory=list)
    empty: list[Path] = field(default_factory=list)
    skipped: list[Path] = field(default_factory=list)

    def sessions(self) -> set[str]:
        return {s.session_key for s in self.sources}

    def duplicate_segments(self) -> dict[str, list[Path]]:
        by: dict[str, list[Path]] = {}
        for s in self.sources:
            by.setdefault(f"{s.tool}:{s.segment}", []).append(s.path)
        return {k: v for k, v in by.items() if len(v) > 1}

    def counts(self) -> Counter:
        c: Counter = Counter()
        for s in self.sources:
            kind = "child" if s.parent_key else "root"
            place = "archived" if s.archived else "active"
            c[(s.tool, s.encoding, place, kind)] += 1
        return c


def claude_session_key(session_id: str, agent_id: str | None = None) -> str:
    return f"claude:{session_id}/agent:{agent_id}" if agent_id else f"claude:{session_id}"


def codex_session_key(thread_id: str) -> str:
    return f"codex:{thread_id}"


def open_source(source: Source):
    if source.encoding == "zst":
        return zstd.open(source.path, "rb")
    return open(source.path, "rb")


def record_id(source: Source, native_record_id: str | None, line_no: int) -> str:
    if source.tool == "claude" and native_record_id:
        return native_record_id
    return f"{source.segment}:{line_no}"


def row_key(session_key: str, record: str, block: int) -> str:
    return f"{session_key}|{record}|{block}"


def classify_claude(path: Path, root: Path) -> Source | None:
    rel = path.relative_to(root).parts
    if len(rel) == 2 and (m := CLAUDE_MAIN.match(rel[1])):
        sid = m["sid"]
        return Source("claude", path, "plain", False, sid, claude_session_key(sid), sid)
    m = CLAUDE_AGENT.match(rel[-1])
    if not m or len(rel) < 4 or rel[2] != "subagents" or not re.fullmatch(UUID, rel[1]):
        return None
    if len(rel) == 4:
        workflow = None
    elif len(rel) == 6 and rel[3] == "workflows":
        workflow = rel[4]
    else:
        return None
    parent, aid = rel[1], m["aid"]
    return Source(
        "claude", path, "plain", False, f"{parent}/agent-{aid}",
        claude_session_key(parent, aid), parent,
        parent_key=claude_session_key(parent), agent_id=aid, workflow_id=workflow,
    )


def classify_codex(path: Path, archived: bool) -> Source | None:
    m = CODEX_NAME.match(path.name)
    if not m:
        return None
    segment = path.name.removesuffix(".zst").removesuffix(".jsonl")
    return Source(
        "codex", path, "zst" if m["zst"] else "plain", archived, segment,
        codex_session_key(m["thread"]), m["thread"],
    )


def _walk(root: Path):
    if not root.is_dir():
        return
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            yield Path(dirpath) / name


def build_inventory(roots: Roots) -> Inventory:
    inv = Inventory()

    def add(path: Path, source: Source | None):
        if source is None:
            inv.unsupported.append(path)
        elif path.stat().st_size == 0:
            inv.empty.append(path)
        else:
            inv.sources.append(source)

    for path in _walk(roots.claude_projects):
        if path.suffix != ".jsonl":
            continue
        if path.name == "journal.jsonl" and "workflows" in path.parts:
            inv.skipped.append(path)
        else:
            add(path, classify_claude(path, roots.claude_projects))
    for root, archived in ((roots.codex_sessions, False), (roots.codex_archived, True)):
        for path in _walk(root):
            if ".jsonl" in path.name:
                add(path, classify_codex(path, archived))
    inv.sources.sort(key=lambda s: (s.tool, str(s.path)))
    return inv
