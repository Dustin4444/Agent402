#!/usr/bin/env bash
# Merge a PR from the dev branch only after the PUSH-event run of its head SHA
# has every test lane green, then report what main deployed.
#
# Why this exists: with a PR open, every push spawns TWO deploy.yml runs (push
# and pull_request). "The first run matching the SHA" is usually the PR run,
# which finishes earlier and never deploys. Merging on it (2026-08-25) meant
# the tree-gate on main - which only trusts push-event runs - had no green run
# to match and re-ran the whole suite; on 2026-08-22 the same mistake cancelled
# a deploy outright. The push run is the only one that counts, so this script
# refuses to consider any other.
#
# Three things the 2026-08-25 review added, each a way "green" could have been
# hollow: the merge is pinned to the SHA that was tested (a push between the
# check and the merge would otherwise land untested, and --admin bypasses branch
# protection); "green" means every test* LANE concluded success, not the run -
# a marker-less commit skips every lane and the run still concludes success;
# and every SHA is shape-checked before it is used, so an API hiccup cannot
# turn into a merge of "null".
#
#   scripts/merge-on-green.sh <pr-number> [branch]
#
# Needs gh (authenticated). Exits non-zero, merging nothing, on any doubt.
set -euo pipefail
PR="${1:?pr number}"
BRANCH="${2:-claude/sweet-brown-i99jl3}"
WORKFLOW="${GATE_WORKFLOW:-Deploy to Railway}"
is_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }

SHA=$(gh pr view "$PR" --json headRefOid -q .headRefOid || true)
is_sha "$SHA" || { echo "could not read a head SHA for PR #$PR (got '${SHA}')"; exit 1; }
echo "PR #$PR head $SHA on $BRANCH"

# The push run can take a few seconds to appear after a push.
RUN=""
for _ in $(seq 1 30); do
  RUN=$(gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --event push --commit "$SHA" --limit 5 \
        --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$RUN" ] && break
  sleep 10
done
[[ "$RUN" =~ ^[0-9]+$ ]] || { echo "no push-event run found for $SHA"; exit 1; }
echo "push run: $RUN (waiting)"

gh run watch "$RUN" --interval 30 >/dev/null 2>&1 || true
# Every test lane must have run AND passed. A skipped lane is not a passed lane.
LANES=$(gh run view "$RUN" --json jobs -q '.jobs[] | select(.name | test("^test(-|$)")) | "\(.name)=\(.conclusion)"' || true)
[ -n "$LANES" ] || { echo "push run $RUN has no test lanes - not merging"; exit 1; }
echo "$LANES" | sed 's/^/  /'
if echo "$LANES" | grep -vq '=success$'; then
  echo "push run $RUN is NOT green on every test lane - not merging"
  exit 1
fi

gh pr ready "$PR" >/dev/null 2>&1 || true
# Pinned to the tested SHA: if the branch moved since, gh refuses and we stop.
gh pr merge "$PR" --merge --admin --match-head-commit "$SHA"
MERGE=$(gh pr view "$PR" --json mergeCommit -q '.mergeCommit.oid // empty' || true)
is_sha "$MERGE" || { echo "merged, but could not read the merge commit (got '${MERGE}'); check gh pr view $PR"; exit 1; }
echo "merged: ${MERGE:0:8}"

# Main deploys unconditionally. Report the run and, separately, what prod says:
# the job can be red for a Railway race while prod is correct, and the reverse
# has happened too, so the build hash on /health is the only proof.
MAIN=""
for _ in $(seq 1 30); do
  MAIN=$(gh run list --workflow "$WORKFLOW" --branch main --event push --commit "$MERGE" --limit 5 \
         --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || true)
  [ -n "$MAIN" ] && break
  sleep 10
done
[[ "$MAIN" =~ ^[0-9]+$ ]] || { echo "no main run found for ${MERGE:0:8} yet; check gh run list"; exit 0; }
echo "main run: $MAIN (waiting)"
gh run watch "$MAIN" --exit-status --interval 30 >/dev/null 2>&1 && echo "main run green" || echo "main run NOT green (may be a Railway race - trust /health below)"
H=""
for _ in $(seq 1 60); do
  H=$(curl -s --max-time 8 "${TARGET_URL:-https://agent402.tools}/health" || true)
  if printf '%s' "$H" | grep -q "\"build\":\"${MERGE:0:7}\""; then echo "PROD: $H"; exit 0; fi
  sleep 10
done
echo "prod did not report ${MERGE:0:7} within 10 min; last: $H"
exit 1
