import compression.zstd as zstd
from pathlib import Path

from agent_history.cli import main
from agent_history.inventory import build_inventory, open_source, record_id, row_key

PARENT = "43cec861-2203-414b-bfc7-b732d4b880f0"
THREAD = "01a0813d-de8d-7a63-885f-1777a897b70c"
PAGE = "01a081dc-35cd-70a2-a4ae-9c854f58da93"
LINE = '{"type":"session_meta","payload":{"id":"%s"}}\n' % THREAD


def write(path: Path, text: str = '{"type":"user"}\n') -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


def write_zst(path: Path, text: str = LINE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zstd.open(path, "wt") as fh:
        fh.write(text)
    return path


def claude_tree(root: Path):
    proj = root / "-Users-me-proj"
    write(proj / f"{PARENT}.jsonl")
    write(proj / PARENT / "subagents" / "agent-a1.jsonl")
    write(proj / PARENT / "subagents" / "agent-a2.jsonl")
    write(proj / PARENT / "subagents" / "workflows" / "wf_x" / "agent-a3.jsonl")


def test_parent_and_children_get_distinct_ids(roots):
    claude_tree(roots.claude_projects)
    inv = build_inventory(roots)
    keys = {s.session_key for s in inv.sources}
    assert keys == {
        f"claude:{PARENT}",
        f"claude:{PARENT}/agent:a1",
        f"claude:{PARENT}/agent:a2",
        f"claude:{PARENT}/agent:a3",
    }
    children = [s for s in inv.sources if s.parent_key]
    assert {s.parent_key for s in children} == {f"claude:{PARENT}"}
    assert {s.native_id for s in children} == {PARENT}
    assert next(s for s in children if s.agent_id == "a3").workflow_id == "wf_x"


def test_codex_copies_share_one_identity_and_segment(roots):
    name = f"rollout-2026-09-08T16-38-30-{THREAD}.jsonl"
    write(roots.codex_sessions / "2026/09/08" / name, LINE)
    write_zst(roots.codex_sessions / "2026/09/08" / (name + ".zst"))
    write_zst(roots.codex_archived / (name + ".zst"))
    inv = build_inventory(roots)
    assert inv.sessions() == {f"codex:{THREAD}"}
    assert len({s.segment for s in inv.sources}) == 1
    assert list(inv.duplicate_segments().values())[0].__len__() == 3
    assert {(s.encoding, s.archived, s.immutable) for s in inv.sources} == {
        ("plain", False, False), ("zst", False, True), ("zst", True, True)}


def test_codex_page_file_is_extra_segment_of_same_thread(roots):
    write_zst(roots.codex_sessions / "2026/09/08" / f"rollout-2026-09-08T16-38-30-{THREAD}.jsonl.zst")
    write_zst(roots.codex_sessions / "2026/09/08" / f"rollout-2026-09-08T19-31-27-{THREAD}_{PAGE}.jsonl.zst")
    inv = build_inventory(roots)
    assert inv.sessions() == {f"codex:{THREAD}"}
    assert len({s.segment for s in inv.sources}) == 2
    assert inv.duplicate_segments() == {}


def test_unsupported_and_empty_are_reported(roots):
    write(roots.claude_projects / "-p" / "notes.jsonl")
    write(roots.claude_projects / "-p" / PARENT / "subagents" / "deep" / "x" / "y" / "agent-z.jsonl")
    write(roots.codex_sessions / "weird.jsonl")
    (roots.claude_projects / "-p" / f"{PARENT}.jsonl").write_text("")
    write(roots.claude_projects / "-p" / "sessions-index.json", "{}")
    write(roots.claude_projects / "-p" / PARENT / "subagents" / "workflows" / "wf_x" / "journal.jsonl")
    inv = build_inventory(roots)
    assert inv.sources == []
    assert len(inv.skipped) == 1
    assert len(inv.unsupported) == 3
    assert len(inv.empty) == 1


def test_record_and_row_keys(roots):
    write(roots.codex_sessions / f"rollout-2026-09-08T16-38-30-{THREAD}.jsonl", LINE)
    claude_tree(roots.claude_projects)
    inv = build_inventory(roots)
    codex = next(s for s in inv.sources if s.tool == "codex")
    claude = next(s for s in inv.sources if s.tool == "claude")
    assert record_id(codex, "ignored", 7) == f"rollout-2026-09-08T16-38-30-{THREAD}:7"
    assert record_id(claude, "uuid-1", 7) == "uuid-1"
    assert record_id(claude, None, 7) == f"{claude.segment}:7"
    assert row_key("claude:s", "uuid-1", 0) != row_key("claude:s", "uuid-1", 1)


def test_scan_dry_run_prints_counts(roots, capsys):
    claude_tree(roots.claude_projects)
    assert main(["scan", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "claude\tplain\tactive\tchild\t3" in out
    assert "sessions\t4" in out


def test_open_source_streams_plain_and_zst_identically(roots):
    name = f"rollout-2026-09-08T16-38-30-{THREAD}.jsonl"
    write(roots.codex_sessions / name, LINE * 3)
    write_zst(roots.codex_archived / (name + ".zst"), LINE * 3)
    contents = set()
    for src in build_inventory(roots).sources:
        with open_source(src) as fh:
            contents.add(fh.read())
    assert contents == {(LINE * 3).encode()}
