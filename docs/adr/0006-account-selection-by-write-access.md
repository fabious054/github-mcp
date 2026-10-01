# ADR 0006: Pick the linked account by write access, not just visibility

## Status
Accepted (2026-10-01). Implemented in issue #47.

## Context

When more than one GitHub account is linked to a session (ADR 0002) and a
tool call does not pass `account`, the server picks the account itself. Until
now it asked GitHub, for each candidate, whether `GET /repos/{owner}/{repo}`
succeeded, and:

- one account with access → used it;
- none → "no access" error;
- several → error asking the caller to repeat the call with `account`.

Any authenticated account can read a **public** repository, so every public
repository looked ambiguous as soon as two working accounts were linked. Found
live on 2026-10-01 on `fabious054/github-mcp`: only `fabious054` can write to
it, yet every call without `account` failed. It had gone unnoticed because the
second account's token had been revoked, so only one account ever answered.

`GET /repos/{owner}/{repo}` already returns a `permissions` object
(`admin`, `maintain`, `push`, `triage`, `pull`) for the authenticated account,
so the server can tell "can write" from "can only read" with no extra call.

## Options considered

1. **Keep asking whenever several accounts can see the repository.** Safest
   in the sense that the server never guesses, but it asks on every public
   repository, including the obvious cases where only one account can change
   anything.
2. **Prefer the primary account on any tie.** Simple, but it picks the
   primary even when only a linked account can write, so writes would fail.
3. **Decide by write access, and fall back to the primary only for
   read-only repositories.** Ask only when two or more accounts could
   actually change the repository.

## Decision

Option 3, chosen by the maintainer on 2026-10-01 (`lib/account-pick.ts`):

1. Exactly one account can write (`push`, `maintain` or `admin`) → use it.
2. More than one can write → ask for `account`, as before.
3. None can write:
   - exactly one can read → use it;
   - several can read → the primary account if it is among them, otherwise
     ask.
4. None can read → "no access" error, as before.

The ambiguity error lists each option with its access level
(`login: write` / `login: read`), so the caller can choose without calling
`list_accounts`.

An explicit `account` still overrides everything, and a session with a single
account still makes no extra call.

## Consequences

- Public repositories resolve without `account` whenever only one linked
  account can write to them.
- The question is still asked in the one case where a wrong guess would
  matter: two or more accounts that can change the same repository.
- For read-only repositories the request goes out as the primary account.
  Reading a public repository gives the same result with any account; only
  the GitHub API rate limit it counts against changes.
- `permissions` reflects the account's role on the repository, not what the
  OAuth token's scopes allow. With the default `repo` scope the two match.
  If a self-hosted instance requests narrower scopes, an account could be
  picked as a writer and still have a write rejected by GitHub; the error
  then comes from GitHub, and passing `account` remains the way out.
