# hack-users-for-llms 작업 규칙

Claude Code와 Codex에서 함께 쓰는 공개 스킬 repo다. 스킬은 `skills/<이름>/SKILL.md` 한 폴더 단위.

공통 개발 규칙(일하는 법·코드 규칙·팀 원칙·스킬)은 스튜디오 플러그인 팀 문서가 맡는다. 이 문서는 이 프로젝트의 값만 둔다.

## 스킬을 바꿀 때마다
- `skills/` 아래 파일을 바꾸면 **`.claude-plugin/plugin.json`의 `version`을 올린다.** 올리지 않으면 설치한 쪽이 업데이트를 받지 못한다. 문구 수정은 패치(0.4.1 → 0.4.2), 스킬 추가·동작 변경은 마이너(0.4.x → 0.5.0).
- 바꾼 내용, 버전 올림, 푸시까지 한 번에 끝낸다. 버전만 따로 나중에 올리지 않는다.
- README의 스킬 목록이 바뀐 스킬과 맞는지 확인한다.

## 호환 규칙
- `SKILL.md` 헤더는 `name`, `description`만 쓴다. `name`은 폴더 이름과 같게.
- 본문에 Claude나 Codex 전용 도구 이름을 박지 않는다. 필요하면 `references/claude.md`, `references/codex.md`로 분리한다.
- 스킬 폴더는 `skills/` 바로 아래에 평평하게 둔다. 중첩하지 않는다. 관련 스킬은 이름 앞부분을 맞춘다(`criteria`, `criteria-gap`).
- 스킬이 쓰는 파일은 그 스킬 폴더 안에 둔다. 폴더 밖 파일에 기대지 않는다.

## 훅 (`hooks/`)
- 훅은 **어떤 경우에도 사용자 입력을 막지 않는다.** 항상 종료 코드 0, 오류는 조용히 삼킨다.
- 켜져 있지 않으면(`config.json`의 `enabled`가 `true`가 아니면) **출력이 없어야 한다.** 기본은 꺼짐이다.
- 주입하는 텍스트는 지시문이 아니라 사실 진술로 쓴다(Claude Code 문서 권고).
- 훅을 고치면 `cd hooks && python3 -m unittest test_criteria_hook`를 돌린다. 이 repo 루트의 `CLAUDE.md`는 플러그인 컨텍스트로 로드되지 않는다(작업자용).

## 공개 repo 주의
- 이 repo는 공개다. 개인 기준(`.criteria/`), 키, 개인 경로를 올리지 않는다.
- 새 스킬은 `templates/skill/`을 복사해서 시작한다.

## 검증하지 못한 것은 그렇게 쓴다
- README에는 실제로 실행해 보지 않은 설치 명령이나 동작을 "확인하지 못함"으로 구분해 적는다.
