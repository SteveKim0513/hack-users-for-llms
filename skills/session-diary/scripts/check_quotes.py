#!/usr/bin/env python3
"""일기의 인용이 재료에 그대로 있는지, 시각과 말한 사람이 맞는지 확인한다. 틀린 인용이 있으면 종료 코드 1.

인용 형식: 「내 말」(13:25), 「AI 말」(13:25 AI). 시각은 재료의 [13:25 나], [13:25 AI] 줄의 시각이다.
인용 밖의 문장은 검사하지 못한다.

예: python3 check_quotes.py ~/.session-diary/2026-11-02.md ~/.session-diary/.work/2026-11-02.md
"""
import re
import sys

TURN_RE = re.compile(r"^\[(\d\d:\d\d) (나|AI)\] ", re.M)
# 재료 자체의 제목만 턴을 끊는다. AI 답이나 붙여넣은 글 안의 "## "는 본문이다.
SECTION_RE = re.compile(r"^## (?:세션 |사실 |그날의 커밋)", re.M)
QUOTE_RE = re.compile(r"「(.+?)」(?:\s*\((\d\d:\d\d)( AI)?\))?", re.S)


def normalize(text):
    return re.sub(r"\s+", " ", text).strip()


def turns_of(material):
    """(시각, 말한 사람) → 그 시각에 시작한 턴들의 글."""
    turns = {}
    marks = list(TURN_RE.finditer(material))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(material)
        body = material[m.end():end]
        section = SECTION_RE.search(body)
        if section:
            body = body[:section.start()]
        turns.setdefault((m.group(1), m.group(2)), []).append(normalize(body))
    return turns


def problems(diary, material):
    """(인용 수, [(문제, 인용)])."""
    turns = turns_of(material)
    quotes = QUOTE_RE.findall(diary)
    found = []
    for text, when, ai in quotes:
        text = normalize(text)
        if not when:
            found.append(("시각 표시 없음", text))
        elif not any(text in body for body in turns.get((when, "AI" if ai else "나"), [])):
            anywhere = any(text in body for bodies in turns.values() for body in bodies)
            found.append(("시각이나 말한 사람이 다름" if anywhere else "재료에 없음", text))
    return len(quotes), found


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    with open(argv[0], encoding="utf-8") as f:
        diary = f.read()
    with open(argv[1], encoding="utf-8") as f:
        material = f.read()
    total, found = problems(diary, material)
    body = re.sub(r"\A---\n.*?\n---\n", "", diary, flags=re.S)
    print("인용 %d개, 틀린 인용 %d개, 본문 %d자" % (total, len(found), len(body)))
    for why, text in found:
        print("  %s: %s" % (why, text))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
