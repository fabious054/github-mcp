# ADR 0007: Never pick an account while a linked account's authorization is revoked

## Status
Accepted (2026-10-01). Implemented in issue #51.

## Context

A linked account's GitHub token (ADR 0002) can stop being valid without the
server noticing: the person revokes it in GitHub's settings, or GitHub revokes
the oldest token once a user has more than 10 for the same OAuth App and
scope.

On 2026-10-01 this happened to the linked account `fabiorobozz`. During
account auto-detection, `resolveRepo` treated *any* error from
`GET /repos/{owner}/{repo}` as "this account has no access". A 401 (revoked
token) therefore looked exactly like "no access": every repository only that
account could reach failed with a generic error, nothing said why, and nothing
was logged. A 5xx from GitHub for one account was treated the same way.

With the selection rules of ADR 0006 this is worse than an unclear error: an
account that silently drops out of the candidates can change which account is
picked. In the case above, `fabiorobozz` dropped out and the primary account,
which can only *read* a public `robozz-br` repository, would have been picked
by the read-only fallback.

## Options considered

For a revoked account during auto-detection:

1. **Stop and ask, always.** If any candidate's token is revoked, do not pick.
   The caller re-links the account or names the account explicitly.
2. **Stop only when the revoked account could have changed the outcome**
   (e.g. when the pick relied on the read-only fallback); otherwise continue
   with the working accounts.
3. **Continue with the working accounts and only log it.**

## Decision

Option 1, chosen by the maintainer on 2026-10-01: the server never decides
which account to use on incomplete information.

- **Revoked token (401) on any candidate during auto-detection** → the call
  stops with: the account is linked but GitHub no longer accepts its
  authorization; run `link_account` again, or repeat the call with `account`.
- **GitHub unavailable for a candidate** (5xx, 429, rate-limited 403, network
  error) → the call stops with "try again in a few seconds" instead of
  treating the account as having no access (same reasoning as ADR 0004).
  A revoked account takes precedence in the message, since it needs action.
- **An explicit `account`** still bypasses auto-detection.
- **The revoked token stays stored** until the account is re-linked;
  `link_account` already replaces it. Deleting it automatically would make the
  account disappear from `list_accounts` without explanation.
- **Audit line** `oauth.link.token_revoked` with the primary login, the
  linked login, the token fingerprint and where it was detected
  (`resolveRepo`, `list_accounts`, `list_repos_by_account`) — never the token.
- **`list_accounts` shows each linked account's status**: authorization ok,
  revoked (re-link needed), or could not be checked right now. This costs one
  `GET /user` per linked account, only when that tool is called.
- **`list_repos_by_account`** on a revoked account returns the same message
  instead of GitHub's "Bad credentials".

## Consequences

- A revoked linked account is visible the moment it matters, with the fix in
  the message, instead of looking like a missing permission.
- While a linked account stays revoked, every call that relies on
  auto-detection stops, including calls on repositories that account never
  had anything to do with. That is the intended trade-off: re-linking (or
  passing `account`) is a one-time action, and a wrong silent pick is not.
- The audit line makes the cause of the next revocation traceable in time
  (for example, whether it lines up with a new login that pushed the token
  count past GitHub's limit).
- A primary token that GitHub rejects never reaches this code: it is
  answered with 401 before any tool runs (ADR 0004).
