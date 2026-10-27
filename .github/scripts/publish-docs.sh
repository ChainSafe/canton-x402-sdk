#!/usr/bin/env bash
# Publish (or remove) one directory of the docs site on the `gh-pages` branch.
#
# GitHub Pages serves that branch, so the branch IS the site: production at the
# root, each pull request's preview under pr-<N>/. One script for all three
# writers so the rule that a production publish must not delete other people's
# previews is written once.
#
#   publish-docs.sh site <dist-dir>        replace the root, keep every pr-*/
#   publish-docs.sh preview <dist> <n>     replace pr-<n>/ only
#   publish-docs.sh remove <n>             delete pr-<n>/
#
# IT RETRIES RATHER THAN RELYING ON A CONCURRENCY GROUP. Three workflows write
# this branch, and merging a pull request fires two of them at once (the
# close, and the push to main). A shared `concurrency` group looks like the
# answer, but GitHub keeps only ONE pending run per group and cancels the run
# already waiting when a third arrives — so a cleanup could be dropped
# silently, leaving a stale preview and no failure to notice. Each attempt
# starts from a fresh clone and is therefore idempotent, so losing a race just
# means doing it again.
set -euo pipefail

mode=${1:?usage: publish-docs.sh site|preview|remove ...}
ATTEMPTS=${PUBLISH_ATTEMPTS:-5}

# WHERE THE CREDENTIAL COMES FROM. actions/checkout writes its auth header
# into the checked-out repository's own config, so a clone made anywhere else
# has none — the first run of this failed with "could not read Username".
# The token goes in the remote URL instead; Actions masks it in logs. Outside
# CI (the local tests) the checkout's own remote is used as-is.
remote_url() {
  if [ -n "${GH_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
    printf 'https://x-access-token:%s@github.com/%s.git' "$GH_TOKEN" "$GITHUB_REPOSITORY"
  else
    git remote get-url origin
  fi
}

# An auth or network failure is not a lost race, and retrying it five times
# only delays the report. Only a rejected update is worth another attempt.
is_race() {
  grep -qiE 'rejected|non-fast-forward|fetch first|stale info' "$1"
}
PUSH_ERR=$(mktemp)
trap 'rm -f "$PUSH_ERR"' EXIT

attempt() {
  local work
  work=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" RETURN

  if git ls-remote --exit-code --heads "$(remote_url)" gh-pages >/dev/null 2>&1; then
    git clone --quiet --depth 1 --branch gh-pages "$(remote_url)" "$work"
  else
    git clone --quiet --depth 1 "$(remote_url)" "$work"
    git -C "$work" checkout --quiet --orphan gh-pages
    git -C "$work" rm -rqf . >/dev/null 2>&1 || true
    # Pages would otherwise run Jekyll over this and drop what it does not like.
    touch "$work/.nojekyll"
  fi

  local message
  case "$mode" in
    site)
      local dist=${2:?a dist directory is required}
      # Everything at the root is ours to replace — except the previews, which
      # belong to open pull requests, and the files that make Pages work.
      find "$work" -mindepth 1 -maxdepth 1 \
        -not -name '.git' \
        -not -name '.nojekyll' \
        -not -name 'CNAME' \
        -not -name 'pr-*' \
        -exec rm -rf {} +
      cp -R "$dist"/. "$work"/
      message="docs: publish ${GITHUB_SHA:0:7}"
      ;;
    preview)
      local dist=${2:?a dist directory is required}
      local n=${3:?a pull request number is required}
      rm -rf "${work:?}/pr-${n}"
      mkdir -p "$work/pr-${n}"
      cp -R "$dist"/. "$work/pr-${n}"/
      message="docs: preview pr-${n} at ${GITHUB_SHA:0:7}"
      ;;
    remove)
      local n=${2:?a pull request number is required}
      rm -rf "${work:?}/pr-${n}"
      message="docs: remove preview pr-${n}"
      ;;
    *)
      echo "unknown mode: $mode" >&2
      return 2
      ;;
  esac

  git -C "$work" add --all
  if git -C "$work" diff --cached --quiet; then
    echo "nothing to publish"
    return 0
  fi
  git -C "$work" \
    -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "$message"
  # Git's own rejection goes to a file, not the log: a race that the next
  # attempt wins is not something an operator should have to read past. It is
  # printed only if every attempt fails.
  if ! git -C "$work" push --quiet "$(remote_url)" HEAD:gh-pages 2>"$PUSH_ERR"; then
    return 1
  fi
  echo "pushed: $message"
}

for i in $(seq 1 "$ATTEMPTS"); do
  if attempt "$@"; then exit 0; fi
  if ! is_race "$PUSH_ERR"; then
    echo "::error::publishing to gh-pages failed, and not because of a race" >&2
    cat "$PUSH_ERR" >&2
    exit 1
  fi
  if [ "$i" -lt "$ATTEMPTS" ]; then
    echo "push rejected — someone else wrote gh-pages; retrying ($i/$ATTEMPTS)" >&2
    sleep $(( i + RANDOM % 3 ))
  fi
done

echo "::error::could not publish to gh-pages after ${ATTEMPTS} attempts" >&2
cat "$PUSH_ERR" >&2
exit 1
