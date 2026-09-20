# Repository strategy

**Recommendation: GO PRIVATE, and do it before merging the audit documents.**

## Trigger findings
- **F-14** - the first pass committed a self-authored catalogue of the company's legal weak
  points to a public repo, naming a credential still in history and recording that a named
  third party's terms were knowingly exceeded. Publishing that waives any argument the issues
  were unknown. The remaining audit documents in this pass are worse, because they are more
  complete.
- **F-13** - `route-execute` pays third parties from Havok hot wallets, and the repository
  publishes the exact spend caps, gate thresholds, proven-seller floors, refusal windows and
  fallback logic that bound it. That is a free map for anyone probing the money path.
- **F-05** - a credential remains in public history; `.remember` is still reachable.
- **F-13/F-02** are open legal questions. A public repo is a standing invitation to answer them
  adversarially before the owner can.

## Why not the alternatives
- **Keep public as-is** - fails on F-14 and F-05 alone.
- **History purge + stay public** - rewrites ~90% of commits, breaks the two SHAs pinned in
  `.gitleaks.toml` and eight cited in `CLAUDE.md`, requires lifting branch protection, and
  **does not un-publish anything**: the objects stay addressable by SHA and the repo has 20
  forks. Verified this session - a commit made unreachable an hour earlier still resolved
  through the GitHub API. Worth doing eventually as hygiene, not as a remedy.
- **Full rewrite** - disproportionate. History is clean apart from one disclosed credential.
- **Split repos** - the right long-term shape (public SDKs, private server), but it is a
  multi-day refactor and does nothing about the documents that are public *today*.

## Steps
1. Do **not** merge `legal-risk-remediation` or `final-liability-remediation` while public.
2. GitHub → Settings → Danger Zone → **Change visibility → Private**.
3. Rotate the credential in `SECRETS_TO_ROTATE.md` regardless of visibility.
4. Merge the remediation branches once private.
5. Decide later whether the MIT SDK packages move to their own public repo. They are already
   published to npm, so nothing breaks for users in the meantime.

## What going private does NOT fix
- It does not un-publish anything already public. **20 forks keep full history**, and forks of a
  public repo are not removed when the parent goes private.
- It does not rotate the credential.
- It does not resolve F-13 or F-02; those are product decisions.
- The live site keeps whatever exposure it had - going private changes the repo, not the server.

## Cost, honestly
The AGPL server being public is a real signal for a protocol project, and giving it up has a
cost in credibility and contribution. That cost is worth paying while an unresolved money
question and a public self-audit are both sitting in the same repository. It is reversible.
