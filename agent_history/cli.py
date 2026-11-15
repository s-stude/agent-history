import argparse
import sys

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
    for name, help_text in COMMANDS.items():
        sub.add_parser(name, help=help_text)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    print(f"agent-history {args.command}: not implemented yet", file=sys.stderr)
    return 2
