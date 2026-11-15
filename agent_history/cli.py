import argparse
import sys

from agent_history import db
from agent_history.inventory import Roots, build_inventory

COMMANDS = {
    "init": "Create or migrate the history database",
    "ingest": "Ingest one session from hook stdin JSON",
    "scan": "Ingest every known transcript source",
    "export": "Write markdown copies of sessions",
    "doctor": "Report missing, partial and failed sources",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agent-history", description="Searchable store of agent sessions")
    sub = parser.add_subparsers(dest="command", required=True)
    subs = {name: sub.add_parser(name, help=help_text) for name, help_text in COMMANDS.items()}
    subs["scan"].add_argument("--dry-run", action="store_true", help="Print the source inventory and exit")
    return parser


def print_inventory() -> int:
    inv = build_inventory(Roots.from_env())
    for (tool, encoding, place, kind), n in sorted(inv.counts().items()):
        print(f"{tool}\t{encoding}\t{place}\t{kind}\t{n}")
    print(f"sessions\t{len(inv.sessions())}")
    print(f"duplicate_segments\t{len(inv.duplicate_segments())}")
    print(f"empty\t{len(inv.empty)}")
    print(f"skipped\t{len(inv.skipped)}")
    print(f"unsupported\t{len(inv.unsupported)}")
    print(f"unreadable\t{len(inv.unreadable)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "scan" and args.dry_run:
        return print_inventory()
    if args.command == "init":
        path = db.default_db_path()
        db.connect(path).close()
        print(path)
        return 0
    print(f"agent-history {args.command}: not implemented yet", file=sys.stderr)
    return 2
