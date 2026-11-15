import sqlite3
import stat
from pathlib import Path

import pytest

from agent_history import db
from agent_history.cli import main


def mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


def add_session(conn, sid="claude:s1"):
    conn.execute("INSERT INTO sessions(id, tool, native_id) VALUES (?, 'claude', 's1')", (sid,))


def add_message(conn, mid, text, sid="claude:s1"):
    conn.execute(
        "INSERT INTO messages(id, session_id, record_id, block, kind, text, parser_version) VALUES (?, ?, ?, 0, 'text', ?, 1)",
        (mid, sid, mid, text),
    )


def fts(conn, q):
    return [r[0] for r in conn.execute(
        "SELECT m.id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY m.id", (q,))]


def test_init_is_idempotent(tmp_path):
    path = tmp_path / "h" / "history.db"
    conn = db.connect(path)
    add_session(conn)
    conn.close()
    conn = db.connect(path)
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


@pytest.mark.parametrize("use_default", [True, False])
def test_private_modes_for_db_and_sidecars(tmp_path, monkeypatch, use_default):
    if use_default:
        monkeypatch.delenv("AGENT_HISTORY_DB", raising=False)
        monkeypatch.setenv("HOME", str(tmp_path))
        path = tmp_path / ".agent-history" / "history.db"
    else:
        path = tmp_path / "custom" / "nested" / "my.db"
        monkeypatch.setenv("AGENT_HISTORY_DB", str(path))
    assert db.default_db_path() == path
    conn = db.connect()
    add_session(conn)
    for suffix in ("", "-wal", "-shm"):
        p = path.with_name(path.name + suffix)
        assert p.exists(), suffix
        assert mode(p) == 0o600, suffix
    assert mode(path.parent) == 0o700
    conn.close()


def test_fts_tracks_insert_update_delete(tmp_path):
    conn = db.connect(tmp_path / "h.db")
    add_session(conn)
    add_message(conn, "m1", "the pelican flew")
    add_message(conn, "m2", "a kumquat rolled")
    assert fts(conn, "pelican") == ["m1"]
    conn.execute("UPDATE messages SET text = 'the heron flew' WHERE id = 'm1'")
    assert fts(conn, "pelican") == []
    assert fts(conn, "heron") == ["m1"]
    conn.execute(
        "INSERT INTO messages(id, session_id, record_id, block, kind, text, parser_version) VALUES ('m2', 'claude:s1', 'm2', 0, 'text', 'an orange rolled', 1) "
        "ON CONFLICT(id) DO UPDATE SET text = excluded.text")
    assert fts(conn, "kumquat") == []
    assert fts(conn, "orange") == ["m2"]
    conn.execute("DELETE FROM messages WHERE id = 'm2'")
    assert fts(conn, "orange") == []
    conn.execute("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')")


def test_newer_schema_is_refused(tmp_path):
    path = tmp_path / "h.db"
    raw = sqlite3.connect(path)
    raw.execute(f"PRAGMA user_version={db.SCHEMA_VERSION + 1}")
    raw.close()
    with pytest.raises(db.SchemaTooNew):
        db.connect(path)


def test_transaction_rolls_back(tmp_path):
    conn = db.connect(tmp_path / "h.db")
    with pytest.raises(RuntimeError):
        with db.transaction(conn):
            add_session(conn)
            raise RuntimeError
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0


def test_cli_init_uses_isolated_path(roots, tmp_path, capsys):
    assert main(["init"]) == 0
    assert capsys.readouterr().out.strip() == str(tmp_path / "history.db")
    assert (tmp_path / "history.db").exists()
