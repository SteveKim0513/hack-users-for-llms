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
| `criteria-init` | 위임 전 기준 점검 훅을 켜고 끄는 스위치. `/compass` 질문의 강도와 횟수도 여기서 정한다 (Claude Code 플러그인 전용) |
| `criteria-gap` | 대화에서 기준 공백을 찾아 대화로 묻고, AI의 암묵 기준과 비교해 재요청 (`criteria` 필요) |

## Mod: `/compass` (Claude Code 플러그인 전용)

Claude Code 화면에 붙는 기능이다. 플러그인으로 설치해야 들어오고, Codex에는 없다.

`/compass`로 대화의 목표(도착점, "다 됐다"의 기준, 하지 말 것, 걸음 수)를 질문으로 정하면, 그때부터 턴이 끝날 때마다 판정 모델(Sonnet)을 한 번 불러 두 가지를 한다.
- **진척**: 목표에 가까워졌는지 판정해 패널에 LED 판으로 보여 준다. 2턴 연속 벗어나면 입력창 위에 알리고, 목표가 바뀐 것 같으면 버튼으로 확인한다.
- **빈 곳 점검**: 사용자 생각에 빈 곳(생략된 전제, 섞인 구분, 원리 이해, 빠진 판단 기준)이 보이면 입력창 위에 질문 카드 하나를 띄운다. 보기를 누르거나(객관식, 숫자키) 직접 써서(주관식) 답하고, "모름"과 "건너뛰기"도 있다. 답은 대화로 들어가 `criteria-gap` 스킬의 절차로 다뤄진다. 강도, 세션당 횟수, 쉬는 턴은 `criteria-init` 설정을 따르고, 없으면 기본값(light, 3번, 3턴)이다.

| 명령 | 하는 일 |
|---|---|
| `/compass [처음 생각]` | 목표 정하기 인터뷰 시작 |
| `/compass show` | 지금 목표 보기 |
| `/compass 수정할 내용` | 목표 고치기 |
| `/compass reset` | 목표와 경로 지우기 |

확인하지 못함: 실제 세션에서 띄워 보지 않았다. `claude plugin validate`와 `claude plugin test`(가짜 엔진으로 화면 그리기, 버튼, 입력칸, 횟수 제한)만 통과했다. 판정 모델이 실제로 좋은 질문을 고르는지도 확인하지 못했다.

## 위임 전 점검 훅 (Claude Code 전용, 기본 꺼짐)

플러그인에 `hooks/`가 들어 있지만, 켜기 전에는 아무것도 하지 않는다. 켜려면 Claude Code에서 `criteria-init`을 실행한다(범위와 강도를 묻는다).
켜면 일을 맡기는 요청이 감지될 때만 기록소를 조회해, 확정 기준은 Claude에게 알려 주고 없으면 작업 전에 묻게 한다. `/compass` 목표가 있는 세션에서는 묻는 일을 compass가 맡는다. 세션당 횟수 제한과 쿨다운이 있다. 끄려면 `criteria-init`으로 끄거나 `.criteria/config.json`의 `enabled`를 `false`로 바꾼다.

## 개발

```bash
cd hooks && python3 -m unittest -v test_criteria_hook
claude plugin validate . && claude plugin test .
```
