# hack-users-for-llms

AI에게 일을 맡기는 사람의 판단력을 키우는 도구 모음입니다. Claude Code와 Codex에서 씁니다.

| 기능 | 하는 일 | Claude Code | Codex |
|---|---|---|---|
| **세션 일기** | 켜 두면 매일 자정에 전날 AI 대화를 읽어 일기를 씁니다. 일하는 방식, 성과, AI 활용 수준을 근거와 함께 짚고 내일의 계획 하나를 줍니다. | O | 스킬만. `claude` 필요 |
| **criteria** | 합의한 판단 기준을 파일로 남기고, 기준 없이 맡긴 곳을 찾아 묻습니다. | O | 스킬만 |
| **compass** | 대화의 목표를 정하고, 턴마다 목표에 가까워지는지 패널에 보여 줍니다. | O | X |

Claude Code에서는 `/hack-mode` 하나로 화면 기능을 켜고 끕니다. Codex는 화면 기능 없이 스킬만 들어옵니다.

## 설치

**필요한 것:** `python3`(3.9와 3.14에서 시험함). 자동 일기는 macOS에서만 켤 수 있습니다.

### Claude Code

터미널에서 실행합니다. GitHub SSH 키가 없어도 HTTPS로 받습니다.

```bash
claude plugin marketplace add SteveKim0513/hack-users-for-llms
claude plugin install hack-users-for-llms@hack-users-for-llms
```

그다음 **새 세션을 엽니다.** 이미 열려 있던 세션에는 명령이 나타나지 않습니다.

기본은 모두 꺼져 있습니다. 켜기 전까지 AI를 부르거나 대화를 보내지 않습니다.

### Codex

Node.js가 필요합니다. 일기는 컴퓨터 전체 대화를 읽으므로 전체 사용자 설치(`-g`)를 권합니다.

```bash
npx skills add SteveKim0513/hack-users-for-llms -a codex -g -y --skill '*'
```

Codex를 다시 시작하면 스킬이 보입니다. `-g`를 빼면 지금 프로젝트에만 설치됩니다. `criteria-init`도 함께 들어오지만 Claude Code에서만 동작합니다.

**일기는 Codex에서 불러도 `claude -p`로 씁니다.** 이 컴퓨터에 `claude`가 설치되어 로그인되어 있어야 합니다. Codex 대화 기록은 일기의 재료로 함께 읽습니다.

## 처음 쓰기 (Claude Code)

**1. 새 세션에서 `/hack-mode`를 보냅니다.** 입력창 위에 버튼이 뜹니다.

**2. 원하는 모드를 고릅니다.** compass만, criteria만, 둘 다, 끄기 중에서 고르며, 고른 모드는 그 프로젝트에서 유지됩니다.

**3. 일기를 켜려면 "일기 켜기"를 누릅니다.** 프로젝트와 상관없이 컴퓨터 전체에 적용됩니다.

**4. "현재 시점으로 오늘 일기를 쓸까요?"에 답합니다.**
- **지금 쓰기:** 0시부터 지금까지로 씁니다. 오늘 일기는 이것으로 마무리되고, 이후 대화는 다시 쓰지 않으면 일기에 들어가지 않습니다.
- **안 쓰기:** 오늘 자정이 지나면 하루 전체로 써집니다.

**5. 다음 날 알림이 오면 `~/.session-diary/<날짜>.md`를 읽습니다.**

**알림이 안 뜨면:** macOS는 스크립트 편집기에서 알림을 한 번 보내기 전까지 오류 없이 알림을 버릴 수 있습니다. 스크립트 편집기에서 `display notification "시험"`을 한 번 실행하고, 시스템 설정 → 알림 → 스크립트 편집기에서 허용을 켭니다.

**버튼 없이 켜기:** 세션에서 "세션 일기 켜줘"라고 하거나 터미널에서 직접 실행합니다. AI의 권한 검사가 자동 실행 등록을 거절하면 터미널 방법을 쓰세요. 버전은 `claude plugin list`에서 확인합니다.

```bash
python3 ~/.claude/plugins/cache/hack-users-for-llms/hack-users-for-llms/<버전>/skills/session-diary/scripts/diary_auto.py on
```

## 명령 목록

| 명령 | 하는 일 |
|---|---|
| `/hack-mode` | 모드 고르기, 일기 켜고 끄기 |
| `/session-diary-now` | 0시부터 지금까지로 오늘 일기 쓰기. 이미 있으면 폐기하고 다시 쓸지 묻습니다 |
| `/compass` | 목표 정하기. `/compass 고칠 내용`으로 고치기 |
| `/compass-show` | 지금 목표 보기 |
| `/compass-reset` | 목표와 경로 지우기 |
| `/criteria-check` | 지금 대화를 바로 점검해 질문 띄우기 |

