#!/usr/bin/env bash
# The git half of .github/workflows/playlist-archive.yml (docs/feeds.md, "The
# GitHub copy"). Kept in a file, not inline YAML, so it runs the same against a
# local bare repo in a test as it does in Actions.
#
#   playlist-archive-git.sh checkout <dir>             the archive branch into <dir>, or a new orphan branch
#   playlist-archive-git.sh push <dir> <message-file>  commit <dir> and push it, only when a file changed
#
# Env: ARCHIVE_REMOTE (default https://github.com/$GITHUB_REPOSITORY.git),
#      ARCHIVE_BRANCH (default playlists), GITHUB_TOKEN (Actions only).
#
# THE TOKEN NEVER REACHES THE DISK. It rides `git -c http.<url>.extraheader` on
# the one command that needs it, so the step that runs the copy script (which
# reads third-party feeds) finds no credential in <dir>/.git/config.
#
# NEVER A FORCE PUSH. A branch that moved since the checkout makes the push fail,
# and the run goes red; the next run starts from the new tip.
set -euo pipefail

cmd="${1:?usage: playlist-archive-git.sh checkout|push <dir> [message-file]}"
dir="${2:?missing <dir>}"
branch="${ARCHIVE_BRANCH:-playlists}"
remote="${ARCHIVE_REMOTE:-https://github.com/${GITHUB_REPOSITORY:?set GITHUB_REPOSITORY or ARCHIVE_REMOTE}.git}"

# `git` with the Actions token for github.com, when there is one.
authgit() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    local basic
    basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}" "$@"
  else
    git "$@"
  fi
}

case "$cmd" in
  checkout)
    git init -q "$dir"
    cd "$dir"
    git remote add origin "$remote"
    # --exit-code: 0 = the branch exists, 2 = it does not. Anything else is a
    # failure to ASK, and must stop the run rather than start a new branch.
    set +e
    authgit ls-remote --exit-code --heads origin "$branch" >/dev/null
    found=$?
    set -e
    if [ "$found" -eq 0 ]; then
      authgit fetch -q --depth=1 origin "refs/heads/${branch}"
      git checkout -q -B "$branch" FETCH_HEAD
      echo "checked out ${branch} at $(git rev-parse --short HEAD)"
    elif [ "$found" -eq 2 ]; then
      git checkout -q --orphan "$branch"
      echo "no ${branch} branch yet: starting it"
    else
      echo "could not ask the remote for ${branch} (git exit ${found})" >&2
      exit 1
    fi
    ;;
  push)
    msg="${3:?missing <message-file>}"
    # Absolute before the `cd`, so a relative path still names the same file.
    msg="$(cd "$(dirname "$msg")" && pwd)/$(basename "$msg")"
    cd "$dir"
    git add -A
    if git diff --cached --quiet; then
      echo "no change"
      exit 0
    fi
    git -c user.name='github-actions[bot]' \
        -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
        commit -q -F "$msg"
    authgit push -q origin "HEAD:refs/heads/${branch}"
    echo "pushed $(git rev-parse --short HEAD) to ${branch}"
    ;;
  *)
    echo "unknown command ${cmd}" >&2
    exit 2
    ;;
esac
