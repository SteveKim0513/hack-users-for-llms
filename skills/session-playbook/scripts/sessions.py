#!/usr/bin/env python3
"""최근 Claude Code 세션을 목록으로 보여 주고, 고른 세션의 대화를 분석용으로 줄여 뽑는다.

표준 라이브러리만 쓴다. 기록은 읽기만 한다. 출력에는 대화 원문이 들어간다.

  python3 sessions.py list [--limit 15] [--days 14]
  python3 sessions.py show <번호 또는 세션id 앞부분> ... [--budget 12000]

list는 번호를 ~/.session-playbook/.last-list.json에 적어 두고, show는 그 번호를 같은 번호로 읽는다.
"""
import argparse
import datetime
import json
import os
import re
import sys
from collections import Counter

INJECTED_TAGS = (
    "command-name", "command-message", "command-args", "local-command-stdout", "local-command-stderr",
    "local-command-caveat", "task-notification", "system-reminder", "bash-input", "bash-stdout", "bash-stderr",
)
INJECTED_PREFIXES = ("[Request interrupted", "Caveat: The messages below", "This session is being continued")
STRIP_BLOCKS = ("system-reminder", "ide_selection", "ide_opened_file", "ide_diagnostics")
TEMP_ROOTS = ("/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/")
SECRETS = [
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"),
    re.compile(r"\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)", re.S),
]
SECRET_KV = re.compile(r"(?i)\b(password|passwd|api[_-]?key|secret|token)\b(\s*[:=]\s*)\S+")
STATE_DIR = os.path.expanduser("~/.session-playbook")
LAST_LIST = os.path.join(STATE_DIR, ".last-list.json")
USER_KEEP, AI_KEEP, PASTE_KEEP = 1200, 400, 300


def mask(text):
    for rx in SECRETS:
        text = rx.sub("[가림]", text)
    return SECRET_KV.sub(lambda m: m.group(1) + m.group(2) + "[가림]", text)


def clean_user(text):
    """사람이 쓴 부분만 남긴다. 도구가 끼워 넣은 텍스트면 빈 문자열."""
    t = text.strip() if isinstance(text, str) else ""
    m = re.match(r"<([A-Za-z_-]+)", t)
    if not t or (m and m.group(1) in INJECTED_TAGS) or t.startswith(INJECTED_PREFIXES):
        return ""
    for tag in STRIP_BLOCKS:
        t = re.sub(r"<%s\b[^>]*>.*?</%s>" % (tag, tag), "", t, flags=re.S)

    def paste(mt):
        body = mt.group(1).strip()
        more = " ...(+%d자)" % (len(body) - PASTE_KEEP) if len(body) > PASTE_KEEP else ""
        return "[붙여넣은 내용] " + body[:PASTE_KEEP] + more

    return re.sub(r"<pasted_content\b[^>]*>(.*?)(?:</pasted_content\b[^>]*>|\Z)", paste, t, flags=re.S).strip()


def clip(text, limit):
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    return "%s ...(%d자 생략)... %s" % (text[:head], len(text) - limit, text[-(limit - head):])


def head(text, limit):
    """한 줄 미리보기. 앞부분만 남긴다."""
    one = " ".join(text.split())
    return one if len(one) <= limit else one[:limit].rstrip() + "…"


def texts(content):
    if isinstance(content, str):
        return [content]
    return [b.get("text", "") for b in (content or []) if isinstance(b, dict) and b.get("type") == "text"]


