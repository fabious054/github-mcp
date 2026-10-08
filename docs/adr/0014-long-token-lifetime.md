# ADR 0014: Announce a 10-year access token lifetime so idle sessions never drop

## Status
Accepted (2026-10-08). Implemented in issue #71. Amends the lifetime chosen
in [ADR 0011](./0011-stateless-refresh-tokens.md); the rest of ADR 0011
(stateless refresh tokens, revocation checks) is unchanged.

## Context

ADR 0011 gave every access token an 8-hour `expires_in` and a refresh token.
Production then showed two different behaviours:

- **Connector in use.** Claude refreshed on its own a few minutes before
  expiry (`oauth.token.refreshed` 7h55 after login, 2026-10-02).
- **Connector idle.** The lifetime ran out overnight. The next call
  (2026-10-03) reached `/mcp` without any token, and no
  `grant_type=refresh_token` request came before it: the client did not use
  its refresh token for a token that had already expired, and asked the user
  to authenticate again.

That is one data point, from a scheduled session rather than the Claude app,
but it matches the original report — the connector shows as expired after a
few hours without use.

Two facts shape the decision:

- **The expiry lives in the client.** The GitHub token itself never expires,
  and this server does not store users' tokens. What expires is the client's
  own idea of the token's lifetime, set from `expires_in`. The server cannot
  push a new token or make the client refresh early: OAuth lets the client
  ask, never the server. A server-side scheduled job (e.g. a daily cron)
  therefore cannot keep a session alive, and would require storing every
  user's token, which this design avoids on purpose.
- **The lifetime protects nothing.** `/mcp` verifies the GitHub token with
  GitHub on every request (ADR 0004), so a revoked authorization is refused
  on the next call whatever `expires_in` says.

Any finite lifetime therefore drops an active user's session whenever the
expiry moment happens to fall during a pause (a night, a weekend), since the
client only refreshes in the last minutes before expiry.

## Options considered

1. **30 days.** An active user would still likely reconnect about once a
   month, when the expiry falls in a pause.
2. **1 year.** Reconnect about once a year.
3. **10 years.** Effectively never expires from inactivity.
4. **A server-side cron that renews tokens.** Not possible — the server
   cannot deliver tokens to the client — and it would require storing every
   user's token.
5. **No `expires_in`.** Rejected: it brings back the original problem
   (ADR 0011), where clients apply their own short lifetime.

## Decision

Option 3, following the maintainer's requirement on 2026-10-08 that an
active user's session must not drop: `expires_in` = 10 years
(315 360 000 seconds), for both `authorization_code` and `refresh_token`
responses. Refresh tokens stay unchanged, as a fallback for clients that use
them.

## Consequences

- Sessions no longer drop because of the announced lifetime, however long
  the connector sits idle.
- Revocation is unaffected: it is enforced on every `/mcp` call, and every
  refresh still re-checks the token with GitHub.
- Users connected before this change keep their old 8-hour lifetime until
  their next login, then move to the new one.
- Other causes of reconnection remain and are tracked separately: GitHub's
  limit of 10 tokens per user, app and scope, and revocations on GitHub.
