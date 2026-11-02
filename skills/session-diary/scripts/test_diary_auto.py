"""diary_auto 테스트. 가짜 기록과 가짜 AI 명령만 쓴다.
실행: cd skills/session-diary/scripts && python3 -m unittest -v test_diary_auto
"""
import datetime
import json
import os
import plistlib
import stat
import tempfile
import time
import unittest
from pathlib import Path

import diary_auto as da

TODAY = datetime.date(2026, 10, 4)
D1, D2, D3 = (datetime.date(2026, 10, n) for n in (1, 2, 3))
GOOD = "---\ndate: x\n---\n\n# 일기\n\n「소스를 필터해줘」(10:00)\n"


def user_row(day, text="소스를 필터해줘", sid="s1", cwd="/home/a/proj"):
    return {"type": "user", "sessionId": sid, "cwd": cwd, "timestamp": "%sT10:00:00+09:00" % day.isoformat(),
            "entrypoint": "cli", "message": {"role": "user", "content": text}}


class Base(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in
                      ("TZ", "SESSION_DIARY_HOME", "SESSION_DIARY_CLAUDE_DIR", "SESSION_DIARY_CODEX_DIR", "SESSION_DIARY_LABEL")}
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "diary"
        self.claude = self.root / "claude"
        os.environ.update(TZ="Asia/Seoul", SESSION_DIARY_HOME=str(self.home), SESSION_DIARY_CLAUDE_DIR=str(self.claude),
                          SESSION_DIARY_CODEX_DIR=str(self.root / "codex"), SESSION_DIARY_LABEL="test.label")
        time.tzset()
        self.home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        time.tzset()

    def session(self, day, **kw):
        path = self.claude / "proj" / ("%s-%s.jsonl" % (day.isoformat(), kw.get("sid", "s")))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(user_row(day, **kw), ensure_ascii=False) + "\n", encoding="utf-8")

    def fake_cli(self, replies):
        """호출마다 replies를 차례로 답하는 가짜 claude. 받은 인자와 입력을 기록한다."""
        (self.root / "replies.json").write_text(json.dumps(replies), encoding="utf-8")
        script = self.root / "fake-cli"
        script.write_text("""#!/usr/bin/env python3
import json, sys, os
root = %r
replies = json.load(open(root + "/replies.json"))
calls_path = root + "/calls.json"
calls = json.load(open(calls_path)) if os.path.exists(calls_path) else []
calls.append({"argv": sys.argv[1:], "stdin": sys.stdin.read(), "env": sorted(k for k in os.environ if k.startswith("CLAUDE"))})
json.dump(calls, open(calls_path, "w"))
reply = replies[min(len(calls) - 1, len(replies) - 1)]
if reply == "ERROR":
    print(json.dumps({"is_error": True, "result": "limit reached"}))
    sys.exit(1)
print(json.dumps({"is_error": False, "result": reply, "usage": {"input_tokens": 1, "output_tokens": 1}, "total_cost_usd": 0.01}))
""" % str(self.root), encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        return str(script)

    def calls(self):
        path = self.root / "calls.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []

    def state(self, since=D1, replies=None):
        da.save_state({"since": since.isoformat(), "runner": self.fake_cli(replies or [GOOD]), "runner_kind": "claude"})

    def diary(self, day):
        return Path(da.diary_path(day)).read_text(encoding="utf-8")


class MissingDatesTest(Base):
    def test_lists_from_since_to_yesterday_oldest_first(self):
        self.assertEqual(da.missing_dates({"since": "2026-10-01"}, TODAY), [D1, D2, D3])

    def test_existing_diary_is_skipped_and_today_is_not_included(self):
        Path(da.diary_path(D2)).write_text("x", encoding="utf-8")
        self.assertEqual(da.missing_dates({"since": "2026-10-01"}, TODAY), [D1, D3])

    def test_not_turned_on_means_nothing(self):
        self.assertEqual(da.missing_dates({}, TODAY), [])


class TickTest(Base):
    def test_day_without_conversation_is_written_without_calling_ai(self):
        self.state(since=D3)
        self.assertEqual(da.tick(TODAY), 0)
        self.assertIn("세션 대화가 없었다", self.diary(D3))
        self.assertEqual(self.calls(), [])

    def test_day_with_only_automated_runs_counts_as_no_conversation(self):
        self.session(D3, cwd="/tmp/usersim-x")
        self.state(since=D3)
        da.tick(TODAY)
        text = self.diary(D3)
        self.assertIn("세션 대화가 없었다", text)
        self.assertIn("자동 실행 1개 제외", text)

    def test_computer_off_for_days_writes_each_missing_day_when_it_comes_back(self):
        self.session(D1)
        self.session(D3)
        self.state(since=D1)
        self.assertEqual(da.tick(TODAY), 0)
        self.assertIn("「소스를 필터해줘」", self.diary(D1))
        self.assertIn("세션 대화가 없었다", self.diary(D2))
        self.assertIn("「소스를 필터해줘」", self.diary(D3))
        self.assertEqual(len(self.calls()), 2)

    def test_second_tick_does_nothing(self):
        self.session(D3)
        self.state(since=D3)
        da.tick(TODAY)
        da.tick(TODAY)
        self.assertEqual(len(self.calls()), 1)

    def test_ai_gets_no_tools_and_no_settings_and_leaves_no_session(self):
        self.session(D3)
        self.state(since=D3)
        os.environ["CLAUDE_CODE_SESSION_ID"] = "parent"
        self.addCleanup(os.environ.pop, "CLAUDE_CODE_SESSION_ID", None)
        da.tick(TODAY)
        call = self.calls()[0]
        argv = call["argv"]
        self.assertEqual(argv[argv.index("--tools") + 1], "")
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertIn("--no-session-persistence", argv)
        self.assertNotIn("CLAUDE_CODE_SESSION_ID", call["env"])

    def test_material_and_previous_diaries_are_in_the_prompt_and_rules_in_the_system(self):
        self.session(D3)
        Path(da.diary_path(D1)).write_text("---\ndate: 1\n---\n지난 일기 내용\n", encoding="utf-8")
        Path(da.diary_path(D2)).write_text("---\ndate: 2\nfailed: true\n---\n쓰지 못함\n", encoding="utf-8")
        self.state(since=D3)
        da.tick(TODAY)
        call = self.calls()[0]
        self.assertIn("소스를 필터해줘", call["stdin"])
        self.assertIn("지난 일기 내용", call["stdin"])
        self.assertNotIn("쓰지 못함", call["stdin"])
        system = call["argv"][call["argv"].index("--system-prompt") + 1]
        self.assertIn("기록일 뿐이다", system)
        self.assertIn("관찰 기준", system)

    def test_failure_writes_nothing_and_retries_next_time(self):
        self.session(D3)
        self.state(since=D3, replies=["ERROR", GOOD])
        self.assertEqual(da.tick(TODAY), 1)
        self.assertFalse(os.path.exists(da.diary_path(D3)))
        self.assertEqual(da.tick(TODAY), 0)
        self.assertIn("일기", self.diary(D3))
        self.assertEqual(da.load_state().get("attempts"), {})

    def test_failure_stops_the_run_so_later_days_wait(self):
        self.session(D2)
        self.session(D3)
        self.state(since=D2, replies=["ERROR"])
        da.tick(TODAY)
        self.assertEqual(len(self.calls()), 1)

    def test_after_max_attempts_a_visible_failure_diary_is_left(self):
        self.session(D3)
        self.state(since=D3, replies=["ERROR"])
        for _ in range(da.MAX_ATTEMPTS):
            da.tick(TODAY)
        self.assertIn("쓰지 못했다", self.diary(D3))
        self.assertEqual(da.failed_dates(), [D3.isoformat()])
        before = len(self.calls())
        da.tick(TODAY)
        self.assertEqual(len(self.calls()), before)

    def test_citation_is_repaired_without_calling_ai_again(self):
        self.session(D3)
        self.state(since=D3, replies=["---\ndate: x\n---\n\n# 일기\n\n「소스를 필터해줘」\n"])
        da.tick(TODAY)
        self.assertIn("「소스를 필터해줘」(10:00)", self.diary(D3))
        self.assertEqual(len(self.calls()), 1)

    def test_quote_from_yesterdays_diary_does_not_trigger_a_fix(self):
        Path(da.diary_path(D2)).write_text("---\ndate: 2\n---\n「어제 한 말」(09:00)\n", encoding="utf-8")
        self.session(D3)
        reply = "---\ndate: x\n---\n\n# 일기\n\n어제는 「어제 한 말」이라고 했다.\n"
        self.state(since=D3, replies=[reply])
        da.tick(TODAY)
        self.assertEqual(len(self.calls()), 1)

    def test_section_notes_follow_the_diaries_not_the_model(self):
        empty = "# 일기\n\n## 내 메모\n(직접 적는 칸. 오늘 잘된 일)\n\n---\n뺀 세션: 0개\n"
        written = "# 일기\n\n## 내 메모\n이 평가는 틀렸다고 생각한다\n\n---\n뺀 세션: 0개\n"
        self.assertIn("첫 일기", da.section_notes([]))
        self.assertIn("쓰지 않는다", da.section_notes([empty]))
        self.assertEqual(da.last_memo([written]), "이 평가는 틀렸다고 생각한다")
        self.assertIn("칸을 쓴다", da.section_notes([written]))

    def test_bad_quote_is_fixed_without_resending_material(self):
        self.session(D3)
        bad = "---\ndate: x\n---\n\n# 일기\n\n「지어낸 말」(10:00)\n"
        self.state(since=D3, replies=[bad, GOOD])
        da.tick(TODAY)
        self.assertIn("「소스를 필터해줘」(10:00)", self.diary(D3))
        self.assertNotIn("지어낸 말", self.diary(D3))
        self.assertIn("지어낸 말", self.calls()[1]["stdin"])
        self.assertNotIn("<재료>", self.calls()[1]["stdin"])

    def test_quote_still_bad_after_fix_is_flagged_in_the_diary(self):
        self.session(D3)
        bad = "---\ndate: x\n---\n\n# 일기\n\n「지어낸 말」(10:00)\n"
        self.state(since=D3, replies=[bad, bad])
        da.tick(TODAY)
        self.assertIn("인용 검사를 통과하지 못한 인용 1개", self.diary(D3))

    def test_reply_that_is_not_a_diary_counts_as_failure(self):
        self.session(D3)
        self.state(since=D3, replies=["죄송합니다"])
        self.assertEqual(da.tick(TODAY), 1)
        self.assertFalse(os.path.exists(da.diary_path(D3)))

    def test_code_fence_around_the_diary_is_removed(self):
        self.assertEqual(da.clean_output("```markdown\n" + GOOD + "```"), GOOD)

    def test_another_run_holding_the_lock_is_left_alone(self):
        self.session(D3)
        self.state(since=D3)
        with da.Lock():
            self.assertEqual(da.tick(TODAY), 0)
        self.assertEqual(self.calls(), [])

    def test_stale_lock_is_cleared(self):
        self.session(D3)
        self.state(since=D3)
        lock = Path(da.auto_dir()) / "lock"
        lock.mkdir()
        os.utime(lock, (time.time() - da.STALE_LOCK_SECONDS - 10,) * 2)
        da.tick(TODAY)
        self.assertEqual(len(self.calls()), 1)


class StatisticsTest(Base):
    def assistant(self, day, msg_id, out, sid="s1", cwd="/home/a/proj"):
        return {"type": "assistant", "sessionId": sid, "cwd": cwd, "requestId": "r" + msg_id,
                "timestamp": "%sT10:01:00+09:00" % day.isoformat(),
                "message": {"id": msg_id, "model": "claude-x", "content": [{"type": "text", "text": "답"}],
                            "usage": {"input_tokens": 1, "cache_creation_input_tokens": 9, "cache_read_input_tokens": 100, "output_tokens": out}}}

    def write_rows(self, relative, rows):
        path = self.claude / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    def test_tokens_are_split_by_who_and_counted_once(self):
        self.write_rows("proj/s1.jsonl", [user_row(D3), self.assistant(D3, "m1", 5), self.assistant(D3, "m1", 5), self.assistant(D3, "m2", 7)])
        self.write_rows("proj/s1/subagents/agent-1.jsonl", [self.assistant(D3, "m3", 11, sid="s1")])
        self.write_rows("proj/auto.jsonl", [user_row(D3, sid="auto", cwd="/tmp/x"), self.assistant(D3, "m4", 13, sid="auto", cwd="/tmp/x")])
        _, info = da.build_material(D3)
        u = info["usage"]
        self.assertEqual((u["mine"]["new"], u["mine"]["cache"], u["mine"]["out"]), (20, 200, 12))
        self.assertEqual(u["sub"]["out"], 11)
        self.assertEqual(u["auto"]["out"], 13)
        self.assertEqual(u["models"]["claude-x"], 20 + 12 + 10 + 11 + 10 + 13)

    def test_other_days_and_resumed_copies_are_not_counted(self):
        self.write_rows("proj/s1.jsonl", [user_row(D3), self.assistant(D2, "old", 50), self.assistant(D3, "m1", 5)])
        self.write_rows("proj/s2.jsonl", [user_row(D3, sid="s2"), self.assistant(D3, "m1", 5, sid="s2")])
        _, info = da.build_material(D3)
        self.assertEqual(info["usage"]["mine"]["out"], 5)

    def test_codex_counts_only_what_grew_that_day(self):
        def token(when, total_in, cached, out):
            return {"type": "event_msg", "timestamp": "%sT10:00:00+09:00" % when.isoformat(),
                    "payload": {"type": "token_count", "info": {"total_token_usage": {"input_tokens": total_in, "cached_input_tokens": cached, "output_tokens": out}}}}

        path = self.root / "codex" / "sessions" / "r.jsonl"
        path.parent.mkdir(parents=True)
        rows = [{"type": "session_meta", "timestamp": "%sT09:00:00+09:00" % D2.isoformat(), "payload": {"id": "c1", "cwd": "/home/a/p", "source": "cli"}},
                token(D2, 100, 40, 10), token(D3, 300, 140, 30),
                {"type": "event_msg", "timestamp": "%sT10:00:00+09:00" % D3.isoformat(), "payload": {"type": "user_message", "message": "코덱스 질문"}}]
        path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
        _, info = da.build_material(D3)
        self.assertEqual((info["usage"]["mine"]["new"], info["usage"]["mine"]["cache"], info["usage"]["mine"]["out"]), (100, 100, 20))

    def test_diary_gets_statistics_before_my_memo_and_numbers_in_the_header(self):
        self.write_rows("proj/s1.jsonl", [user_row(D3), self.assistant(D3, "m1", 5)])
        reply = "---\ndate: x\nseen: []\n---\n\n# 일기\n\n「소스를 필터해줘」(10:00)\n\n## 내 메모\n(직접 적는 칸.)\n"
        self.state(since=D3, replies=[reply])
        da.tick(TODAY)
        text = self.diary(D3)
        self.assertLess(text.index("## 통계"), text.index("## 내 메모"))
        self.assertLess(text.index("tokens_out: 5"), text.index("# 일기"))
        self.assertIn("이 일기를 쓰는 데 든 것", text)
        self.assertIn("약 $0.01", text)
        self.assertEqual(text.count("---\n"), 2)

    def test_day_without_conversation_still_reports_automated_tokens_and_no_ai_cost(self):
        self.write_rows("proj/auto.jsonl", [user_row(D3, sid="auto", cwd="/tmp/x"), self.assistant(D3, "m4", 13, sid="auto", cwd="/tmp/x")])
        self.state(since=D3)
        da.tick(TODAY)
        text = self.diary(D3)
        self.assertIn("세션 대화가 없었다", text)
        self.assertIn("tokens_auto_out: 13", text)
        self.assertNotIn("이 일기를 쓰는 데 든 것", text)

    def test_previous_header_numbers_reach_the_next_diary(self):
        Path(da.diary_path(D2)).write_text("---\ndate: 2\ntokens_out: 777\n---\n일기\n", encoding="utf-8")
        self.session(D3)
        self.state(since=D3)
        da.tick(TODAY)
        self.assertIn("tokens_out: 777", self.calls()[0]["stdin"])


class WriteOneTest(Base):
    def test_future_date_is_refused(self):
        tomorrow = datetime.date.today() + datetime.timedelta(days=1)
        self.assertEqual(da.write_one(tomorrow.isoformat(), False), 2)

    def test_today_is_written_from_midnight_to_now_and_says_so(self):
        self.session(datetime.date.today())
        self.state(since=datetime.date.today(), replies=[GOOD])
        self.assertEqual(da.write_one(None, False), 0)
        self.assertTrue(os.path.exists(da.diary_path(datetime.date.today())))
        self.assertIn("하루 도중에 쓰는 일기다", self.calls()[0]["stdin"])

    def test_after_writing_today_the_midnight_run_does_not_write_it_again(self):
        today = datetime.date.today()
        self.session(today)
        self.state(since=today, replies=[GOOD])
        da.write_one(None, False)
        calls = len(self.calls())
        self.assertEqual(da.tick(today + datetime.timedelta(days=1)), 0)
        self.assertEqual(len(self.calls()), calls)

    def test_forced_rewrite_replaces_the_earlier_diary(self):
        today = datetime.date.today()
        self.session(today)
        self.state(since=today, replies=[GOOD, GOOD.replace("# 일기", "# 나중 일기")])
        da.write_one(None, False)
        self.assertEqual(da.write_one(None, False), 2)
        self.assertEqual(da.write_one(None, True), 0)
        self.assertIn("나중 일기", self.diary(today))

    def test_failed_rewrite_keeps_the_earlier_diary(self):
        today = datetime.date.today()
        self.session(today)
        self.state(since=today, replies=[GOOD, "ERROR"])
        da.write_one(None, False)
        before = self.diary(today)
        self.assertEqual(da.write_one(None, True), 1)
        self.assertEqual(self.diary(today), before)

    def test_the_open_session_is_included(self):
        self.session(D3, sid="now")
        os.environ["CLAUDE_CODE_SESSION_ID"] = "now"
        self.addCleanup(os.environ.pop, "CLAUDE_CODE_SESSION_ID", None)
        self.state(since=D3)
        da.write_one(D3.isoformat(), False)
        self.assertIn("소스를 필터해줘", self.calls()[0]["stdin"])

    def test_existing_needs_force(self):
        Path(da.diary_path(D3)).write_text("있음", encoding="utf-8")
        self.state(since=D3)
        self.assertEqual(da.write_one(D3.isoformat(), False), 2)
        self.assertEqual(self.diary(D3), "있음")
        self.assertEqual(da.write_one(D3.isoformat(), True), 0)
        self.assertIn("세션 대화가 없었다", self.diary(D3))


class SwitchTest(Base):
    def test_plist_runs_on_the_hour_and_at_login_with_runner_on_path(self):
        data = da.plist_data("/py", "/app/diary_auto.py", "/opt/x/bin/claude")
        plistlib.dumps(data)
        self.assertEqual(data["StartCalendarInterval"], [{"Minute": 0}])
        self.assertTrue(data["RunAtLoad"])
        self.assertEqual(data["ProgramArguments"], ["/py", "/app/diary_auto.py", "tick"])
        self.assertTrue(data["EnvironmentVariables"]["PATH"].startswith("/opt/x/bin:"))
        self.assertTrue(data["EnvironmentVariables"]["USER"])

    def test_app_copy_leaves_tests_out_and_can_find_its_references(self):
        script = da.copy_app()
        app = Path(script).parents[1]
        self.assertTrue((app / "references" / "write.md").exists())
        self.assertFalse((app / "scripts" / "test_diary_auto.py").exists())
        self.assertTrue((app / "scripts" / "day_sessions.py").exists())


if __name__ == "__main__":
    unittest.main()
