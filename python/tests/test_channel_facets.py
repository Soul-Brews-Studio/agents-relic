"""Mirror of test/channel.test.ts: channel envelopes parsed into facets (#85, #86).

The pairs are not copied here — they are READ from test/fixtures/channel-envelopes.json,
the same file the TypeScript suite reads, so a case added on one side is a case the
other must pass. Both implementations write the same six EventRow columns and three
SessionRow columns into one shared index, so a parser that disagrees by one attribute
is a row that changes depending on which writer ran last.
"""

import json
import os

import lancedb
import pytest

from relicpy.discover import Found
from relicpy.importer import import_files, rooms_of
from relicpy.repo import shard_dir_for
from relicpy.shapes.claude import parse
from relicpy.types import parse_channel_envelope, via_label

FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "test", "fixtures", "channel-envelopes.json")
with open(FIXTURE, encoding="utf-8") as fh:
    FIX = json.load(fh)


@pytest.mark.parametrize("case", FIX["parse"], ids=[c["name"] for c in FIX["parse"]])
def test_parse_channel_envelope_matches_the_typescript_pairs(case):
    assert parse_channel_envelope(case["text"]) == case["want"]


@pytest.mark.parametrize("via,label", FIX["via_label"])
def test_via_label(via, label):
    assert via_label(via) == label


@pytest.mark.parametrize("case", FIX["rooms"], ids=[c["name"] for c in FIX["rooms"]])
def test_rooms_of(case):
    assert rooms_of(case["channels"]) == case["want"]


CWD = "/opt/Code/github.com/acme/widget"
A, B = "1512079809021214730", "1500682214571118624"


def _env(chat, msg, user, uid, ts, body):
    return (f'<channel source="plugin:discord:discord" chat_id="{chat}" message_id="{msg}" '
            f'user="{user}" user_id="{uid}" ts="{ts}">\n{body}\n</channel>')


TURNS = [
    ("user", "2026-09-23T01:01:00.000Z", _env(A, "m1", "nazt_", "691531480689541170", "2026-09-23T01:00:59.800Z", "please fix the relay")),
    ("assistant", "2026-09-23T01:02:00.000Z", "on it"),
    ("user", "2026-09-23T03:03:00.000Z", _env(B, "m2", "ting_41427", "7", "2026-09-23T01:03:00.000Z", "ดูให้หน่อย relay")),
    ("assistant", "2026-09-23T03:04:00.000Z", "done"),
    ("user", "2026-09-23T03:05:00.000Z", _env(A, "m3", "nazt_", "691531480689541170", "2026-09-23T03:04:59.900Z", "ship it")),
    ("user", "2026-09-23T03:06:00.000Z",
     'why did <channel source="plugin:discord:discord" user="bob">x</channel> show up in the relay log'),
]


def _transcript(tmp_path):
    f = tmp_path / "c0ffee00-0000-4000-8000-000000000001.jsonl"
    f.write_text("\n".join(json.dumps({
        "type": role, "sessionId": "c0ffee00-0000-4000-8000-000000000001", "cwd": CWD, "timestamp": ts,
        "message": {"role": role, "content": text if role == "user" else [{"type": "text", "text": text}]},
    }, ensure_ascii=False) for role, ts, text in TURNS) + "\n", encoding="utf-8")
    return f


def test_the_claude_shape_puts_facets_beside_the_raw_text(tmp_path):
    p = parse(str(_transcript(tmp_path)))
    assert [e.text for e in p.events] == [t[2] for t in TURNS]          # the envelope stays
    assert [e.seq for e in p.events if e.channel] == [1, 3, 5]          # the quoting turn is not one
    assert p.events[0].channel == {
        "via": "plugin:discord:discord", "chat_id": A, "msg_id": "m1", "from_user": "nazt_",
        "from_user_id": "691531480689541170", "sent_ts": "2026-09-23T01:00:59.800Z", "body": "please fix the relay"}
    assert p.description == "please fix the relay"


def test_import_writes_the_same_columns_the_typescript_does(tmp_path):
    f = _transcript(tmp_path)
    st = os.stat(f)
    root = str(tmp_path / "root")
    t = import_files([Found(path=str(f), project_dir="-opt-Code-github-com-acme-widget", tier="session",
                            source="claude", bank="projects", workflow_run_id=None, agent_id=None,
                            mtime=int(st.st_mtime), size=st.st_size, parser=parse)], data_root=root)
    assert (t.failed, t.imported) == (0, 1)
    db = lancedb.connect(shard_dir_for("github.com/acme/widget", root, False, "projects"))
    ev = sorted(db.open_table("events").to_arrow().to_pylist(), key=lambda r: r["seq"])
    assert [r["via"] for r in ev] == ["plugin:discord:discord", "", "plugin:discord:discord", "",
                                      "plugin:discord:discord", ""]
    assert (ev[2]["chat_id"], ev[2]["from_user"], ev[2]["sent_ts"], ev[2]["ts"]) == \
        (B, "ting_41427", "2026-09-23T01:03:00.000Z", "2026-09-23T03:03:00.000Z")
    assert ev[0]["text"] == TURNS[0][2]
    (s,) = db.open_table("sessions").to_arrow().to_pylist()
    assert (s["via"], s["chat_id"], s["from_users"]) == ("plugin:discord:discord", f"{A},{B}", "nazt_,ting_41427")


def test_the_writer_widens_a_table_that_predates_the_columns(tmp_path):
    # Without widening, every shard indexed before the facets rejects the whole batch:
    # "Field 'via' not found in target schema" — measured before _widen existed.
    f = _transcript(tmp_path)
    st = os.stat(f)
    root = str(tmp_path / "root")
    shard = shard_dir_for("github.com/acme/widget", root, False, "projects")
    os.makedirs(shard, exist_ok=True)
    lancedb.connect(shard).create_table("events", data=[dict(
        uid="old", session_uuid="s", file_path="/elsewhere.jsonl", repo_key="github.com/acme/widget", seq=1.0,
        role="user", ts="", text="older row", source="claude", tier="session", kind="transcript", worktree="",
        cwd=CWD, org="acme", project="", dir="", mem_type="", origin_session="")])
    t = import_files([Found(path=str(f), project_dir="p", tier="session", source="claude", bank="projects",
                            workflow_run_id=None, agent_id=None, mtime=int(st.st_mtime), size=st.st_size,
                            parser=parse)], data_root=root)
    assert (t.failed, t.imported) == (0, 1)
    rows = lancedb.connect(shard).open_table("events").to_arrow().to_pylist()
    assert {r["uid"]: r["via"] for r in rows}["old"] == ""                # backfilled with the default
    assert sum(1 for r in rows if r["via"]) == 3