스킬은 앞에 플러그인 이름이 붙습니다. 말로 요청해도 됩니다("기준 보여줘", "어제 일기 보여줘").

| 스킬 | 하는 일 |
|---|---|
| `/hack-users-for-llms:session-diary` | 일기 켜기, 끄기, 상태 보기, 읽어 주기, 다시 쓰기 |
| `/hack-users-for-llms:criteria` | 판단 기준 기록, 조회, 변경 |
| `/hack-users-for-llms:criteria-gap` | 대화에서 기준 없이 맡긴 곳을 찾아 묻기 (`criteria` 필요) |
| `/hack-users-for-llms:criteria-init` | 일을 맡기기 전 기준 점검 훅 켜고 끄기, 질문 강도와 횟수 정하기 |

Codex에서는 "세션 일기 상태 보여줘"처럼 말로 부릅니다. Codex의 격리 설정이 자동 실행 등록을 막으면 터미널에서 켭니다.

```bash
python3 ~/.agents/skills/session-diary/scripts/diary_auto.py on
```

## 세션 일기

**쓰는 때:** 매 정각과 로그인 때 깨어나, 켠 날 이후 빠진 날을 씁니다. 컴퓨터가 꺼져 있던 날은 다음에 켜질 때 씁니다. 대화가 없던 날은 없었다고 남기고 알리지 않습니다.

**담기는 것:** 일상 언어로 쓴 본문, 내일의 계획, 내 메모 칸, 원문 근거, 통계(세션, 발화, 활동 시간, 커밋, 토큰, 쓰는 데 든 비용) 순서입니다. 점수는 매기지 않고 지난 일기와 비교합니다. 내 메모에 쓴 글은 다음 일기가 읽습니다.

**다시 쓰기:** `/session-diary-now`를 다시 부르면 0시부터 그 시점까지로 새로 쓰고, 이전 일기와 내 메모는 폐기합니다. 쓰지 못하면 이전 일기는 그대로 남습니다.

**주의: 대화가 아직 없을 때 지금 쓰면 그날이 "대화 없음"으로 닫힙니다.** 예를 들어 0시 직후에 쓰면 그날 자정 자동 쓰기가 건너뜁니다. 그날 안에 `/session-diary-now`로 다시 쓰면 됩니다.

**보내는 것:** 일기는 이 컴퓨터의 `claude -p`로 쓰지만, 글을 쓰는 모델은 Anthropic 서버에서 돕니다. 그래서 켜면 **이 컴퓨터의 모든 프로젝트 대화를 Anthropic으로 보냅니다.** Codex 대화도 포함됩니다. 키는 정해진 패턴만 가리므로 대화에 넣은 비밀값이 나갈 수 있습니다. 일기는 저장소 밖 `~/.session-diary/`에만 저장합니다.

**비용:** 구독으로 로그인했다면 별도 청구 없이 구독 사용량에서 차감됩니다. API 키로 쓰면 실제 요금이 나갑니다. 일기에 적히는 금액은 `claude`가 알려 주는 API 요금 환산치입니다. 재료 16~19만 자인 날 약 $0.7~0.9, 1만 자인 날 약 $0.15~0.25였습니다(Sonnet, 2026-10-30~11-02, 한 사람 기록). 대화가 없는 날은 AI를 부르지 않습니다. 호출 한 번의 상한은 환산치 $3입니다.

**권한:** 재료에는 웹 글이나 붙여넣은 글이 섞여 있어 숨은 지시를 따를 위험이 있습니다. 그래서 AI는 도구 없이 글만 돌려주고, 파일 읽기와 쓰기는 스크립트가 합니다.

**로그인:** 구독 로그인(`claude` 로그인)에서 확인했습니다. 자동 실행은 셸의 환경 변수를 물려받지 않으므로, 환경 변수에 둔 API 키로만 쓰고 있다면 로그인 실패로 쓰지 못할 수 있습니다.

**실패:** 다음 정각에 다시 시도하고, 6번 실패하면 그날 일기에 쓰지 못했다고 남기고 알립니다. 상태는 "일기 상태"라고 물어보면 됩니다.

## 화면 기능 (Claude Code)

**compass:** 도착점, "다 됐다"의 기준, 하지 말 것, 걸음 수를 질문으로 정합니다. 2턴 연속 벗어나면 알리고, 목표가 바뀐 것 같으면 버튼으로 확인합니다. 판정에 턴마다 Haiku를 한 번 부릅니다.

