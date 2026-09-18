"""Global flags must work on BOTH sides of the subcommand.

`relic status --json` is how the TypeScript CLI is used, and relicpy is meant to be
the same app. argparse binds a top-level flag only before the subcommand name, so
without this the natural form exits 2 with "unrecognized arguments".

Both directions are tested because fixing one broke the other: adding
`parents=[common]` made `status --json` work and made `--json status` stop working,
since the subparser's default overwrote the value the top-level parser had already
parsed. `default=SUPPRESS` is what makes both hold at once.
"""

import json
import subprocess
import sys

import pytest


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "relicpy.cli", *args],
                          capture_output=True, text=True, timeout=300)


@pytest.mark.parametrize("args", [
    ["status", "--json"],
    ["--json", "status"],
    ["banks", "--json"],
    ["--json", "banks"],
])
def test_json_flag_works_on_either_side_of_the_subcommand(args):
    p = run(args)
    if p.returncode != 0 and "no shards" in (p.stdout + p.stderr):
        pytest.skip("no index on this machine")
    # An exit-2 usage error with stderr swallowed reads as an empty success, which is
    # exactly how this shipped. Assert the code, not just the output.
    assert p.returncode == 0, f"exit {p.returncode}: {p.stderr.strip()[:200]}"
    assert p.stdout.strip(), "empty stdout"
    json.loads(p.stdout)


def test_pretty_output_is_still_the_default():
    p = run(["status", "--limit", "1"])
    if "no shards" in (p.stdout + p.stderr):
        pytest.skip("no index on this machine")
    assert p.returncode == 0
    assert not p.stdout.lstrip().startswith(("{", "["))