def when_of(row):
    try:
        return datetime.datetime.fromisoformat(str(row.get("timestamp")).replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def parse(path):
    """세션 파일 하나. 사람 발화와 AI 답변, 제목, 만진 파일을 모은다."""
    s = {"id": os.path.splitext(os.path.basename(path))[0], "path": path, "cwd": None, "title": None,
         "headless": False, "turns": [], "tools": Counter(), "files": []}
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return s
    with f:
        for line in f:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            kind = o.get("type")
            if kind in ("ai-title", "custom-title"):
                s["title"] = o.get("aiTitle") or o.get("customTitle") or s["title"]
                continue
            if kind not in ("user", "assistant") or o.get("isSidechain"):
                continue
            s["cwd"] = s["cwd"] or o.get("cwd")
            s["headless"] = s["headless"] or str(o.get("entrypoint") or "").startswith("sdk")
            content = (o.get("message") or {}).get("content")
            at = when_of(o)
            if kind == "user":
                origin = o.get("origin")
                if o.get("isMeta") or o.get("isCompactSummary") or (isinstance(origin, dict) and origin.get("kind") not in (None, "human")):
                    continue
                text = "\n".join(p for p in (clean_user(x) for x in texts(content)) if p)
                role = "user"
            else:
                text = "\n".join(p for p in (x.strip() for x in texts(content)) if p)
                role = "assistant"
                for b in content if isinstance(content, list) else []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        s["tools"][b.get("name") or "?"] += 1
                        path_in = (b.get("input") or {}).get("file_path")
                        if b.get("name") in ("Edit", "Write", "NotebookEdit") and path_in and path_in not in s["files"]:
                            s["files"].append(path_in)
            if not text:
                continue
            turns = s["turns"]
            if turns and turns[-1]["role"] == role:
                if not (role == "user" and turns[-1]["text"] == text):
                    turns[-1]["text"] += "\n\n" + text
            else:
                turns.append({"role": role, "text": text, "at": at})
    return s


def is_mine(s, current_id):
    users = [t for t in s["turns"] if t["role"] == "user"]
    cwd = s["cwd"] or ""
    return bool(users) and not s["headless"] and s["id"] != current_id and not (cwd + "/").startswith(TEMP_ROOTS)


def project_name(cwd):
    for marker in ("/.claude/worktrees/", "/.codex/worktrees/", "/.worktrees/"):
        if cwd and marker in cwd:
            cwd = cwd.split(marker)[0]
    return os.path.basename((cwd or "").rstrip("/")) or "?"


def recent_sessions(root, days, limit, current_id):
    cutoff = datetime.datetime.now().timestamp() - days * 86400
    paths = []
    for proj in os.listdir(root) if os.path.isdir(root) else []:
        pdir = os.path.join(root, proj)
        for name in os.listdir(pdir) if os.path.isdir(pdir) else []:
            p = os.path.join(pdir, name)
            if name.endswith(".jsonl") and os.path.isfile(p) and os.path.getmtime(p) >= cutoff:
                paths.append(p)
    paths.sort(key=os.path.getmtime, reverse=True)
    found = []
    for p in paths:
        s = parse(p)
        if is_mine(s, current_id):
            found.append(s)
            if len(found) >= limit:
                break
    return found


def cmd_list(args):
    current = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    found = recent_sessions(os.path.expanduser(args.claude_dir), args.days, args.limit, current)
    if not found:
        print("최근 %d일 안에 사람이 일한 Claude Code 세션을 찾지 못했다." % args.days)
        return 0
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LAST_LIST, "w", encoding="utf-8") as f:
        json.dump([{"n": i, "id": s["id"], "path": s["path"]} for i, s in enumerate(found, 1)], f)
    for i, s in enumerate(found, 1):
        users = [t for t in s["turns"] if t["role"] == "user"]
        first, last = s["turns"][0]["at"], s["turns"][-1]["at"]
        span = first.strftime("%m-%d %H:%M") if first else "?"
        if first and last and first.date() == last.date() and last > first:
            span += "~" + last.strftime("%H:%M")
        title = s["title"] or head(users[0]["text"], 40)
        opening = head(users[0]["text"], 70)
        print("%2d. %s  [%s] 내 발화 %d번" % (i, title, project_name(s["cwd"]), len(users)))
        print("    %s · 첫 요청: %s" % (span, opening))
    print("\n세션 %d개. 분석할 번호를 고르세요 (여러 개 가능)." % len(found))
    return 0


def resolve(refs):
    try:
        with open(LAST_LIST, encoding="utf-8") as f:
            last = json.load(f)
    except (OSError, ValueError):
        last = []
    out = []
    for ref in refs:
        hit = next((x for x in last if str(x["n"]) == ref), None) if ref.isdigit() else None
        if hit is None:
            hit = next((x for x in last if x["id"].startswith(ref)), None)
        if hit is None:
            print("찾지 못함: %s (먼저 list를 실행하세요)" % ref, file=sys.stderr)
            continue
        out.append(hit)
    return out


def render(s, budget):
    """사람 발화는 가능한 한 남기고, 길면 가운데 턴을 줄인다. 처음과 끝에 목표와 결말이 있다."""
    lines = []
    for t in s["turns"]:
        if t["role"] == "user":
            lines.append("[나] " + mask(clip(t["text"], USER_KEEP)))
        else:
            lines.append("[AI] " + mask(clip(t["text"], AI_KEEP)))
    if sum(len(x) for x in lines) > budget:
        keep, size = set(), 0
        # 앞과 뒤에 예산을 반씩 준다. 앞이 다 쓰면 결말이 잘린다.
        for order in (range(len(lines)), range(len(lines) - 1, -1, -1)):
            used = 0
            for i in order:
                if i in keep or used + len(lines[i]) > budget // 2:
                    break
                keep.add(i)
                used += len(lines[i])
        out, prev = [], -1
        for i in sorted(keep):
            if i != prev + 1:
                out.append("...(%d턴 생략)..." % (i - prev - 1))
            out.append(lines[i])
            prev = i
        if prev != len(lines) - 1:
            out.append("...(%d턴 생략)..." % (len(lines) - 1 - prev))
        lines = out
    return lines


def cmd_show(args):
    picked = resolve(args.refs)
    for k, hit in enumerate(picked, 1):
        s = parse(hit["path"])
        users = [t for t in s["turns"] if t["role"] == "user"]
        print("=" * 60)
        print("세션 %s — %s" % (hit["n"], s["title"] or "(제목 없음)"))
        print("프로젝트: %s · 내 발화 %d번 · AI 답변 %d번" % (project_name(s["cwd"]), len(users), len(s["turns"]) - len(users)))
        if s["tools"]:
            print("쓴 도구: " + ", ".join("%s %d" % kv for kv in s["tools"].most_common(6)))
        if s["files"]:
            print("고친 파일: " + ", ".join(os.path.basename(p) for p in s["files"][:10]) + (" 외 %d개" % (len(s["files"]) - 10) if len(s["files"]) > 10 else ""))
        print("-" * 60)
        print("\n\n".join(render(s, args.budget)))
    return 0 if picked else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--claude-dir", default="~/.claude/projects")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("--limit", type=int, default=15)
    p.add_argument("--days", type=int, default=14)
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("show")
    p.add_argument("refs", nargs="+")
    p.add_argument("--budget", type=int, default=12000, help="세션 하나당 글자 수 상한")
    p.set_defaults(fn=cmd_show)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
