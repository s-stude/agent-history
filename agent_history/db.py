import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    native_id TEXT NOT NULL,
    parent_id TEXT,
    agent_id TEXT,
    workflow_id TEXT,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    project TEXT,
    cwd TEXT,
    started_at TEXT,
    ended_at TEXT,
    title TEXT,
    source_path TEXT,
    cli_version TEXT
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project, started_at);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    record_id TEXT NOT NULL,
    block INTEGER NOT NULL,
    ts TEXT,
    role TEXT,
    phase TEXT,
    kind TEXT NOT NULL,
    text TEXT,
    tool_name TEXT,
    files TEXT,
    turn_id TEXT,
    provisional INTEGER NOT NULL DEFAULT 0,
    raw TEXT,
    source_path TEXT,
    source_line INTEGER,
    content_hash TEXT,
    parser_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_ts ON messages(session_id, ts);
CREATE INDEX IF NOT EXISTS messages_files ON messages(files) WHERE files IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, content='messages', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS sources (
    path TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    session_id TEXT NOT NULL,
    segment TEXT NOT NULL,
    encoding TEXT NOT NULL,
    immutable INTEGER NOT NULL,
    content_hash TEXT,
    inode INTEGER,
    size INTEGER,
    mtime_ns INTEGER,
    offset INTEGER NOT NULL DEFAULT 0,
    last_line INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_errors (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    source_path TEXT,
    line INTEGER,
    error_class TEXT NOT NULL,
    detail TEXT,
    resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS ingest_errors_open ON ingest_errors(source_path) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS unknown_types (
    tool TEXT NOT NULL,
    type TEXT NOT NULL,
    subtype TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tool, type, subtype)
);
"""

SIDECARS = ("-wal", "-shm", "-journal")


class SchemaTooNew(RuntimeError):
    pass


def default_db_path() -> Path:
    env = os.environ.get("AGENT_HISTORY_DB")
    return Path(env) if env else Path.home() / ".agent-history" / "history.db"


def ensure_private_dir(path: Path) -> None:
    created = not path.exists()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if created or path.name == ".agent-history":
        path.chmod(0o700)


def tighten_modes(db_path: Path) -> None:
    for p in [db_path, *(db_path.with_name(db_path.name + s) for s in SIDECARS)]:
        if p.exists():
            p.chmod(0o600)


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    db_path = Path(db_path or default_db_path())
    ensure_private_dir(db_path.parent)
    old = os.umask(0o077)
    try:
        conn = sqlite3.connect(db_path, timeout=5.0, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
    finally:
        os.umask(old)
    conn.row_factory = sqlite3.Row
    migrate(conn)
    tighten_modes(db_path)
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise SchemaTooNew(f"database schema {version} is newer than supported {SCHEMA_VERSION}")
    if version == SCHEMA_VERSION:
        return
    with transaction(conn):
        for stmt in _statements(SCHEMA):
            conn.execute(stmt)
        conn.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


def _statements(script: str) -> list[str]:
    out, buf = [], ""
    for line in script.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            if buf.strip():
                out.append(buf.strip())
            buf = ""
    return out


@contextmanager
def transaction(conn: sqlite3.Connection):
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
