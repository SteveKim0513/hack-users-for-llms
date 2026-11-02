# hack-users-for-llms

Claude Code와 Codex에서 함께 쓰는 스킬 모음. 스킬은 `skills/<이름>/SKILL.md` 한 폴더 단위다. `.claude-plugin/`이 있어 Claude 플러그인으로도 설치된다. 스킬을 추가하면 `plugin.json`의 `version`을 올려야 설치된 쪽이 갱신을 받는다.

## 설치

### Claude Code (플러그인)
```
/plugin marketplace add SteveKim0513/hack-users-for-llms
/plugin install hack-users-for-llms@hack-users-for-llms
```

### Codex
```bash
# 스킬 CLI. 현재 프로젝트에 설치, 전체 사용자용은 -g
npx skills add SteveKim0513/hack-users-for-llms -a codex

# 수동: 저장소를 받아 사용자 스킬 폴더에 링크 (Codex는 ~/.agents/skills를 읽는다)
git clone https://github.com/SteveKim0513/hack-users-for-llms.git ~/hack-users-for-llms
mkdir -p ~/.agents/skills
ln -s ~/hack-users-for-llms/skills/criteria ~/.agents/skills/criteria
ln -s ~/hack-users-for-llms/skills/criteria-gap ~/.agents/skills/criteria-gap
ln -s ~/hack-users-for-llms/skills/session-diary ~/.agents/skills/session-diary
```
설치 후 스킬이 안 보이면 Codex를 재시작한다.

### Claude Code (수동)
```bash
ln -s ~/hack-users-for-llms/skills/<스킬이름> ~/.claude/skills/<스킬이름>
```

## 새 스킬 만들기

1. `templates/skill`을 `skills/<스킬이름>`으로 복사
2. `SKILL.md`의 `name`(폴더명과 동일)과 `description` 수정
3. 본문에 절차 작성. 필요하면 `scripts/`, `references/` 추가

## 호환 규칙

- 헤더는 `name`, `description`만 쓴다
- 특정 도구 이름(Claude 전용 도구 등)을 본문에 박지 않는다
- 에이전트 전용 동작이 필요하면 `references/claude.md`, `references/codex.md`로 분리한다

## 스킬 목록

| 스킬 | 설명 |
|---|---|
| `criteria` | 합의한 판단 기준을 기록·조회·변경하는 기준 기록소. |
| `criteria-init` | 위임 전 기준 점검 훅을 켜고 끄는 스위치. criteria 점검 mod 질문의 강도와 횟수도 여기서 정한다 (Claude Code 플러그인 전용) |
| `criteria-gap` | 대화에서 기준 공백을 찾아 대화로 묻고, AI의 암묵 기준과 비교해 재요청 (`criteria` 필요) |
| `session-diary` | 켜 두면 매일 자정에 전날의 세션 기록(Claude Code·Codex)으로 일기를 자동으로 남긴다. 일하는 방식, 성과, AI를 쓰는 수준을 인용 근거로 피드백하고 내일의 계획 하나를 준다. 점수는 없고 지난 일기와 비교한다. 꺼져 있던 날은 다음에 켜질 때 쓰고, 대화가 없던 날은 없었다고 남긴다. 일기는 저장소 밖 `~/.session-diary/`에 저장. 아래 "자동 세션 일기" 참고 |

## Mod: compass, criteria (Claude Code 플러그인 전용)

Claude Code 화면에 붙는 기능 두 개다. 플러그인으로 설치해야 들어오고, Codex에는 없다. 기본은 꺼져 있고, `/hack-mode`로 켠다. 입력창 위에 버튼이 떠서 **compass만 / criteria만 / 둘 다 / 끄기** 중 고르고, 고른 모드는 이 프로젝트에서 계속 유지된다.

- **compass**: `/compass`로 대화의 목표(도착점, "다 됐다"의 기준, 하지 말 것, 걸음 수)를 질문으로 정하면, 턴마다 목표에 가까워졌는지 판정해 패널에 LED 판으로 보여 준다. 2턴 연속 벗어나면 입력창 위에 알리고, 목표가 바뀐 것 같으면 버튼으로 확인한다. 판정에 턴마다 Haiku를 한 번 부른다.
- **criteria**: 턴이 끝나면 사용자 생각에 빈 곳(생략된 전제, 섞인 구분, 원리 이해, 빠진 판단 기준)이 보이면 입력창 위에 질문 카드 하나를 띄운다. 보기를 누르거나(객관식, 숫자키) 직접 써서(주관식) 답하고, "모름"과 "건너뛰기"도 있다. 답은 대화로 들어가 `criteria-gap` 스킬의 절차로 다뤄진다. 강도, 세션당 횟수, 쉬는 턴은 `criteria-init` 설정을 따르고, 없으면 기본값(light, 3번, 3턴)이다. 물을 수 있는 턴에만 Sonnet을 한 번 부른다.
- **둘 다**: 판정 한 번(Sonnet)으로 진척과 질문을 함께 하고, 질문도 목표에 비추어 고른다.

