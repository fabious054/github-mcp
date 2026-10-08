# ADR 0013: `unlink_account` removes only the caller's own link and revokes its token

## Status
Accepted (2026-10-08). Implemented in issue #69.

## Context

`link_account` adds accounts to a session, but nothing removed them. When a
user stopped using a linked account and its authorization was revoked,
ADR 0007 correctly stopped every call that relied on automatic account
detection — and the only way around it was to pass `account` on every call,
forever. This happened in production on 2026-10-08.

This instance is shared: many people, from different companies, connect to
the same server, and the same GitHub account can be linked by more than one
of them. Removing a link must never affect anyone else.

## Options considered

1. **Remove the link from the database only.** The stored token stays valid
   on GitHub until someone revokes it by hand, and it keeps occupying one of
   GitHub's 10 tokens per user, app and scope.
2. **Remove the link and revoke that token on GitHub**
   (`DELETE /applications/{client_id}/token`). Only that one token is
   revoked: the user's authorization of the app and their other tokens —
   including other people's links of the same account — stay valid.

## Decision

Option 2, chosen by the maintainer on 2026-10-08.

- **Scope.** A link is the pair `{primaryLogin, login}`. The primary login
  comes from the verified token of the request, never from a tool argument,
  so a caller can only remove links of their own primary account.
- **The primary account cannot be unlinked.** Disconnecting the connector in
  Claude is the way to stop using it.
- **Order.** The link is deleted first, then the token is revoked.
  Revocation is best-effort and never blocks the unlink: GitHub answering
  404 means the token was already invalid; any other failure is reported,
  with how to revoke it by hand.
- **Audit.** `oauth.link.removed` with the primary login, the linked login
  and the revocation outcome — never a token.
- **Legacy mode** has no links (accounts are fixed in `GITHUB_ACCOUNTS`), so
  the tool refuses and says where to change them.

The logic lives in `lib/account-unlink.ts` with its storage, revocation and
audit dependencies injected, so it can be checked without a database.

## Consequences

- A user who stops using an account can remove it and get automatic account
  detection back.
- Unlinking frees a slot of GitHub's 10-token limit for that account.
- `list_accounts` now points to `unlink_account` next to `link_account` when
  a linked account's authorization is revoked.

## Out of scope

- Unlinking every account at once, or disconnecting the primary account.
- Automatic cleanup of revoked links (ADR 0007 keeps that decision with the
  user).
