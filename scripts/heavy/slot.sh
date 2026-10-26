#!/usr/bin/env bash
# 무거운 명령(e2e, 전체 시험)을 컴퓨터 전체에서 정한 수만큼만 동시에 돌린다(스튜디오 팀 원칙 agents.md 원칙 4).
# 세션·작업 폴더가 여럿이어도 CPU는 하나라, 자리를 컴퓨터 전체 잠금 폴더에서 받는다. 넘치면 시간 초과 거짓 실패가 난다.
#
#   scripts/heavy/slot.sh <종류> <명령...>      예: scripts/heavy/slot.sh e2e playwright test
#
# 자리 수: HEAVY_SLOTS_<종류 대문자>(기본 e2e 1, test 2, 그 밖 1). 파일을 고른 시험은 자리를 받지 않는다(TS 웹은 scripts/heavy/vitest.sh가 가른다). 잠금 폴더: ~/.cache/dev-env/heavy/<종류>/.
# 자리를 쥔 쪽이 죽으면(kill -9 포함) 다음에 기다리는 쪽이 치우고 받는다. CI에서는 그냥 돈다(러너 하나에 일 하나).
set -u

kind="${1:?종류(e2e, test …)와 명령을 준다}"
shift
[ $# -gt 0 ] || { echo "slot.sh: 돌릴 명령을 준다" >&2; exit 2; }

# CI이거나, 이미 같은 종류의 자리 안에서 부른 것이면 그냥 돈다.
if [ -n "${CI:-}" ]; then exec "$@"; fi
case " ${HEAVY_HELD:-} " in *" $kind "*) exec "$@" ;; esac

upper="$(printf '%s' "$kind" | tr '[:lower:]-' '[:upper:]_')"
eval "slots=\${HEAVY_SLOTS_${upper}:-}"
if [ -z "$slots" ]; then
  case "$kind" in test) slots=2 ;; *) slots=1 ;; esac
fi
dir="${XDG_CACHE_HOME:-$HOME/.cache}/dev-env/heavy/$kind"
# 잠금 폴더를 못 만들면(쓰기 막힌 홈, 모래상자) 자리 없이 그냥 돈다. 멈춰 기다리는 것보다 낫다.
if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
  echo "[heavy] 잠금 폴더($dir)를 쓸 수 없어 자리 없이 돈다." >&2
  exec "$@"
fi
me="$dir/holder-$$"
mutex="$dir/.mutex"

# 자리 주인이 살아 있나. pid가 다른 프로그램에 다시 쓰였으면 죽은 것으로 본다.
alive() { ps -p "$1" -o command= 2>/dev/null | grep -q 'slot\.sh'; }

# 짧은 잠금 안에서 죽은 자리를 치우고 빈 자리가 있으면 받는다. 받으면 0.
# 잠금을 오래 못 받으면(1분 넘은 남은 잠금은 치우므로 정상이면 없다) 한 줄 알리고 자리 없이 돈다.
mutex_tries=0
take() {
  until mkdir "$mutex" 2>/dev/null; do
    # 잠금을 쥔 채 죽은 쪽이 남긴 잠금(1분 넘음)은 치운다. 정상이면 잠금은 몇 ms만 쥔다.
    [ -n "$(find "$mutex" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$mutex" 2>/dev/null
    mutex_tries=$((mutex_tries + 1))
    if [ "$mutex_tries" -ge "${HEAVY_MUTEX_TRIES:-900}" ]; then
      echo "[heavy] $mutex 잠금을 $((mutex_tries / 10))초 넘게 못 받아 자리 없이 돈다. 남은 잠금이면 지운다: rmdir $mutex" >&2
      exec "$@"
    fi
    sleep 0.1
  done
  mutex_tries=0
  running=0
  holders=""
  for h in "$dir"/holder-*; do
    [ -e "$h" ] || continue
    pid="${h##*/holder-}"
    if alive "$pid"; then
      running=$((running + 1))
      holders="$holders $pid"
    else
      rm -f "$h"
    fi
  done
  got=1
  if [ "$running" -lt "$slots" ]; then
    printf '%s\n' "$PWD: $*" >"$me"
    got=0
  fi
  rmdir "$mutex" 2>/dev/null
  return "$got"
}

said=0
until take; do
  if [ "$said" = 0 ]; then
    echo "[heavy] $kind 자리 기다림: $running/$slots 사용 중(pid$holders). 자리가 나면 바로 시작한다." >&2
    said=1
  fi
  sleep 1
done

trap 'rm -f "$me"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export HEAVY_HELD="${HEAVY_HELD:-} $kind"
"$@"
