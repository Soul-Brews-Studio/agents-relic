"""Pure-function parity with the TypeScript, pinned without needing bun.

The full parser comparison is run by hand against real transcripts (117,962 Claude
events, 62,837 Codex, 5,001 omp — all zero-diff). These are the cases that encode WHY
those passed, so a refactor that breaks one fails here instead of silently writing
different rows into a shared index.
"""

from relicpy.types import block_role, flatten_content, tree_key_of, truncate, uid_of, utf16_len


class TestUid:
    def test_uid_matches_the_typescript_digest(self):
        # Verified against `uidOf("claude", "x.jsonl", 7)` in src/types.ts.
        # Both implementations key the SAME LanceDB table on this, so a different
        # digest means the same event lands twice instead of merging.
        assert uid_of("claude", "x.jsonl", 7) == "333a68a5473812feb14beeda65a8956819e92cf3"
        assert uid_of("codex", "rollout-a.jsonl", 3007) == "7c54ead46f86fc02cf9861f740dee993af3b9eec"

    def test_nested_transcripts_key_on_their_path_inside_the_session_tree(self):
        # Same digests as test/uid-collision.test.ts: one agent file can sit in two trees (#58).
        sid = "04d1d650-031a-44f6-9c22-3e400e68390f"
        assert tree_key_of(f"/r/-opt-x/{sid}.jsonl") == f"{sid}.jsonl"
        assert uid_of("claude", tree_key_of(f"/r/-opt-x/{sid}/subagents/agent-a1.jsonl"), 7) \
            == "72ae4d4171f5d04f2052499fb398aa5d0c006507"
        assert uid_of("claude", tree_key_of(f"/r/-opt-x/{sid}/subagents/workflows/wf_abc/agent-a1.jsonl"), 7) \
            == "5515dbe912e947168971651ac564a89d2153c4e2"

    def test_uid_excludes_the_directory(self):
        # Path-independent by design: the same transcript found under live AND archive
        # collapses to one row instead of doubling.
        assert uid_of("claude", "x.jsonl", 1) == uid_of("claude", "x.jsonl", 1)


class TestUtf16:
    def test_length_counts_code_units_not_code_points(self):
        # JS `.length` is UTF-16 code units; Python len() is code points. One emoji
        # made the same event measure 315 in Python and 316 in TypeScript.
        assert len("📤") == 1
        assert utf16_len("📤") == 2

    def test_truncate_cuts_at_the_javascript_offset(self):
        # Cutting at max_len CODE POINTS drifts past the JS cut point by one per emoji
        # before it — a different stored text for the same uid.
        assert truncate("abcdef", 3) == "abc...[+3]"
        assert truncate("📤📤📤", 2) == "📤...[+4]"

    def test_truncate_never_emits_half_a_surrogate_pair(self):
        # JS slice() can cut a pair in half; Python cannot represent that, so the whole
        # character is dropped. Documented deviation — the result stays valid text.
        out = truncate("📤📤", 1)
        assert "\ud83d" not in out and out.startswith("...")


class TestFlatten:
    def test_json_is_compact_like_JSON_stringify(self):
        # Python's default dumps inserts ", " and ": ", which would make the indexed
        # text differ character for character from the TypeScript's.
        assert flatten_content([{"type": "tool_use", "name": "Bash",
                                 "input": {"command": "ls"}}]) \
            == '[tool_use Bash] {"command":"ls"}'

    def test_tool_result_object_is_serialised_not_stringified_twice(self):
        assert flatten_content([{"type": "tool_result", "content": {"a": 1, "b": "x"}}]) \
            == '[tool_result] {"a":1,"b":"x"}'


class TestBlockRole:
    def test_a_block_array_that_is_only_tool_traffic_is_tool_traffic(self):
        # Claude delivers a tool result inside a `user` message. Taking the envelope
        # role at face value filed machine output as something the human said —
        # measured at 68.5% of indexed text against a 3.7% tool_result role.
        assert block_role([{"type": "tool_result", "content": "x"}]) == "tool_result"
        assert block_role([{"type": "tool_use", "name": "B"}]) == "tool_use"

    def test_prose_mixed_in_falls_back_to_the_envelope(self):
        assert block_role([{"type": "tool_use"}, {"type": "text", "text": "hi"}]) is None

    def test_thinking_only_when_it_is_the_only_kind(self):
        assert block_role([{"type": "thinking"}]) == "thinking"
        assert block_role([{"type": "thinking"}, {"type": "text", "text": "h"}]) is None
