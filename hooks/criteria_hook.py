#!/usr/bin/env python3
"""criteria 위임 전 점검 훅 (UserPromptSubmit). 표준 라이브러리만 쓴다.

켜져 있고 위임 요청으로 보일 때만 기준 기록소를 조회해 컨텍스트를 덧붙인다.
꺼져 있거나 판단할 게 없으면 아무것도 출력하지 않는다. 어떤 오류도 입력을 막지 않는다.
설정과 조회 규칙은 skills/criteria/references/format.md, skills/criteria-init/SKILL.md 참고.
"""
import datetime
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

DEFAULTS = {"enabled": False, "intensity": "light", "max_per_session": 3, "cooldown_turns": 3}
REVIEW_DAYS = 90
MAX_LISTED = 8
MAX_TEXT = 160
STATE_KEEP_DAYS = 7

DELEGATION = ["필터", "걸러", "골라", "선별", "추천", "기획", "정리", "분석", "작성", "써줘", "써 줘",
              "만들어", "요약", "비교", "평가", "설계", "초안", "구성", "제안", "검토", "리서치", "조사",
              "filter", "plan", "draft", "write", "create", "summarize", "compare", "evaluate",
              "design", "curate", "select", "rank", "research"]
REQUEST_FORM = ["해줘", "해 줘", "해주세요", "해 주세요", "줘", "부탁", "해봐", "해라", "하자",
                "please", "can you", "could you"]
DIRECTION = ["바꾸", "바꿔", "대신", "말고", "방향", "다시 정", "결정", "하기로", "변경", "전환",
             "pivot", "instead"]
LONG_OUTPUT = ["전체", "전부", "매거진", "보고서", "기획서", "전략", "로드맵", "장문", "원고", "시리즈",
               "캠페인", "report", "roadmap", "strategy", "whole", "full"]
COUNT_RE = re.compile(r"\d+\s*(장|개|페이지|편|p\b)")


# ---------- 파일 형식 (references/format.md) ----------

def parse_file(text):
    meta, body = {}, text
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                if ":" not in line:
                    continue
                key, value = line.split(":", 1)
                value = value.strip()
                if value.startswith('"'):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        pass
                else:
                    value = re.split(r"\s+#", value)[0].strip()
                meta[key.strip()] = value
            body = text[end + 4:].lstrip("\n")
    return meta, body.strip()


def parse_date(value):
    try:
        return datetime.date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def is_stale(meta, today):
    due = parse_date(meta.get("review_after"))
    if due is None:
        confirmed = parse_date(meta.get("confirmed_at"))
        if confirmed is None:
            return True
        due = confirmed + datetime.timedelta(days=REVIEW_DAYS)
    return due < today


def one_line(text, limit=MAX_TEXT):
    text = " ".join(re.sub(r"[\x00-\x1f]", " ", str(text)).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


# ---------- 설정과 기록소 ----------

def find_project_dir(cwd, home):
    start = Path(cwd).resolve()
    for d in [start, *start.parents]:
        candidate = d / ".criteria"
        if candidate.is_dir():
            return candidate
        if d == home:
            break
    return None


def load_config(project_dir, global_dir):
    for folder in (project_dir, global_dir):
        if folder is None:
            continue
        path = folder / "config.json"
        if path.is_file():
            try:
                raw = json.loads(path.read_text(encoding="utf-8")).get("hook", {})
            except (ValueError, OSError, AttributeError):
                return dict(DEFAULTS)  # 깨진 설정은 꺼진 것으로 본다
            cfg = dict(DEFAULTS)
            if isinstance(raw, dict):
                cfg.update({k: raw[k] for k in DEFAULTS if k in raw})
            return cfg
    return dict(DEFAULTS)


def load_criteria(folders, today):
    """(확정, 재확인 필요) 목록. 같은 영역·결정이 양쪽에 있으면 프로젝트가 우선."""
    seen, confirmed, recheck = set(), [], []
    for folder in folders:
        if folder is None or not folder.is_dir():
            continue
        for f in sorted(folder.glob("*.md")):
            if f.name == "INDEX.md":
                continue
            try:
                meta, body = parse_file(f.read_text(encoding="utf-8"))
            except OSError:
                continue
            status = meta.get("status")
            if status not in ("confirmed", "draft"):
                continue
            key = (meta.get("area", ""), meta.get("decision", ""))
            if key in seen:
                continue
            seen.add(key)
            item = {"area": one_line(key[0], 40), "decision": one_line(key[1], 40),
                    "body": one_line(body), "scope": "프로젝트" if folder == folders[0] else "전역"}
            if status == "confirmed" and not is_stale(meta, today):
                confirmed.append(item)
            else:
                item["why"] = "초안" if status == "draft" else "확정 후 오래됨"
                recheck.append(item)
    return confirmed, recheck


# ---------- 세션 상태 ----------

def state_file(session_id, data_dir):
    sid = re.sub(r"[^A-Za-z0-9_-]", "-", session_id or "unknown")[:80]
    return Path(data_dir) / "sessions" / f"{sid}.json"


def load_state(path):
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(state, dict):
            return {"turn": int(state.get("turn", 0)), "delegations": int(state.get("delegations", 0)),
                    "fires": int(state.get("fires", 0)), "last_fire": int(state.get("last_fire", -999))}
    except (ValueError, OSError, TypeError):
        pass
    return {"turn": 0, "delegations": 0, "fires": 0, "last_fire": -999}


def save_state(path, state):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, path)
        cutoff = time.time() - STATE_KEEP_DAYS * 86400
        for old in path.parent.glob("*.json"):
            if old.stat().st_mtime < cutoff:
                old.unlink()
    except OSError:
        pass


