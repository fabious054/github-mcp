# ADR 0022: `admin:org` in the default OAuth scope, for issue types

## Status
Accepted (2026-11-27). Implemented in issue #123, after the live run of issue #121 (phase 3b).

## Context

Phase 3b (issue #121, ADR 0021) added tools to create, change and delete an
organization's issue types. The live run showed that GitHub refuses those
mutations unless the token has `admin:org`: the connector asked for
`repo read:org project` (ADR 0019), so `createIssueType` failed for an
organization owner with a raw scope error. Reading issue types works with
`read:org`.

`admin:org` is GitHub's broadest organization scope: it allows managing the
organization, its members, teams, webhooks and settings, everywhere the user
is an owner. It does not give the user any power they don't already have —
GitHub still checks the user's own role — but the token can then do anything
the user can do as an owner.

Options considered:

1. **Don't request it.** List issue types; refuse changes with a clear message.
2. **Request it only on demand.** An opt-in flow for users who want to manage
   issue types, keeping the default scope unchanged.
3. **Request it for everyone.** Add it to the default scope.

## Decision (maintainer, 2026-11-27)

**Option 3: `admin:org` is part of the default scope for everyone.** The
default moves from `repo read:org project` to `repo admin:org project`
(`lib/scopes.ts`). `read:org` is dropped from the list because `admin:org`
includes it (`coversScopes` already treats it that way).

## Consequences

- **Rollout.** Every user reconnects once and sees GitHub's consent screen
  ask for full control of organizations. Token reuse (ADR 0015) handles the
  switch: a stored token without `admin:org` doesn't cover the request
  (`scopes-changed`), so the new token is kept and stored. Accounts linked
  with `link_account` need `link_account` again.
- **Until then**, issue type writes answer with a reconnect message instead of
  GitHub's raw error; every other tool keeps working.
- **Risk.** A leaked session token now carries owner-level power over every
  organization its user owns, not just repository access. The existing
  protections still apply: tokens are stored encrypted (OAUTH_ENCRYPTION_KEY),
  one token per user (ADR 0015), rate limiting, and the audit log. Nothing in
  the connector uses `admin:org` beyond the issue type tools; any new tool
  that would use more of it needs its own decision.
- **Organizations with OAuth App access restrictions** must approve the app
  as before; the scope doesn't bypass that.
- **Self-hosted deployments** can keep a narrower scope with
  `GITHUB_OAUTH_SCOPES` (e.g. `repo read:org project`); the issue type
  write tools then return the reconnect message, the rest works.
