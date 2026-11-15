import subprocess
import sys

from agent_history.cli import COMMANDS


def test_help_lists_all_subcommands():
    result = subprocess.run([sys.executable, "-m", "agent_history", "--help"], capture_output=True, text=True)
    assert result.returncode == 0
    for name in COMMANDS:
        assert name in result.stdout
