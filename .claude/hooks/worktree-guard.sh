#!/usr/bin/env bash
# 세션마다 자기 작업 폴더(git worktree)에서 일하게 한다(스튜디오 work.md 5절, plugin/meta/cases/2026-10-25-shared-checkout.md).
# 저장소 폴더(처음 clone한 곳)는 여러 세션이 같이 보는 자리라, 거기서 git으로 쓰는 일을 막는다.
# 다른 작업 폴더에서는 git이 "가지 하나 = 작업 폴더 하나"를 지켜 주므로 이 훅이 더 할 일이 없다.
#   session: 세션이 시작될 때(SessionStart) 저장소 폴더면 옮기라고 알린다(막지는 않는다: 읽기만 하는 세션도 있다).
#            저장소 폴더가 main이 아니거나 origin/main보다 뒤면 맞추라고 알린다: Claude Code는 훅·설정을 거기서 읽는다.
#   bash:    Bash를 부르기 전에(PreToolUse) 저장소 폴더에서 git으로 쓰는 명령이면 막는다(exit 2).
set -u

mode="${1:-}"
input="$(cat)"

# 이 폴더가 저장소 폴더인가(연결된 작업 폴더가 아니라). git 폴더가 아니면 판단하지 않는다.
is_main_checkout() {
  local dir="$1" git_dir common_dir
  git_dir="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)" || return 1
  common_dir="$(cd "$dir" && cd "$(git rev-parse --git-common-dir)" && pwd -P)" || return 1
  [ "$(cd "$git_dir" && pwd -P)" = "$common_dir" ]
}

# 훅 입력(JSON)에서 점으로 이은 키 하나를 읽는다(예: tool_input.command). 없으면 빈 글.
field() {
  printf '%s' "$input" | python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key, "") if isinstance(value, dict) else ""
print(value if isinstance(value, str) else "")' "$1" 2>/dev/null
}

# 저장소 폴더가 origin/main에 있나. 이 컴퓨터의 origin/main으로만 본다(세션 시작마다 받지 않는다).
check_root() {
  local common root main cur behind
  main="${SYNC_MAIN_BRANCH:-main}"
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  [ "$(basename "$common")" = ".git" ] || return 0
  root="$(dirname "$common")"
  git -C "$root" rev-parse -q --verify "refs/remotes/origin/$main" >/dev/null || return 0
  cur="$(git -C "$root" symbolic-ref -q --short HEAD || echo "(가지 없음)")"
  behind="$(git -C "$root" rev-list --count "HEAD..refs/remotes/origin/$main" 2>/dev/null || echo 0)"
  if [ "$cur" != "$main" ] || [ "$behind" -gt 0 ]; then
    echo "저장소 폴더($root)가 ${cur}에 있고 origin/${main}보다 ${behind}커밋 뒤다. Claude Code는 훅·설정을 거기서 읽으므로 새 훅이 돌지 않는다. scripts/git/sync-root.sh로 맞춘다(커밋 안 한 변경이 있으면 멈추고 알린다)."
  fi
}

case "$mode" in
  session)
    cwd="$(field cwd)"
    check_root "${cwd:-.}"
    if is_main_checkout "${cwd:-.}"; then
      echo "이 세션은 저장소 폴더에서 시작했다. 파일을 고치거나 커밋하기 전에 자기 작업 폴더로 옮긴다(EnterWorktree 도구, 또는 git worktree add .claude/worktrees/<이름> -b <가지>). 저장소 폴더에서 git으로 쓰는 명령은 훅이 막는다."
    fi
    ;;
  bash)
    cwd="$(field cwd)"
    cmd="$(field tool_input.command)"
    # git으로 저장소 상태를 바꾸는 명령만 본다. 읽기(status, log, diff, show)와 worktree 만들기는 통과한다.
    if ! printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(commit|merge|rebase|cherry-pick|revert|am|pull|reset|checkout|switch|stash|add|rm|mv|restore)([[:space:]]|$)'; then
      exit 0
    fi
    # 명령이 다른 폴더를 가리키면(git -C <폴더>, 앞에 cd <폴더>) 그 폴더를 본다.
    target="$cwd"
    c_dir="$(printf '%s' "$cmd" | sed -nE 's/.*git[[:space:]]+-C[[:space:]]+"?([^"[:space:]]+)"?.*/\1/p' | head -1)"
    cd_dir="$(printf '%s' "$cmd" | sed -nE 's/^[[:space:]]*cd[[:space:]]+"?([^"[:space:];&]+)"?.*/\1/p' | head -1)"
    [ -n "$cd_dir" ] && target="$cd_dir"
    [ -n "$c_dir" ] && target="$c_dir"
    case "$target" in "~"*) target="$HOME${target#\~}" ;; /*) ;; *) target="${cwd:-.}/$target" ;; esac
    if is_main_checkout "$target"; then
      {
        echo "막음: 저장소 폴더에서는 git으로 쓰지 않는다(여러 세션이 같이 보는 자리다)."
        echo "자기 작업 폴더로 옮긴다: EnterWorktree 도구, 또는 git worktree add .claude/worktrees/<이름> -b <가지>."
        echo "합치기·올리기도 작업 폴더에서 한다(main에 올리기는 scripts/git/ship.sh, 저장소 폴더를 main에 맞추기는 scripts/git/sync-root.sh)."
      } >&2
      exit 2
    fi
    ;;
esac
exit 0
