#!/usr/bin/env bash
# 지금 가지를 main에 올리고, 저장소 폴더를 따라 맞춘다(scripts/git/sync-root.sh).
#   scripts/git/ship.sh        작업 폴더에서 돌린다. 올리기 전에 나갈 커밋을 보인다.
# origin/main이 HEAD 안에 다 들어 있을 때만(빨리감기) 올린다. 아니면 먼저 합치고 검사를 돌린 뒤 다시 부른다.
# git push처럼 사람에게 묻고 돈다(.claude/settings.json permissions.ask).
set -eu
main="${SYNC_MAIN_BRANCH:-main}"
git fetch -q origin "$main"
if ! git merge-base --is-ancestor "origin/$main" HEAD; then
  echo "ship: origin/${main}에 이 가지에 없는 커밋이 있다. git merge origin/$main 하고 검사를 돌린 뒤 다시 부른다." >&2
  exit 1
fi
out="$(git log --oneline "origin/$main..HEAD")"
if [ -z "$out" ]; then
  echo "ship: 올릴 커밋이 없다"
else
  echo "ship: 나갈 커밋(이 대화에서 만들지 않은 것이 섞였으면 멈추고 묻는다):"
  printf '%s\n' "$out"
  git push -q origin "HEAD:$main"
  echo "ship: origin/$main ← $(git rev-parse --short HEAD)"
fi
exec "$(dirname "$0")/sync-root.sh"
