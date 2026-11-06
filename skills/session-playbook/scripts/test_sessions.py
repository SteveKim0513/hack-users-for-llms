"""sessions.py 테스트. 가짜 기록만 쓴다.
실행: cd skills/session-playbook/scripts && python3 -m unittest -v test_sessions
"""
import argparse
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

import sessions as sp


def row(kind, content, **kw):
    r = {"type": kind, "cwd": "/home/a/proj", "timestamp": "2026-11-01T10:00:00+09:00",
         "entrypoint": "cli", "message": {"content": content}}
    r.update(kw)
    return r


def write(root, project, sid, rows):
    d = Path(root) / project
    d.mkdir(parents=True, exist_ok=True)
    p = d / (sid + ".jsonl")
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    return p


class ParseTest(unittest.TestCase):
    def test_human_turns_title_and_tools(self):
        with tempfile.TemporaryDirectory() as t:
            p = write(t, "p", "abc", [
                {"type": "ai-title", "aiTitle": "제목"},
                row("user", "<system-reminder>x</system-reminder>"),
                row("user", "첫 요청 token=abc123secret"),
                row("assistant", [{"type": "text", "text": "답"},
                                  {"type": "tool_use", "name": "Edit", "input": {"file_path": "/a/b.md"}}]),
                row("user", [{"type": "tool_result", "content": "x"}]),
                row("user", "자동", isMeta=True),
                row("user", "알림", origin={"kind": "task-notification"}),
                row("user", "사이드", isSidechain=True),
            ])
            s = sp.parse(str(p))
            self.assertEqual(s["title"], "제목")
            self.assertEqual([x["role"] for x in s["turns"]], ["user", "assistant"])
            self.assertEqual(s["tools"]["Edit"], 1)
            self.assertEqual(s["files"], ["/a/b.md"])
            self.assertNotIn("abc123secret", "\n".join(sp.render(s, 10000)))

    def test_is_mine_drops_headless_temp_and_current(self):
        base = {"turns": [{"role": "user", "text": "x", "at": None}], "headless": False, "cwd": "/home/a", "id": "i"}
        self.assertTrue(sp.is_mine(base, ""))
        self.assertFalse(sp.is_mine(dict(base, headless=True), ""))
        self.assertFalse(sp.is_mine(dict(base, cwd="/tmp/x"), ""))
        self.assertFalse(sp.is_mine(base, "i"))
        self.assertFalse(sp.is_mine(dict(base, turns=[]), ""))

    def test_render_trims_middle_and_keeps_ends(self):
        s = {"turns": [{"role": "user", "text": "턴%d " % i + "가" * 100, "at": None} for i in range(40)]}
        out = "\n".join(sp.render(s, 1500))
        self.assertIn("턴0 ", out)
        self.assertIn("턴39 ", out)
        self.assertIn("턴 생략", out)

    def test_list_then_show_by_number(self):
        with tempfile.TemporaryDirectory() as t, tempfile.TemporaryDirectory() as state:
            sp.STATE_DIR, sp.LAST_LIST = state, os.path.join(state, "last.json")
            write(t, "p", "aaa111", [row("user", "일 시작"), row("assistant", [{"type": "text", "text": "네"}])])
            args = argparse.Namespace(claude_dir=t, days=3650, limit=5)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                sp.cmd_list(args)
                sp.cmd_show(argparse.Namespace(refs=["1"], budget=5000))
            self.assertIn("1. ", out.getvalue())
            self.assertIn("[나] 일 시작", out.getvalue())


if __name__ == "__main__":
    unittest.main()