| 명령 | 하는 일 |
|---|---|
| `/hack-mode` | 모드 고르기 (compass만 / criteria만 / 둘 다 / 끄기) |
| `/compass` | 목표 정하기. 뒤에 글을 붙이면(`/compass 고칠 내용`) 목표 고치기 |
| `/compass-show` | 지금 목표 보기 |
| `/compass-reset` | 목표와 경로 지우기 |
| `/criteria-check` | 쉬는 턴을 무시하고 지금 대화를 바로 점검해 질문 띄우기 |
| `/session-diary-now` | 0시부터 지금까지로 오늘 세션 일기 쓰기. 이미 있으면 폐기하고 다시 쓴다고 묻는다 |

확인하지 못함: 실제 세션에서 띄워 보지 않았다. `claude plugin validate`와 `claude plugin test`(가짜 엔진으로 모드 고르기, 화면 그리기, 버튼, 입력칸, 횟수 제한)만 통과했다. 판정 모델이 실제로 좋은 질문을 고르는지도 확인하지 못했다.

## 자동 세션 일기

`/hack-mode`의 "일기 켜기" 버튼이나 "세션 일기 켜줘", 또는 `python3 skills/session-diary/scripts/diary_auto.py on`으로 켠다. 끄기는 `off`, 상태는 `status`. 켜면 스크립트를 `~/.session-diary/.auto/app`에 복사하고 launchd에 등록한다. 매 정각과 로그인 때 깨어나 어제까지 빠진 일기를 쓴다. 플러그인을 업데이트하면 다시 켜야 새 판이 돈다.

켤 때 오늘 일기를 지금 쓸지 묻는다. 지금 쓰면 0시부터 그 시점까지로 쓰고 그날 자정 자동 쓰기는 없다. 그 뒤의 대화는 일기에 들어가지 않는다. 나중에 다시 쓰면(`/session-diary-now`) 0시부터 그 시점까지로 새로 쓰고 이전 일기와 내 메모는 폐기한다. 쓰지 못하면 이전 일기는 그대로 남는다.

- **권한:** 재료에는 웹 글이나 붙여넣은 글이 들어 있다. 숨은 지시를 따를 위험이 있어 AI는 도구 없이 글만 돌려주고, 파일 읽기와 쓰기는 스크립트가 한다. Codex는 도구를 끌 수 없어 읽기 전용 격리로 돌리며 보호가 더 약하다. `claude`가 있으면 그것을 먼저 쓴다.
- **보내는 것:** 이 컴퓨터의 모든 프로젝트 대화를 AI 서비스로 보낸다. 키는 정해진 패턴만 가린다.
- **비용:** 2026-10-30~11-02 실측. Sonnet으로 재료 16~19만 자인 날 약 $0.7~0.9, 1만 자인 날 약 $0.15~0.25. 대화가 없는 날은 AI를 부르지 않는다.
- **통계:** 일기마다 프로그램이 세션, 발화, 활동 시간, 커밋, 토큰(내 세션, 서브에이전트, 자동 실행, 모델별)과 그 일기를 쓰는 데 든 비용을 넣고, 숫자는 머리말에도 남겨 다음 일기가 비교한다. Codex로 쓴 일기는 쓰는 데 든 비용을 알 수 없다.
- **실패:** 다음 정각에 다시 시도하고, 6번 실패하면 그 날 일기에 쓰지 못했다고 남긴다.

확인한 것: launchd에 등록하면 로그인 때 실행되어 어제 일기를 쓴다(macOS 26, Claude 구독 로그인, 1회).

확인하지 못함: `/hack-mode`의 일기 버튼을 실제 세션에서 눌러 보지 않았다(가짜 엔진 시험만 통과). 자정 실행, 잠자기와 재부팅 뒤 동작, Codex로 쓰기, macOS 밖 환경.

## 위임 전 점검 훅 (Claude Code 전용, 기본 꺼짐)

플러그인에 `hooks/`가 들어 있지만, 켜기 전에는 아무것도 하지 않는다. 켜려면 Claude Code에서 `criteria-init`을 실행한다(범위와 강도를 묻는다).
켜면 일을 맡기는 요청이 감지될 때만 기록소를 조회해, 확정 기준은 Claude에게 알려 주고 없으면 작업 전에 묻게 한다. `/hack-mode`로 criteria를 켠 세션에서는 묻는 일을 그 mod가 맡는다. 세션당 횟수 제한과 쿨다운이 있다. 끄려면 `criteria-init`으로 끄거나 `.criteria/config.json`의 `enabled`를 `false`로 바꾼다.

## 개발

```bash
(cd hooks && python3 -m unittest -v test_criteria_hook)
(cd skills/session-diary/scripts && python3 -m unittest -v test_day_sessions test_diary_auto)
claude plugin validate . && claude plugin test .
```
