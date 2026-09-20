# Credentials exposed in public git history

A public repository must be treated as permanently public. Removing a value from the working
tree does not withdraw it: the object stays addressable by SHA, and this repository has forks.
**Assume every credential below is compromised and rotate it, whatever the history shows.**

Names and locations only. Never paste a value into this file.

| ID | Credential | Where | Status | Action |
|----|-----------|-------|--------|--------|
| F-05 | Stellar facilitator bearer token | `.remember/` scratch directory, commit `70fcc5171d8b1d4d8170933db665974f1ce91bbf` | Reported rotated (dead). Tracked in `.gitleaks.toml` as incident R-01 | **Confirm** revocation with the issuer, then purge history (below) |

## Confirming revocation

Rotation is not the same as revocation. Ask the issuer to confirm the old token no longer
authenticates, rather than confirming a new one was minted.

## Purging it from history

Only after the value is confirmed dead, because a purge rewrites SHAs and cannot be undone.

```sh
# git-filter-repo is the maintained tool; BFG also works.
pip install git-filter-repo
git clone --mirror git@github.com:MikeyPetrillo/Agent402.git a402-purge && cd a402-purge
git filter-repo --path .remember/ --invert-paths
git push --force --all && git push --force --tags
```

**Read this before running it.** The purge has costs this repository has already measured:

- It rewrites roughly 90% of commits, so every SHA reference breaks - including the two commit
  SHAs pinned in `.gitleaks.toml` and the eight cited in `CLAUDE.md`. The allowlist must be
  updated in the same change or secret-scan starts failing.
- `main` is protected against force-push; the ruleset has to be lifted and restored.
- It does not un-publish anything. The old objects remain retrievable by SHA and live on in
  every fork and clone. **Rotation is the control; the purge is hygiene.**

## Ongoing controls already in place

- `secret-scan.yml` runs gitleaks over full history and the working tree on every push.
- `.gitleaks.toml` allowlists each intentional fake by exact literal, never by path, so a real
  secret in a test fixture still fails.
- `.remember/` is gitignored, so no new content can land there.
