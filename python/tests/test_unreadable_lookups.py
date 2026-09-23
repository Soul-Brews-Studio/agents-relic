"""Follow-up to #99 in relicpy: the shard listing, the repo index and the live uuid walk.

Mirrors test/unreadable-lookups.test.ts where relicpy has the same code. Each of these
answered a failed scandir with nothing — an unreadable bank made its shards vanish from
search, and one unreadable org ended the repo-index walk for every org after it.
"""

import errno
import os

import pytest

from relicpy import live as L
from relicpy import repo as R
from relicpy import sources as S
from relicpy import unreadable as U

as_root = pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0,
                             reason="root reads a chmod 000 directory anyway")


@pytest.fixture
def lock():
    """chmod 000, and put it back afterwards so the temp dir can be removed."""
    held = []

    def _lock(p):
        os.chmod(p, 0)
        held.append(p)
    yield _lock
    for p in held:
        os.chmod(p, 0o755)


def _said(capsys) -> list[str]:
    return [l for l in capsys.readouterr().err.splitlines() if l.startswith("relic:")]


@as_root
def test_an_unreadable_bank_is_reported_and_the_rest_still_list(tmp_path, capsys, lock):
    (tmp_path / "banks" / "projects" / "github.com" / "o" / "r").mkdir(parents=True)
    bad = tmp_path / "banks" / "locked-bank"
    (bad / "github.com" / "o" / "r").mkdir(parents=True)
    lock(bad)

    keys = [s.key for s in R.list_shards(str(tmp_path))]
    assert keys == ["projects/github.com/o/r"]
    said = _said(capsys)
    assert len(said) == 1 and str(bad) in said[0]


@as_root
def test_one_unreadable_org_no_longer_ends_the_repo_index(tmp_path, capsys, lock, monkeypatch):
    for org in ("a-org", "m-org", "z-org"):
        (tmp_path / "github.com" / org / f"{org}-repo").mkdir(parents=True)
    lock(tmp_path / "github.com" / "m-org")
    monkeypatch.setattr(R, "_cached_ghq_root", str(tmp_path))
    monkeypatch.setattr(R, "_repo_index_cache", None)

    assert sorted(R.repo_index()) == ["a-org-repo", "z-org-repo"]
    said = _said(capsys)
    assert len(said) == 1 and str(tmp_path / "github.com" / "m-org") in said[0]


@as_root
def test_the_live_uuid_walk_reports_what_os_walk_would_drop(tmp_path, capsys, lock, monkeypatch):
    projects = tmp_path / ".claude" / "projects"
    (projects / "-work-ok").mkdir(parents=True)
    bad = projects / "-work-locked"
    bad.mkdir()
    lock(bad)
    monkeypatch.setattr(S, "HOME", str(tmp_path))

    # An id that is nowhere, so the walk visits every directory whatever scandir's order.
    assert L.session_by_uuid("ffffffff-0000-4000-8000-000000000000", str(tmp_path)) is None
    said = _said(capsys)
    assert len(said) == 1 and str(bad) in said[0]


def test_a_name_too_long_to_exist_is_absence_not_an_error(tmp_path, capsys):
    """ENAMETOOLONG joins ENOENT: a cwd encoded into a directory name can pass the
    filesystem's limit, and a name that cannot exist is not an unreadable directory."""
    U.begin_walk()
    p = str(tmp_path / ("x" * 300))
    with pytest.raises(OSError) as e:
        os.scandir(p)
    assert e.value.errno == errno.ENAMETOOLONG
    U.dir_unreadable(p, e.value)
    assert _said(capsys) == []
    assert U.walk_failures() == []
