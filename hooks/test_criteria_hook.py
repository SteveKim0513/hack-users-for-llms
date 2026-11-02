"""criteria_hook 테스트. 실행: cd hooks && python3 -m unittest -v test_criteria_hook"""
import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import criteria_hook as ch

TODAY = datetime.date(2026, 10, 20)
HERE = Path(__file__).resolve().parent


def criterion(area, decision, body, status="confirmed", confirmed_at="2026-10-01", review_after=""):
    return (f"---\nid: x-1\narea: {area}\ndecision: {decision}\nstatus: {status}\nsource: user\n"
            f"confirmed_at: {confirmed_at}\nreview_after: {review_after}\nsupersedes:\nevidence:\n---\n\n{body}\n")


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.proj = Path(self.tmp.name) / "proj"
        self.data = Path(self.tmp.name) / "data"
        (self.home / ".criteria").mkdir(parents=True)
        (self.proj / ".criteria").mkdir(parents=True)
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()

    def config(self, folder=None, **hook):
        folder = folder or self.proj / ".criteria"
        (folder / "config.json").write_text(json.dumps({"hook": hook}), encoding="utf-8")

    def add(self, name, text, folder=None):
        (folder or self.proj / ".criteria").joinpath(name).write_text(text, encoding="utf-8")

    def run_hook(self, prompt, session="s1", transcript=None):
        event = {"prompt": prompt, "cwd": str(self.proj), "session_id": session}
        if transcript:
            event["transcript_path"] = str(transcript)
        return ch.build_context(event, home=self.home, data_dir=self.data, today=TODAY)

    # --- 스위치 ---
    def test_off_by_default(self):
        self.assertIsNone(self.run_hook("매거진 소스 필터해줘 부탁해요"))

    def test_off_when_explicitly_disabled(self):
        self.config(enabled=False)
        self.assertIsNone(self.run_hook("매거진 소스 필터해줘 부탁해요"))

    def test_broken_config_means_off(self):
        (self.proj / ".criteria" / "config.json").write_text("{not json", encoding="utf-8")
        self.assertIsNone(self.run_hook("매거진 소스 필터해줘 부탁해요"))

    def test_global_config_applies_when_project_has_none(self):
        self.config(folder=self.home / ".criteria", enabled=True, intensity="active")
        self.assertIsNotNone(self.run_hook("소스를 필터해줘 부탁합니다"))

    def test_project_config_overrides_global(self):
        self.config(folder=self.home / ".criteria", enabled=True, intensity="active")
        self.config(enabled=False)
        self.assertIsNone(self.run_hook("소스를 필터해줘 부탁합니다"))

    # --- 1단계 규칙 필터 ---
    def test_ignores_non_delegation(self):
        self.config(enabled=True, intensity="active")
        self.assertIsNone(self.run_hook("이 기획이 왜 이렇게 나왔는지 설명이 궁금합니다"))
        self.assertIsNone(self.run_hook("고마워 잘 봤어요 정말로"))

    def test_ignores_slash_and_short(self):
        self.config(enabled=True, intensity="active")
        self.assertIsNone(self.run_hook("/criteria 기획해줘 부탁해요 제발"))
        self.assertIsNone(self.run_hook("기획해줘"))

    def test_light_needs_a_signal_active_does_not(self):
        self.config(enabled=True, intensity="light")
        self.run_hook("소스를 필터해줘 부탁합니다", session="a")          # 첫 위임 → 신호 있음
        self.assertIsNone(self.run_hook("소스를 정리해줘 부탁합니다", session="a"))  # 신호 없음
        self.assertIsNotNone(self.run_hook("매거진 전체 기획해줘 부탁합니다", session="a"))  # 긴 산출물

    def test_direction_change_is_a_signal(self):
        self.config(enabled=True, intensity="light")
        self.run_hook("소스를 필터해줘 부탁합니다", session="b")
        out = self.run_hook("이번엔 방향을 바꿔서 기획해줘 부탁합니다", session="b")
        self.assertIn("방향을 바꾸는 결정", out)

    def test_does_not_interrupt_a_criteria_dialogue(self):
        self.config(enabled=True, intensity="active")
        t = Path(self.tmp.name) / "t.jsonl"
        t.write_text(json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "소스 선별 기준은 무엇인가요?"}]}}) + "\n", encoding="utf-8")
        self.assertIsNone(self.run_hook("1차 자료만 쓰고 광고글은 빼서 기획해줘 부탁", transcript=t))
        t.write_text(json.dumps({"type": "assistant", "message": {"content": "다음 작업은요?"}}) + "\n",
                     encoding="utf-8")
        self.assertIsNotNone(self.run_hook("1차 자료만 쓰고 광고글은 빼서 기획해줘 부탁", transcript=t))

    def test_criteria_check_answer_is_left_alone(self):
        self.config(enabled=True, intensity="active")
        self.assertIsNone(self.run_hook("[criteria 점검 답변]\n질문: 소스를 필터할 기준은?\n내 답: 1차 자료만"))

    def test_asking_defers_to_hack_mode(self):
        self.config(enabled=True, intensity="active")
        self.assertIn("그 mod가 맡는다", self.run_hook("매거진 소스를 필터해줘 부탁합니다"))

    def test_unreadable_transcript_does_not_block(self):
        self.config(enabled=True, intensity="active")
        out = self.run_hook("소스를 필터해줘 부탁합니다", transcript=Path(self.tmp.name) / "none")
        self.assertIsNotNone(out)

    # --- 2단계 기록소 ---
    def test_no_criteria_nudges_to_ask(self):
        self.config(enabled=True, intensity="active")
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        self.assertIn("확정 기준이 없다", out)
        self.assertIn("criteria-gap", out)
        self.assertIn("일단 진행", out)

    def test_matching_confirmed_criterion_is_injected_without_strong_nudge(self):
        self.config(enabled=True, intensity="active")
        self.add("a.md", criterion("매거진", "소스 선별", "2025년 이후 1차 자료만"))
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        self.assertIn("2025년 이후 1차 자료만", out)
        self.assertIn("적용한 기준", out)
        self.assertNotIn("확정 기준이 없다", out)
        self.assertNotIn("criteria-gap 스킬의 절차", out)

    def test_unrelated_criterion_is_listed_but_still_nudges(self):
        self.config(enabled=True, intensity="active")
        self.add("a.md", criterion("보고서", "톤", "짧고 건조하게"))
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        self.assertIn("그 외 확정 기준", out)
        self.assertIn("criteria-gap 스킬의 절차", out)

    def test_draft_and_stale_are_not_treated_as_confirmed(self):
        self.config(enabled=True, intensity="active")
        self.add("d.md", criterion("매거진", "독자", "30대 부모", status="draft"))
        self.add("s.md", criterion("매거진", "톤", "다정하게", review_after="2026-01-01"))
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        self.assertIn("재확인이 필요한 기준", out)
        self.assertIn("초안", out)
        self.assertIn("오래됨", out)
        self.assertIn("확정 기준이 없다", out)

    def test_superseded_and_retired_are_ignored(self):
        self.config(enabled=True, intensity="active")
        self.add("x.md", criterion("매거진", "소스 선별", "옛 기준", status="superseded"))
        self.add("y.md", criterion("매거진", "톤", "폐기 기준", status="retired"))
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        self.assertNotIn("옛 기준", out)
        self.assertNotIn("폐기 기준", out)

    def test_project_wins_over_global_for_same_key(self):
        self.config(enabled=True, intensity="active")
        self.add("g.md", criterion("매거진", "소스 선별", "전역 기준"), folder=self.home / ".criteria")
        self.add("p.md", criterion("매거진", "소스 선별", "프로젝트 기준"))
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        self.assertIn("프로젝트 기준", out)
        self.assertNotIn("전역 기준", out)

    def test_criterion_text_is_one_line_and_truncated(self):
        self.config(enabled=True, intensity="active")
        self.add("a.md", criterion("매거진", "소스 선별", "첫 줄\n두번째 줄 " + "가" * 500))
        out = self.run_hook("매거진 소스를 필터해줘 부탁합니다")
        line = [l for l in out.splitlines() if "소스 선별" in l][0]
        self.assertNotIn("두번째 줄\n", out)
        self.assertLess(len(line), 260)

    # --- 안전장치 ---
    def test_max_per_session_and_cooldown(self):
        self.config(enabled=True, intensity="active", max_per_session=2, cooldown_turns=1)
        strong = lambda o: o and "criteria-gap 스킬의 절차" in o
        self.assertTrue(strong(self.run_hook("매거진 소스를 필터해줘 부탁합니다", session="c")))   # turn1 fire
        self.assertFalse(strong(self.run_hook("매거진 소스를 정리해줘 부탁합니다", session="c")))  # turn2 쿨다운
        self.assertTrue(strong(self.run_hook("매거진 소스를 비교해줘 부탁합니다", session="c")))   # turn3 fire
        self.assertFalse(strong(self.run_hook("매거진 소스를 분석해줘 부탁합니다", session="c")))  # turn4 쿨다운
        self.assertFalse(strong(self.run_hook("매거진 소스를 평가해줘 부탁합니다", session="c")))  # turn5 한도 초과
        self.assertFalse(strong(self.run_hook("매거진 소스를 요약해줘 부탁합니다", session="c")))

    def test_sessions_are_independent(self):
        self.config(enabled=True, intensity="active", max_per_session=1, cooldown_turns=0)
        self.assertIn("criteria-gap 스킬의 절차", self.run_hook("소스를 필터해줘 부탁합니다", session="s1"))
        self.assertIn("criteria-gap 스킬의 절차", self.run_hook("소스를 필터해줘 부탁합니다", session="s2"))

    def test_weird_session_id_is_safe(self):
        self.config(enabled=True, intensity="active")
        self.run_hook("소스를 필터해줘 부탁합니다", session="../../etc/x")
        self.assertTrue(any((self.data / "sessions").glob("*.json")))
        self.assertFalse((Path(self.tmp.name) / "etc").exists())


