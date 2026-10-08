# ADR 0014: Access token lifetime goes from 8 hours to 30 days

## Status
Accepted (2026-10-08). Implemented in issue #71. Amends the lifetime chosen
in [ADR 0011](./0011-stateless-refresh-tokens.md); the rest of ADR 0011
(stateless refresh tokens, revocation checks) is unchanged.

## Context

ADR 0011 gave every access token an 8-hour `expires_in` and a refresh token.
Production then showed two different behaviours:

- **Connector in use.** Claude refreshed on its own shortly before expiry
  (`oauth.token.refreshed` 7h55 after login, 2026-10-02).
- **Connector idle.** The lifetime ran out overnight. The next call
  (2026-10-03) reached `/mcp` without any token, and no
  `grant_type=refresh_token` request came before it: the client did not use
  its refresh token for a token that had already expired, and asked the user
  to authenticate again.

That is one data point, from a scheduled session rather than the Claude app,
but it matches the original report — the connector shows as expired after a
few hours without use.

Meanwhile the short lifetime protects nothing. `/mcp` verifies the GitHub
token with GitHub on every request (ADR 0004), so a revoked authorization is
refused on the next call whatever `expires_in` says. Its only effect was
dropping idle sessions.

## Options considered

1. **7 days.** Covers daily use; a week without using the connector still
   drops the session.
2. **30 days.** Covers weekends, holidays and normal gaps; a user idle for
   more than a month reconnects once.
3. **90 days.** Effectively never expires from inactivity.
4. **No `expires_in`.** Rejected: it brings back the original problem
   (ADR 0011), where clients apply their own lifetime with no way to renew.

## Decision

Option 2, chosen by the maintainer on 2026-10-08: `expires_in` = 30 days
(2 592 000 seconds), for both `authorization_code` and `refresh_token`
responses. Refresh tokens are unchanged.

## Consequences

- Sessions survive idle periods up to 30 days; refreshes become rare.
- Revocation is unaffected: it is enforced on every `/mcp` call, and every
  refresh still re-checks the token with GitHub.
- Users connected before this change keep their old 8-hour lifetime until
  their next refresh or login, then move to 30 days.
- If an MCP client does use refresh tokens after expiry, nothing changes for
  it except that it refreshes less often.

## Out of scope

- The GitHub limit of 10 tokens per user, app and scope (tracked
  separately).
