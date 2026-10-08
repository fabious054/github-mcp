# ADR 0011: Stateless refresh tokens so Claude renews the token silently

## Status
Accepted (2026-10-02). Implemented for issue #63.
Amended (2026-10-08): the access token lifetime is now 30 days — see
[ADR 0014](./0014-token-lifetime-30-days.md). Everything else here still
applies.

## Context

After a few hours idle, Claude showed the connector as "connection expired"
and asked the user to reconnect.

Production logs on 2026-10-02 showed three `POST /mcp` → 401 with **no**
`mcp.auth.rejected` audit event. That event is written whenever GitHub
rejects a bearer token (ADR 0004), so these requests carried no token at
all: the client had already dropped it on its own. GitHub never rejected
anything.

`/token` answered with `access_token`, `token_type` and `scope` only — no
`expires_in`, no `refresh_token` — and accepted only
`grant_type=authorization_code`. The access token is the user's GitHub OAuth
App token, which GitHub never expires, but the client had no way to know
that. It applied its own lifetime and, with nothing to refresh with, could
only send the user through the full OAuth flow again.

The client's internal default lifetime is not documented, so the root cause
is a strong hypothesis backed by the logs, not a confirmed fact. Live
validation is part of the issue.

## Options considered

1. **Stateless refresh tokens.** Return `expires_in` and a `refresh_token`,
   and accept `grant_type=refresh_token`. The refresh token is an encrypted
   blob, like every other OAuth artifact here, so no database is needed.
2. **Only add a long `expires_in`.** Smallest change, but without a refresh
   token the client still has to send the user through a new login when the
   lifetime runs out — the drop becomes rarer, not gone.

## Decision

Option 1, chosen by the maintainer on 2026-10-02, with these parameters
(also chosen by the maintainer):

- **Access token lifetime: 8 hours** (`expires_in: 28800`). The token
  itself is unchanged — it is still the GitHub token, so `/mcp`
  verification and its rate limit work exactly as before. The lifetime only
  sets how often the client comes back to `/token`.
- **Refresh token: never expires on its own.** It stops working only when
  GitHub stops accepting the token inside it, which is checked against
  `GET /user` on every refresh. This matches the product goal of "connect
  once and keep using it".

Details:

- The refresh token is AES-256-GCM-encrypted JSON (`lib/oauth.ts`) holding
  the GitHub token, scope, login, the MCP `client_id` and `typ: "refresh"`.
  The `typ` marker keeps it from being accepted where another blob
  encrypted with the same key (client_id, state, authorization code) is
  expected, and vice versa.
- Refresh outcomes (`app/token/route.ts`):
  - invalid, tampered or foreign blob, or `client_id` mismatch →
    `400 invalid_grant`;
  - GitHub rejects the token (revoked) → `400 invalid_grant`, so the client
    starts a new login;
  - GitHub cannot answer right now → `503 temporarily_unavailable` with
    `Retry-After`, never `invalid_grant`, so the client keeps its refresh
    token and retries (same rule as ADR 0004);
  - otherwise → the same access token, a fresh `expires_in` and a new
    refresh token.
- Every refresh returns a new refresh token (new IV). Because nothing is
  stored, older refresh tokens are not invalidated — see Consequences.
- **Rate limit:** refreshes are sent by the client's backend, whose IPs are
  shared by all its users, so a valid refresh is limited per identity (hash
  of the GitHub token, 30 per 5 minutes) instead of per IP. An invalid
  refresh token still counts against the per-IP `/token` limit (ADR 0003).
- Audit events: `oauth.token.refreshed`, `oauth.token.refresh_rejected`,
  `oauth.token.refresh_transient` — never a token, never a refresh token.
- The authorization-server metadata and `/register` now advertise
  `refresh_token` among the grant types.

## Consequences

- The client renews silently every 8 hours; a user only logs in again after
  revoking the authorization on GitHub.
- A revoked authorization is noticed at the next refresh (at most 8 hours),
  and immediately at the next tool call, since `/mcp` still checks every
  request against GitHub.
- A leaked refresh token is as sensitive as the GitHub token it contains.
  This is not a new exposure — the access token already *is* that GitHub
  token — but the refresh token lives as long as the authorization does.
- No refresh-token rotation with reuse detection: that needs storage, which
  this design avoids. Revoking the authorization on GitHub invalidates
  every refresh token at once.
- Rotating `OAUTH_ENCRYPTION_KEY` invalidates all refresh tokens, so every
  user logs in once more.
- Users connected before this change still hold a token without a refresh
  token; they reconnect once and are then on the new flow.

## Out of scope

- Storing refresh tokens to support rotation with reuse detection.
- Changing the OAuth scope or moving to a GitHub App (decided against on
  2026-09-23).
