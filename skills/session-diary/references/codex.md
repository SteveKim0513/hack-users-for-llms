# Codex 세션 기록

확인한 환경은 한 대(Codex Desktop, 2026-10). 버전이 다르면 형식이 다를 수 있다.

## 위치
- `~/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<id>.jsonl` — 세션 하나
- `~/.codex/archived_sessions/rollout-*.jsonl` — 보관된 세션
- `~/.codex/external_agent_session_imports.json` — 다른 도구(Claude Code 등)에서 **가져온** 세션 목록. `records[].imported_thread_id`가 가져온 세션의 id다. 확인한 환경에서는 세션 45개 중 41개가 이 사본이었다. 원본을 같이 읽으면 같은 대화를 두 번 세게 되므로, 두 도구를 함께 볼 때는 사본을 뺀다. 이 파일이 없는 환경은 확인하지 못함.

## 줄 형식
한 줄이 JSON 하나. `type`과 `payload`로 나뉜다.
- `session_meta` — 세션 정보. `payload.id`, `payload.cwd`, `payload.source`. `source`가 `{"subagent": ...}`이면 서브에이전트 세션이므로 제외한다.
- 사람이 입력한 발화는 형식이 둘이다.
  - `event_msg` / `payload.type = "user_message"` → `payload.message`
  - `event_msg` / `payload.type = "item_completed"` 중 `payload.item.type = "UserMessage"` → `payload.item.content[].text`
  - 한 세션에는 보통 둘 중 하나만 있다. 둘 다 없는 옛 형식(`history_mode: legacy`)은 `response_item`의 `role: "user"`에서 고르되, `<environment_context>`, `# AGENTS.md instructions` 같은 도구가 넣은 텍스트는 거른다.
- AI 응답은 `response_item` / `payload.role = "assistant"` / `content[].type = "output_text"`.
- `response_item`의 `role: "user"`에는 사람이 쓴 발화 외에 도구가 모델에 넣은 맥락(권한 검토 요청, 요약 요청, 자동 알림)도 들어 있어 그대로 쓰지 않는다.
- `reasoning`, `custom_tool_call`, `token_count`, `turn_context` 등은 쓰지 않는다.

## 사람이 일한 세션만 고르기
- `session_meta`의 `source`가 `exec`이거나 `originator`가 `codex_exec`면 프로그램이 돌린 실행이라 뺀다. 확인한 환경에서 2026-10-24~29 세션 407개 중 406개가 이 경우였다.
- 지금 이 대화는 `CODEX_THREAD_ID`로 뺀다. 이 환경 변수 이름은 확인하지 못했다. 안 맞으면 `--exclude-session <id>`로 넘긴다.
