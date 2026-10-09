# ADR 0015: One GitHub token per user, shared by every place they connect from

## Status
Accepted (2026-10-08). Implemented in issue #73. Changes the security model
stated since ADR 0002: the server now stores one encrypted token per primary
GitHub user.

## Context

GitHub keeps at most 10 OAuth tokens per user, app and scope. Every token
created past that revokes another one, logged in the user's security log as
`oauth_access.destroy` with `explanation: max_for_app`.

Each place the connector is used — Claude on the web, the desktop app,
mobile, cloud and scheduled sessions — runs the OAuth flow on its own and
gets its own token, and this server never released any of them. A login in
one place therefore silently revoked a token another place was still using;
that session only found out the next time it was used.

Confirmed in production on 2026-10-08. A session dropped at 22:47 with
GitHub answering 401 to its token (the client sent the token and tried to
refresh, so the lifetime from ADR 0014 was working). The maintainer's
security log for that day shows each login revoking a previous token with
`max_for_app`: 09:35 revoked the 00:51 token, 09:45 revoked 09:35's, 11:23
revoked 09:45's. Between 2026-09-18 and 2026-10-08 the same account had 37
such revocations.

## Options considered

1. **One token per user, reused across logins.** Store the user's token;
   on each new login, hand out the stored token and revoke the one GitHub
   just created. The user stays at a single live token, so the limit is
   never reached.
2. **Change nothing.** With ADR 0014 nobody needs to log in again because of
   expiry, so logins become rarer — but anyone using Claude in more than a
   few places, or with scheduled sessions, still reaches the limit.
3. **Revoke the previous token on each login.** Keeps the count low, but
   kills the session the same person has open elsewhere — the very problem
   being fixed.

## Decision

Option 1, chosen by the maintainer on 2026-10-08, accepting that the server
now stores the primary account's token.

On each login (`/callback`, after exchanging the code with GitHub), in
`lib/primary-token.ts`:

| Situation | Token handed out | Stored token | Token just created |
|---|---|---|---|
| No stored token | new | new one stored | kept |
| Stored token valid, same GitHub user, scopes cover the request | **stored** | unchanged | **revoked** |
| Stored token rejected by GitHub (401) | new | replaced by new | kept |
| Stored token lacks a requested scope | new | replaced by new | kept (old one is left alone: other sessions may use it) |
| Stored token belongs to another user id | new | replaced by new | kept |
| GitHub cannot answer, or the database is unavailable | new | unchanged | kept |
| User could not be identified | new | — | kept |

- **Keyed by GitHub's numeric user id**, never by login (logins can be
  renamed). A token is only ever handed back to the same GitHub user, so a
  shared instance used by many people and companies never mixes them up.
- **Encrypted** with AES-256-GCM using `OAUTH_ENCRYPTION_KEY`, like linked
  accounts' tokens (ADR 0002). Collection `primary_tokens` in MongoDB.
- **Fail-open.** Any uncertainty falls back to the new token without storing
  or revoking anything; a login never fails because of this.
- **Audit:** `oauth.token.reused` (with the revocation outcome) and
  `oauth.token.stored` (with the reason) — never a token.
- Without `MONGODB_URI` (e.g. a minimal self-hosted instance), the server
  behaves as before: a new token per login.

## Consequences

- Each user holds one live token from this app no matter how many places
  they connect from; GitHub's limit stops revoking live sessions.
- **Security model change.** A database leak together with
  `OAUTH_ENCRYPTION_KEY` would expose these tokens. That was already true for
  linked accounts; it now covers primary accounts too. Revoking the app on
  GitHub (Settings → Applications) still invalidates everything at once.
- All of a user's sessions share one token, so the per-token `/mcp` rate
  limit (ADR 0003) is now shared across that user's sessions. GitHub's own
  API limits are per user anyway.
- Tokens created before this change stay alive until they are used up or
  revoked by GitHub; the first login after deploy stores the user's token.
- Adding a scope later (for example `workflow`) is handled: the stored token
  lacks it, so the new token replaces it.

## Out of scope

- Linked accounts (`link_account`) keep one token per link, as before.