class ProcessTest(unittest.TestCase):
    """실제 sh 래퍼를 거치는 종단 점검."""

    def run_sh(self, stdin, env_extra=None):
        env = {**os.environ, **(env_extra or {})}
        return subprocess.run(["sh", str(HERE / "criteria-hook.sh")], input=stdin, text=True,
                              capture_output=True, env=env, timeout=20)

    def test_garbage_stdin_exits_zero_silently(self):
        for stdin in ("", "not json", "[]", "null", '{"prompt": 5}'):
            r = self.run_sh(stdin)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, ""), stdin)

    def test_end_to_end_output_is_valid_hook_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            proj = Path(tmp) / "proj"
            (proj / ".criteria").mkdir(parents=True)
            (proj / ".criteria" / "config.json").write_text(
                json.dumps({"hook": {"enabled": True, "intensity": "active"}}), encoding="utf-8")
            event = {"prompt": "매거진 소스를 필터해줘 부탁합니다", "cwd": str(proj), "session_id": "e2e"}
            r = self.run_sh(json.dumps(event), {"CLAUDE_PLUGIN_DATA": str(Path(tmp) / "data")})
            self.assertEqual(r.returncode, 0)
            out = json.loads(r.stdout)["hookSpecificOutput"]
            self.assertEqual(out["hookEventName"], "UserPromptSubmit")
            self.assertIn("criteria-gap", out["additionalContext"])

    def test_hooks_json_is_wellformed(self):
        data = json.loads((HERE / "hooks.json").read_text(encoding="utf-8"))
        hook = data["hooks"]["UserPromptSubmit"][0]["hooks"][0]
        self.assertEqual(hook["type"], "command")
        self.assertTrue(hook["args"][0].endswith("hooks/criteria-hook.sh"))
        self.assertLessEqual(hook["timeout"], 30)


if __name__ == "__main__":
    unittest.main()
