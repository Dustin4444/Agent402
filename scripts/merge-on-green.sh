#!/usr/bin/env bash
# Merge a PR from the dev branch only after the PUSH-event run of its head SHA
# is green, then report what main deployed.
#
# Why this exists: with a PR open, every push spawns TWO deploy.yml runs (push
# and pull_request). "The first run matching the SHA" is usually the PR run,
# which finishes earlier and never deploys. Merging on it (2026-08-25) meant
# the tree-gate on main - which only trusts push-event runs - had no green run
# to match and re-ran the whole suite; on 2026-08-22 the same mistake cancelled
# a deploy outright. The push run is the only one that counts, so this script
# refuses to consider any other.
#
#   scripts/merge-on-green.sh <pr-number> [branch]
#
# Needs gh (authenticated). Exits non-zero, merging nothing, if the push run is
# red, cancelled, or cannot be found within the wait budget.
set -euo pipefail
PR="${1:?pr number}"
BRANCH="${2:-claude/sweet-brown-i99jl3}"
WORKFLOW="${GATE_WORKFLOW:-Deploy to Railway}"
SHA=$(gh pr view "$PR" --json headRefOid -q .headRefOid)
echo "PR #$PR head $SHA on $BRANCH"

# The push run can take a few seconds to appear after a push.
RUN=""
for _ in $(seq 1 30); do
  RUN=$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --event push --limit 10 \
        --json databaseId,headSha -q ".[] | select(.headSha == \"$SHA\") | .databaseId" | head -1)
  [ -n "$RUN" ] && break
  sleep 10
done
[ -n "$RUN" ] || { echo "no push-event run found for $SHA"; exit 1; }
echo "push run: $RUN (waiting)"

if ! gh run watch "$RUN" --exit-status --interval 30 >/dev/null 2>&1; then
  echo "push run $RUN is NOT green - not merging"
  gh run view "$RUN" --json conclusion,jobs -q '"conclusion=\(.conclusion)", (.jobs[] | select(.conclusion != "skipped" and .conclusion != "success") | "  \(.name): \(.conclusion)")'
  exit 1
fi
gh run view "$RUN" --json jobs -q '.jobs[] | select(.conclusion == "success") | "  \(.name): success"'

gh pr ready "$PR" >/dev/null 2>&1 || true
gh pr merge "$PR" --merge --admin
MERGE=$(gh pr view "$PR" --json mergeCommit -q .mergeCommit.oid)
echo "merged: ${MERGE:0:8}"

# Main deploys unconditionally. Report the run and, separately, what prod says:
# the job can be red for a Railway race while prod is correct, and the reverse
# has happened too, so the build hash on /health is the only proof.
MAIN=""
for _ in $(seq 1 30); do
  MAIN=$(gh run list --workflow "$WORKFLOW" --branch main --event push --limit 5 \
         --json databaseId,headSha -q ".[] | select(.headSha == \"$MERGE\") | .databaseId" | head -1)
  [ -n "$MAIN" ] && break
  sleep 10
done
[ -n "$MAIN" ] || { echo "no main run found for ${MERGE:0:8} yet; check gh run list"; exit 0; }
echo "main run: $MAIN (waiting)"
gh run watch "$MAIN" --exit-status --interval 30 >/dev/null 2>&1 && echo "main run green" || echo "main run NOT green (may be a Railway race - trust /health below)"
for _ in $(seq 1 60); do
  H=$(curl -s --max-time 8 "${TARGET_URL:-https://agent402.tools}/health" || true)
  if printf '%s' "$H" | grep -q "${MERGE:0:7}"; then echo "PROD: $H"; exit 0; fi
  sleep 10
done
echo "prod did not report ${MERGE:0:7} within 10 min; last: $H"
exit 1
