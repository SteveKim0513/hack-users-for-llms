"""day_sessions와 check_quotes 테스트. 가짜 기록만 쓴다.
실행: cd skills/session-diary/scripts && python3 -m unittest -v test_day_sessions
"""
import argparse
import datetime
import json
import os
import subprocess
import tempfile
import time
import unittest
from collections import Counter
from pathlib import Path

import check_quotes as cq
import day_sessions as ds

DAY = datetime.date(2026, 10, 1)


def at(hour, minute=0, day=1):
    return "2026-10-%02dT%02d:%02d:00+09:00" % (day, hour, minute)


def c_user(text, when=None, **kw):
    row = {"type": "user", "sessionId": "s1", "cwd": "/home/a/proj", "timestamp": when or at(10),
           "entrypoint": "cli", "message": {"role": "user", "content": text}}
    row.update(kw)
    return row


def c_ai(text, when=None, **kw):
    row = {"type": "assistant", "sessionId": "s1", "cwd": "/home/a/proj", "timestamp": when or at(10, 1),
           "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "비공개"},
                                                         {"type": "text", "text": text}]}}
    row.update(kw)
    return row


def x_meta(sid="x1", cwd="/home/a/proj", source="cli", originator="codex-tui"):
    return {"type": "session_meta", "timestamp": at(9), "payload": {"id": sid, "cwd": cwd, "source": source, "originator": originator}}


def x_user(text, when=None):
    return {"type": "event_msg", "timestamp": when or at(9, 1), "payload": {"type": "user_message", "message": text}}


