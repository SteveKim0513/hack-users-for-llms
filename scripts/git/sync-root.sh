#!/usr/bin/env bash
# 저장소 폴더(처음 clone한 곳)를 origin/main에 맞춘다. Claude Code는 훅·설정을 저장소 폴더에서 읽으므로,
# 거기가 옛 가지에 머물면 새 훅이 하나도 돌지 않는다(스튜디오 plugin/meta/cases/2026-10-25-stale-root-checkout.md).
#   scripts/git/sync-root.sh          어느 작업 폴더에서든 돌린다. ship.sh가 올린 뒤 부른다.
# 저장소 폴더가 main이 아니면 main으로 옮기고, 빨리감기만 한다. 커밋 안 한 변경이 있으면 손대지 않고 멈춘다.
# 저장소 폴더에서 git으로 쓰는 일은 worktree-guard 훅이 막는다. 이 스크립트가 그 예외의 유일한 길이다.
set -u
main="${SYNC_MAIN_BRANCH:-main}"
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || { echo "sync-root: git 저장소가 아니다" >&2; exit 2; }
root="$(dirname "$common")"
[ "$(basename "$common")" = ".git" ] || { echo "sync-root: 저장소 폴더를 찾지 못했다($common)" >&2; exit 2; }

git -C "$root" fetch -q origin "$main" 2>/dev/null || echo "sync-root: origin에서 받지 못해 이 컴퓨터의 origin/${main}으로 맞춘다" >&2
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "sync-root: 저장소 폴더($root)에 커밋 안 한 변경이 있어 맞추지 않았다. 그 변경의 주인에게 묻고 정리한 뒤 다시 돌린다:" >&2
  git -C "$root" status --short --untracked-files=no >&2
  exit 1
fi
cur="$(git -C "$root" symbolic-ref -q --short HEAD || echo "(가지 없음)")"
if [ "$cur" != "$main" ]; then
  git -C "$root" switch -q "$main" 2>/dev/null || git -C "$root" switch -q -c "$main" --track "origin/$main" || {
    echo "sync-root: 저장소 폴더를 ${cur}에서 ${main}으로 옮기지 못했다(${main}이 다른 작업 폴더에 열려 있으면 그쪽을 닫는다)" >&2
    exit 1
  }
  echo "sync-root: 저장소 폴더를 ${cur}에서 ${main}으로 옮겼다"
fi
git -C "$root" merge -q --ff-only "origin/$main" || { echo "sync-root: 저장소 폴더의 ${main}이 origin/${main}에서 갈라져 빨리감기가 안 된다. 사람이 본다" >&2; exit 1; }
echo "sync-root: 저장소 폴더가 origin/$main($(git -C "$root" rev-parse --short HEAD))에 있다"