**criteria:** 턴이 끝난 뒤 생략된 전제, 섞인 구분, 원리 이해, 빠진 판단 기준이 보이면 질문 카드 하나를 띄웁니다. 보기를 누르거나 직접 답하고, "모름"과 "건너뛰기"도 있습니다. 물을 수 있는 턴에만 Sonnet을 한 번 부릅니다. 기본값은 약한 강도, 세션당 3번, 3턴 쉬기이고 `criteria-init`으로 바꿉니다.

**둘 다:** 판정 한 번(Sonnet)으로 진척과 질문을 함께 하고, 질문도 목표에 비추어 고릅니다.

**위임 전 점검 훅:** `criteria-init`으로 켜면 일을 맡기는 요청이 감지될 때만 기록소를 조회해, 확정 기준을 Claude에게 알리고 없으면 작업 전에 묻게 합니다. 기본은 꺼짐입니다. 세션당 횟수 제한과 쿨다운이 있습니다.

## 업데이트

**Claude Code:** 두 명령을 차례로 실행하고 새 세션을 엽니다. `plugin update`만 실행하면 새 판을 찾지 못하고 "이미 최신"이라고 나옵니다.

```bash
claude plugin marketplace update hack-users-for-llms
claude plugin update hack-users-for-llms@hack-users-for-llms
```

**Codex:**

```bash
npx skills update -g -y
```

**일기를 켜 뒀다면 한 번 더 켭니다.** 자동 실행은 복사해 둔 판으로 돌기 때문입니다. 끄지 말고 "세션 일기 다시 켜줘"라고 하거나 위의 터미널 켜기 명령을 다시 실행하세요. 끄면 시작 날짜가 초기화되어 아직 쓰지 못한 날이 빠집니다.

## 지우기

**1. 일기를 먼저 끕니다.** 플러그인을 지워도 자동 실행은 복사본으로 **계속 돌면서 대화를 AI에 보냅니다.**

```bash
python3 ~/.session-diary/.auto/app/scripts/diary_auto.py off
```

**2. 플러그인을 지웁니다.**

```bash
claude plugin uninstall hack-users-for-llms@hack-users-for-llms
claude plugin marketplace remove hack-users-for-llms
```

Codex는 이 명령입니다.

```bash
npx skills remove criteria criteria-gap criteria-init session-diary -g -y
```

**3. 일기까지 지우려면** `~/.session-diary` 폴더를 지웁니다. 일기는 자동으로 지워지지 않습니다.

## 확인한 것과 확인하지 못한 것

**확인함 (2026-11-03, macOS 26.6, Claude Code 2.1.312, Codex CLI 0.164.0):**
- 빈 설정에서 GitHub로 설치, SSH 없이 설치, 업데이트, 삭제
- 설치 뒤 새 세션에 명령 6개와 스킬 4개 등록
- Codex 설치와 스킬 인식, 전체 사용자 범위 설치, 갱신 명령 실행, 삭제
- launchd 등록 뒤 로그인 실행으로 일기 쓰기(1회), 매 정각 실행
- `/session-diary-now`로 일기 쓰기, 터미널에서 보낸 macOS 알림

**확인하지 못함:**
- `/hack-mode` 버튼, compass 패널, criteria 질문 카드가 끝까지 동작하는지. 가짜 엔진 시험은 통과했고, 실제 세션에서 명령을 보낸 기록은 있지만 동작까지 확인하지는 못했습니다. 판정 모델이 좋은 질문을 고르는지도 모릅니다.
- 세션 안에서 `/plugin`으로 설치하기. 터미널 명령만 실행했습니다.
- 자정에 실제로 전날 일기가 써지는지, 자동 실행에서 알림이 뜨는지, 잠자기와 재부팅 뒤 동작.
- Codex 세션에서 일기 켜기, API 키 로그인, macOS 밖 환경.

## 기여

새 스킬은 `templates/skill`을 `skills/<이름>`으로 복사해 시작합니다.

- 헤더는 `name`(폴더명과 같게), `description`만 씁니다.
- 본문에 특정 도구 이름을 넣지 않습니다. 필요하면 `references/claude.md`, `references/codex.md`로 나눕니다.
- `skills/`를 바꾸면 `.claude-plugin/plugin.json`의 `version`을 올립니다. 올리지 않으면 설치한 쪽이 새 판을 받지 못합니다.

```bash
(cd hooks && python3 -m unittest -v test_criteria_hook)
(cd skills/session-diary/scripts && python3 -m unittest -v test_day_sessions test_diary_auto)
claude plugin validate . && claude plugin test .
```