def x_ai(text, when=None):
    return {"type": "response_item", "timestamp": when or at(9, 2),
            "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}}


class Base(unittest.TestCase):
    def setUp(self):
        self.tz = os.environ.get("TZ")
        os.environ["TZ"] = "Asia/Seoul"
        time.tzset()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.claude = self.root / "claude"
        self.codex = self.root / "codex"
        self.n = 0

    def tearDown(self):
        self.tmp.cleanup()
        if self.tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.tz
        time.tzset()

    def write(self, path, rows):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    def claude_session(self, rows, name=None):
        self.n += 1
        self.write(self.claude / "proj" / ("%s.jsonl" % (name or self.n)), rows)

    def collect(self, exclude=()):
        args = argparse.Namespace(claude_dir=str(self.claude), codex_dir=str(self.codex), exclude_session=list(exclude))
        self.stats = Counter()
        return ds.collect(args, DAY, self.stats)


class DayFilterTest(Base):
    def test_turns_are_cut_by_local_date_not_session_start(self):
        self.claude_session([c_user("어제 한 말", "2026-09-30T23:50:00+09:00"),
                             c_user("오늘 한 말", at(0, 10)),
                             c_user("내일 한 말", "2026-10-02T00:10:00+09:00")])
        turns = self.collect()[0]["turns"]
        self.assertEqual([t["text"] for t in turns], ["오늘 한 말"])

    def test_utc_timestamp_is_read_in_local_time(self):
        self.claude_session([c_user("한국 시간 1일 새벽", "2026-09-30T16:00:00Z")])
        self.assertEqual(len(self.collect()), 1)

    def test_session_without_user_turn_that_day_is_dropped(self):
        self.claude_session([c_ai("AI만 말함")])
        self.assertEqual(self.collect(), [])


class HumanOnlyTest(Base):
    def test_user_rows_with_no_reply_between_count_as_one_turn(self):
        self.claude_session([c_user("첫째"), c_user("둘째", at(10, 1))])
        self.assertEqual(ds.facts(self.collect())["user_turns"], 1)

    def test_machine_rows_are_dropped(self):
        self.claude_session([
            c_user("사람 말"),
            c_user("메타", isMeta=True),
            c_user("요약", isCompactSummary=True),
            c_user("알림", origin={"kind": "task-notification"}),
            c_user("곁가지", isSidechain=True),
            c_user("<command-name>/x</command-name>"),
            c_user([{"type": "tool_result", "content": "결과"}]),
        ])
        turns = self.collect()[0]["turns"]
        self.assertEqual([t["text"] for t in turns], ["사람 말"])

    def test_ai_keeps_text_blocks_only(self):
        self.claude_session([c_user("질문"), c_ai("답")])
        self.assertEqual(self.collect()[0]["turns"][1]["text"], "답")

    def test_ide_block_is_stripped_and_typed_text_kept(self):
        self.assertEqual(ds.clean_user_text("<ide_selection>코드</ide_selection>\n정리해줘"), "정리해줘")

    def test_pasted_content_is_shortened(self):
        out = ds.clean_user_text('<pasted_content id="a">%s</pasted_content id="a">\n요약해줘' % ("가" * 1000))
        self.assertIn("[붙여넣은 내용]", out)
        self.assertIn("요약해줘", out)
        self.assertLess(len(out), 400)


class AutomationTest(Base):
    def test_sdk_entrypoint_is_dropped(self):
        self.claude_session([c_user("자동", entrypoint="sdk-cli")])
        self.assertEqual(self.collect(), [])
        self.assertEqual(self.stats["제외: 프로그램이 띄운 실행"], 1)

    def test_temp_folder_is_dropped_but_similar_name_is_not(self):
        self.claude_session([c_user("임시", cwd="/private/var/folders/ab/T/usersim-x", sessionId="a")])
        self.claude_session([c_user("진짜", cwd="/home/a/tmp-notes", sessionId="b")])
        self.assertEqual([s["id"] for s in self.collect()], ["b"])

    def test_current_session_is_dropped(self):
        self.claude_session([c_user("일기 써줘", sessionId="now")])
        self.assertEqual(self.collect(exclude=["now"]), [])

    def test_templated_short_sessions_are_dropped(self):
        for i in range(3):
            self.claude_session([c_user("You are reviewing code %d" % i, sessionId="t%d" % i)])
        rows = [c_user("You are reviewing code 9", at(10), sessionId="long")]
        for i in range(3):
            rows += [c_ai("답 %d" % i, at(11, i * 2), sessionId="long"), c_user("추가 %d" % i, at(11, i * 2 + 1), sessionId="long")]
        self.claude_session(rows)
        self.assertEqual([s["id"] for s in self.collect()], ["long"])

    def test_two_sessions_with_same_opening_are_kept(self):
        for i in range(2):
            self.claude_session([c_user("오늘 할 일을 정리해 줘 부탁", sessionId="t%d" % i)])
        self.assertEqual(len(self.collect()), 2)


class CodexTest(Base):
    def codex_session(self, rows, name="r"):
        self.write(self.codex / "sessions" / "2026" / "10" / "01" / ("%s.jsonl" % name), rows)

    def test_reads_turns(self):
        self.codex_session([x_meta(), x_user("코덱스 질문"), x_ai("코덱스 답")])
        s = self.collect()[0]
        self.assertEqual(s["tool"], "Codex")
        self.assertEqual([t["text"] for t in s["turns"]], ["코덱스 질문", "코덱스 답"])

    def test_exec_is_dropped(self):
        self.codex_session([x_meta(source="exec", originator="codex_exec"), x_user("자동 지시")])
        self.assertEqual(self.collect(), [])

    def test_subagent_is_dropped(self):
        self.codex_session([x_meta(source={"subagent": "x"}), x_user("하위 작업")])
        self.assertEqual(self.collect(), [])

    def test_imported_copy_is_dropped(self):
        self.codex_session([x_meta(sid="copy"), x_user("가져온 사본")])
        self.codex.mkdir(parents=True, exist_ok=True)
        (self.codex / "external_agent_session_imports.json").write_text(
            json.dumps({"records": [{"imported_thread_id": "copy"}]}), encoding="utf-8")
        self.assertEqual(self.collect(), [])


class RenderTest(Base):
    def test_secrets_are_masked(self):
        for leak in ("sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwx", "AKIAABCDEFGHIJKLMNOP"):
            self.assertNotIn(leak, ds.mask("키는 %s 이야" % leak))
        out = ds.mask("password=hunter2 그리고 평범한 말")
        self.assertNotIn("hunter2", out)
        self.assertIn("평범한 말", out)

    def test_facts_count_short_turns_and_skip_idle_gaps(self):
        self.claude_session([c_user("첫 질문입니다 아주 길게 씁니다", at(9)), c_ai("답", at(9, 5)), c_user("네", at(9, 10)),
                             c_ai("답", at(9, 11)), c_user("두 시간 뒤에 다시 시작한 말입니다", at(11, 10))])
        f = ds.facts(self.collect())
        self.assertEqual((f["user_turns"], f["short_turns"]), (3, 1))
        self.assertEqual((f["first"], f["last"]), ("09:00", "11:10"))
        self.assertEqual(f["active_minutes"], 10)

    def test_clip_keeps_head_and_tail(self):
        out = ds.clip("앞" * 500 + "뒤" * 500, 300)
        self.assertTrue(out.startswith("앞"))
        self.assertTrue(out.endswith("뒤"))
        self.assertIn("생략", out)

    def test_worktree_groups_under_repo_and_only_folder_name_is_printed(self):
        self.claude_session([c_user("일", cwd="/home/a/proj/.claude/worktrees/x")])
        text = ds.render(DAY, self.collect(), {}, Counter())
        self.assertIn("## 세션 proj ", text)
        self.assertNotIn("/home/a", text)

    def test_commits_come_from_git_and_repeats_collapse(self):
        repo = self.root / "proj"
        repo.mkdir()
        env = {**os.environ, "GIT_AUTHOR_DATE": at(10), "GIT_COMMITTER_DATE": at(10)}

        def git(*a):
            subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, env=env)

        git("init")
        git("config", "user.email", "me@example.com")
        git("config", "user.name", "me")
        for subject in ("자동 스냅샷", "자동 스냅샷", "기능 추가"):
            git("commit", "--allow-empty", "-m", subject)
        result = ds.commits([{"cwd": str(repo)}], DAY, Counter())
        total, lines = result["proj"]
        self.assertEqual((total, len(lines)), (3, 2))
        self.assertIn("같은 제목 2개", lines[0])

    def test_repo_one_level_down_is_found(self):
        parent = self.root / "studio"
        repo = parent / "studio-dev"
        repo.mkdir(parents=True)
        (parent / "notes").mkdir()
        env = {**os.environ, "GIT_AUTHOR_DATE": at(10), "GIT_COMMITTER_DATE": at(10)}
        for args in (("init",), ("config", "user.email", "me@example.com"), ("config", "user.name", "me"),
                     ("commit", "--allow-empty", "-m", "기능")):
            subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)
        stats = Counter()
        self.assertEqual(ds.commits([{"cwd": str(parent)}], DAY, stats)["studio-dev"][0], 1)
        self.assertEqual(sum(stats.values()), 0)

    def test_same_commit_in_two_copies_is_listed_once(self):
        parent = self.root / "studio"
        first = parent / "dev"
        first.mkdir(parents=True)
        env = {**os.environ, "GIT_AUTHOR_DATE": at(10), "GIT_COMMITTER_DATE": at(10)}

        def git(repo, *a):
            subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, env=env)

        git(first, "init")
        git(first, "config", "user.email", "me@example.com")
        git(first, "config", "user.name", "me")
        git(first, "commit", "--allow-empty", "-m", "기능")
        subprocess.run(["git", "clone", "-q", str(first), str(parent / "use")], check=True, capture_output=True)
        git(parent / "use", "config", "user.email", "me@example.com")
        self.assertEqual(sum(t for t, _ in ds.commits([{"cwd": str(parent)}], DAY, Counter()).values()), 1)

    def test_is_question(self):
        for text in ("2번은 뭐야", "이게 맞아?", "무슨 말이야"):
            self.assertTrue(ds.is_question(text), text)
        for text in ("왜 그런지 설명은 됐고 그냥 진행해", "좋아 구현해줘", "이 긴 문장은 끝에 물음표가 있어도 마흔 글자를 넘으니 질문으로 치지 않는 편이 맞습니다?"):
            self.assertFalse(ds.is_question(text), text)

    def test_ai_reply_before_a_short_question_is_kept_longer(self):
        long = "설명 " * 400
        self.claude_session([c_user("처음 요청입니다", at(9)), c_ai(long, at(9, 1)), c_user("2번은 뭐야", at(9, 2)),
                             c_ai(long, at(9, 3)), c_user("좋아 그대로 진행해 주세요", at(9, 4)), c_ai("끝", at(9, 5))])
        text = ds.render(DAY, self.collect(), {}, Counter())
        first, second = text.split("[09:01 AI]")[1], text.split("[09:03 AI]")[1]
        self.assertGreater(len(first.split("[09:02")[0]), ds.AI_KEEP + 200)
        self.assertLess(len(second.split("[09:04")[0]), ds.AI_KEEP + 60)

    def test_folder_that_is_not_git_is_counted_not_fatal(self):
        stats = Counter()
        self.assertEqual(ds.commits([{"cwd": str(self.root)}], DAY, stats), {})
        self.assertEqual(stats["커밋을 읽지 못한 폴더 " + self.root.name], 1)

    def test_empty_day_writes_a_file_and_exits_zero(self):
        out = self.root / "out.md"
        code = ds.main(["--date", "2026-10-01", "--claude-dir", str(self.claude), "--codex-dir", str(self.codex),
                        "--exclude-session", "", "--out", str(out)])
        self.assertEqual(code, 0)
        self.assertIn("세션 0개", out.read_text(encoding="utf-8"))