# ---------- 판단 ----------

def last_assistant_text(transcript_path):
    """직전 어시스턴트 발화. 읽지 못하면 빈 문자열."""
    try:
        with open(transcript_path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 200_000))
            lines = fh.read().decode("utf-8", "ignore").splitlines()
    except (OSError, TypeError):
        return ""
    for line in reversed(lines):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict) or obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(p.get("text", "") for p in content
                            if isinstance(p, dict) and p.get("type") == "text")
        else:
            continue
        if text.strip():
            return text
    return ""


def is_delegation(prompt):
    p = prompt.lower()
    if not any(k in p for k in DELEGATION):
        return False
    return any(k in p for k in REQUEST_FORM) or len(prompt) >= 30


def signals(prompt, first):
    p = prompt.lower()
    found = []
    if first:
        found.append("세션 첫 위임")
    if any(k in p for k in DIRECTION):
        found.append("방향을 바꾸는 결정")
    if any(k in p for k in LONG_OUTPUT) or COUNT_RE.search(p):
        found.append("긴 산출물")
    return found


def matches(item, prompt):
    p = prompt.lower()
    return any(len(v) >= 2 and v.lower() in p for v in (item["area"], item["decision"]))


def fmt(item):
    return f"[{item['area']}/{item['decision']}] {item['body']} ({item['scope']})"


def build_context(event, home=None, data_dir=None, today=None):
    """주입할 텍스트를 반환한다. 개입하지 않으면 None."""
    home = Path(home or os.path.expanduser("~")).resolve()
    today = today or datetime.date.today()
    data_dir = data_dir or os.environ.get("CLAUDE_PLUGIN_DATA") or \
        str(Path(tempfile.gettempdir()) / "criteria-hook")
    prompt = str(event.get("prompt") or event.get("user_prompt") or "").strip()

    project_dir = find_project_dir(event.get("cwd") or os.getcwd(), home)
    global_dir = home / ".criteria"
    cfg = load_config(project_dir, global_dir if global_dir.is_dir() else None)
    if cfg["enabled"] is not True:
        return None
    # compass 점검 질문에 대한 답은 compass가 다룬다
    if len(prompt) < 10 or prompt.startswith(("/", "[compass 점검 답변]")):
        return None

    spath = state_file(event.get("session_id"), data_dir)
    state = load_state(spath)
    state["turn"] += 1
    try:
        # 기준을 묻는 대화의 답변이면 끼어들지 않는다
        prev = last_assistant_text(event.get("transcript_path"))
        answering = "기준" in prev and prev.rstrip().endswith(("?", "？"))
        if answering or not is_delegation(prompt):
            return None

        first = state["delegations"] == 0
        state["delegations"] += 1
        found = signals(prompt, first)
        if cfg["intensity"] != "active" and not found:
            return None

        folders = [project_dir, global_dir if global_dir != project_dir else None]
        confirmed, recheck = load_criteria(folders, today)
        hit = [c for c in confirmed if matches(c, prompt)]
        rest = [c for c in confirmed if c not in hit]

        strong = False
        if not hit:
            room = state["fires"] < int(cfg["max_per_session"])
            cooled = state["turn"] - state["last_fire"] > int(cfg["cooldown_turns"])
            strong = room and cooled
            if strong:
                state["fires"] += 1
                state["last_fire"] = state["turn"]

        lines = ["[criteria 훅] 이 프로젝트는 위임 전 기준 점검을 켜 두었다. "
                 f"이 요청은 위임으로 감지됐다(신호: {', '.join(found) or '위임 동사'})."]
        if hit:
            lines.append("이 요청과 관련 있어 보이는 확정 기준:")
            lines += [f"  - {fmt(c)}" for c in hit[:MAX_LISTED]]
        if rest and len(hit) < MAX_LISTED:
            lines.append("그 외 확정 기준:")
            lines += [f"  - {fmt(c)}" for c in rest[:MAX_LISTED - len(hit)]]
        if not confirmed:
            lines.append("기록소에 확정 기준이 없다.")
        if recheck:
            lines.append("재확인이 필요한 기준(초안 또는 오래됨, 확정으로 취급하지 않음):")
            lines += [f"  - {fmt(c)} · {c['why']}" for c in recheck[:3]]
        lines.append("확정 기준을 적용하면 답변 첫머리에 '적용한 기준: ...' 한 줄로 밝히는 것이 이 프로젝트의 규칙이다.")
        if strong:
            lines.append("이 요청에 필요한 판단 기준이 위에 없다. 이 프로젝트의 규칙은 criteria-gap 스킬의 절차에 따라 "
                         "작업 전에 막는 기준 하나만 사용자에게 묻는 것이다. 사용자가 '일단 진행'을 고르면 임시 기준으로 "
                         "진행하되 임시 기준임을 밝히고 저장하지 않는다. 단, 이 세션에 [compass] 목표가 정해져 있으면 "
                         "묻는 일은 compass가 맡는다.")
        elif hit:
            lines.append("위 기준이 이 요청의 판단을 모두 다루지 않으면 빠진 기준을 작업 전에 확인하는 것이 규칙이다.")
        return "\n".join(lines)[:4000]
    finally:
        save_state(spath, state)


def main():
    try:
        event = json.loads(sys.stdin.read() or "{}")
        text = build_context(event if isinstance(event, dict) else {})
    except Exception:  # 훅 오류가 사용자 입력을 막으면 안 된다
        return 0
    if text:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                                 "additionalContext": text}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
