"""Mirror of test/envelope.test.ts: host envelopes leave the name, never the stored text (#68)."""

import json

from relicpy.shapes.claude import parse
from relicpy.types import strip_envelope

ATTRS = ('source="plugin:discord:discord" chat_id="1512079809021214730" message_id="1540006806481535127" '
         'user="nazt_" user_id="691531480689541170" ts="2026-08-20T14:37:14.608Z"')


def _ws(s: str) -> str:
    return " ".join(s.split())


def test_keeps_what_a_channel_envelope_wraps():
    assert strip_envelope(f"<channel {ATTRS}>can you check why the relay drops messages</channel>") \
        == "can you check why the relay drops messages"


def test_keeps_what_a_teammate_envelope_wraps():
    assert strip_envelope('<teammate-message teammate_id="r" summary="x">the uid collides</teammate-message>') \
        == "the uid collides"


def test_an_opening_tag_cut_off_before_its_gt_is_removed_to_the_end():
    assert strip_envelope(f"<channel {ATTRS} " + 'x="y" ' * 30) == ""


def test_stacked_envelopes_are_all_removed():
    assert strip_envelope(f'<channel {ATTRS}><hook_prompt id="1">go</hook_prompt></channel>') == "go"


def test_text_after_the_envelope_survives():
    assert strip_envelope(f"<channel {ATTRS}>first</channel> and more") == "first  and more"


def test_a_channel_tag_later_in_the_turn_goes_too():
    assert _ws(strip_envelope(f"<channel {ATTRS}>first</channel>\n<channel {ATTRS}>second</channel>")) == "first second"
    assert _ws(strip_envelope("done </channel> ok")) == "done ok"


def test_prose_is_returned_byte_for_byte():
    for t in ["why is a < b in this sort", "  leading space kept", "<3 you", "use a <div> here", "x > y",
              "maw discord access <bot> add <channel-id>", "ลองแล้ว — relic lineage ยังไม่มีในเครื่องผม"]:
        assert strip_envelope(t) == t


def test_tags_later_code_reads_are_left_alone():
    for t in ["<command-name>/dig</command-name>", "<local-command-caveat>Caveat: x</local-command-caveat>",
              "<INSTRUCTIONS>be careful", "<environment_context> cwd"]:
        assert strip_envelope(t) == t


def test_description_is_stripped_and_the_event_text_keeps_the_envelope(tmp_path):
    # Only names and display strip it. The channel facets (#85, #86) parse it from the event.
    long = f'<channel {ATTRS} attachment_count="1" attachments="{"a" * 60}">please fix the relay</channel>'
    recs = [
        {"type": "user", "sessionId": "s", "cwd": "/work/repo", "timestamp": "2026-09-23T01:01:00.000Z",
         "message": {"role": "user", "content": long}},
        {"type": "assistant", "sessionId": "s", "cwd": "/work/repo", "timestamp": "2026-09-23T01:02:00.000Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "on it"}]}},
    ]
    f = tmp_path / "s.jsonl"
    f.write_text("\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8")
    p = parse(str(f))
    assert p.description == "please fix the relay"
    assert next(e.text for e in p.events if e.role == "user") == long