class QuoteTest(unittest.TestCase):
    MATERIAL = """## 사실
- 세션 1개

## 세션 proj · Claude Code · 10:00~10:05 · 내 발화 1개
[10:00 나] 검증을 더 하자 라고
했다
[10:01 AI] 알겠습니다 고치겠습니다
"""

    def check(self, diary):
        return cq.problems(diary, self.MATERIAL)

    def test_quote_with_right_time_and_speaker(self):
        self.assertEqual(self.check("「검증을 더 하자」(10:00), 「라고 했다」(10:00), 「고치겠습니다」(10:01 AI)"), (3, []))

    def test_made_up_quote_is_reported(self):
        self.assertEqual(self.check("「한 적 없는 말」(10:00)")[1], [("재료에 없음", "한 적 없는 말")])

    def test_ai_words_given_as_mine_are_reported(self):
        self.assertEqual(self.check("「고치겠습니다」(10:01)")[1][0][0], "시각이나 말한 사람이 다름")

    def test_wrong_time_is_reported(self):
        self.assertEqual(self.check("「검증을 더 하자」(11:00)")[1][0][0], "시각이나 말한 사람이 다름")

    def test_quote_without_time_is_reported(self):
        self.assertEqual(self.check("「검증을 더 하자」")[1][0][0], "시각 표시 없음")

    def test_facts_section_is_not_quotable(self):
        self.assertEqual(self.check("「세션 1개」(10:01 AI)")[1][0][0], "재료에 없음")

    def test_repair_fills_a_missing_or_wrong_citation_when_the_place_is_unique(self):
        fixed = cq.repair("「검증을 더 하자」, 「고치겠습니다」(10:00)", self.MATERIAL)
        self.assertEqual(fixed, "「검증을 더 하자」(10:00), 「고치겠습니다」(10:01 AI)")
        self.assertEqual(cq.problems(fixed, self.MATERIAL)[1], [])

    def test_repair_leaves_made_up_and_ambiguous_quotes(self):
        material = "[10:00 나] 좋아\n[10:01 AI] 답\n[10:02 나] 좋아\n"
        self.assertEqual(cq.repair("「없는 말」, 「좋아」", material), "「없는 말」, 「좋아」")

    def test_quote_from_an_earlier_diary_is_not_wrong(self):
        self.assertEqual(cq.problems("「어제 한 말」", "[10:00 나] 오늘\n", "지난 일기: 「어제 한 말」(09:00)")[1], [])

    def test_heading_inside_a_turn_does_not_cut_it(self):
        material = "## 세션 p · C · 10:00~10:05 · 내 발화 1개\n[10:00 AI] 앞\n## 소제목\n뒤에 있는 문장\n"
        self.assertEqual(cq.problems("「뒤에 있는 문장」(10:00 AI)", material), (1, []))

    def test_no_quotes(self):
        self.assertEqual(self.check("인용 없음"), (0, []))


if __name__ == "__main__":
    unittest.main()
