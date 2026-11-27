# ADR 0023: `workflow` in the default OAuth scope, for files under .github/workflows/

## Status
Accepted (2026-11-27). Implemented in issue #131 (backlog card "OAuth scope missing `workflow`", 2026-09-30).

## Context

GitHub refuses to create or change any file under `.github/workflows/`
unless the token carries the `workflow` scope, even when the account can
write to the repository. The connector asked for `repo admin:org project`
(ADR 0019, ADR 0022), so `commit_file`, `patch_file`, `commit_tree` and
`update_ref` failed on workflow files with a raw error (`404 Not Found` from
the contents API, or "refusing to allow an OAuth App to create or update
workflow … without `workflow` scope" on a ref update). Every CI or deploy
change had to be committed by hand.

Options considered:

1. **Request it for everyone** — the same model as `project` and `admin:org`.
2. **Don't request it** — keep the limit, answer with a clear message.

## Decision (maintainer, 2026-11-27)

**Option 1.** The default scope becomes `repo admin:org project workflow`
(`lib/scopes.ts`).

## Consequences

- **Rollout:** every user reconnects once; token reuse (ADR 0015) keeps the
  new token because the stored one doesn't cover `workflow`
  (`scopes-changed`). Linked accounts need `link_account` again.
- **Until then**, a commit that touches a workflow file answers with a
  reconnect message instead of GitHub's raw error, and nothing is committed
  (`lib/workflow-scope.ts`). Other files keep committing normally.
- **Risk:** `workflow` lets a token change GitHub Actions workflows, which
  run with the repository's secrets. It applies only to repositories the user
  can already write to, and GitHub still checks the user's role; the token
  protections in SECURITY.md apply unchanged.
- **Self-hosted** deployments can leave `workflow` out of
  `GITHUB_OAUTH_SCOPES`; workflow commits then return the reconnect message.
