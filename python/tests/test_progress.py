"""Mirror of test/progress.test.ts: piped progress is lines, not \\r-frames (#75)."""

import io

from relicpy.progress import Progress


class _Tty(io.StringIO):
    def isatty(self):
        return True


def test_piped_frames_become_throttled_lines():
    out = io.StringIO()
    bar = Progress(out, every_s=60)
    for i in range(1001):
        bar.tick(f"  {i / 10}%  {i}/1000 scanned   ", i / 10)
    bar.clear()
    text = out.getvalue()
    assert "\r" not in text
    lines = [l for l in text.split("\n") if l]
    assert len(lines) == 11
    assert all(len(l) <= 200 and l == l.rstrip() for l in lines)


def test_piped_without_percentage_prints_once_per_interval():
    out = io.StringIO()
    bar = Progress(out, every_s=60)
    for i in range(50):
        bar.tick(f"frame {i}")
    assert out.getvalue() == "frame 0\n"


def test_forced_frame_always_prints():
    out = io.StringIO()
    bar = Progress(out, every_s=60)
    bar.tick("1/3", 33)
    bar.tick("2/3", 34)
    bar.tick("3/3", 35, True)
    assert out.getvalue() == "1/3\n3/3\n"


def test_terminal_repaints_and_clears_only_what_it_drew():
    out = _Tty()
    bar = Progress(out)
    bar.clear()
    assert out.getvalue() == ""
    bar.tick("a")
    bar.tick("b")
    bar.clear()
    assert out.getvalue() == "\ra\rb\r" + " " * 96 + "\r"
