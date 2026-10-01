# ADR 0004: Answer transient GitHub verification errors with 503, not 401

## Status
Accepted (2026-10-01). Implemented in #38 (issue #37).

This ADR was written after the implementation was merged. It records a
decision that was taken in conversation before coding started, so the
reasoning stays with the repository.

## Context

Users reported that the connector "drops" and Claude asks them to reconnect,
with no visible error.

In OAuth mode, every `/mcp` request verifies the bearer token with GitHub's
`GET /user`. Before this change:

- Any non-OK answer from GitHub — 5xx, rate-limited 403/429, or a network
  error — was treated as an invalid token.
- `mcp-handler`'s `withMcpAuth` turns any error thrown by the verifier into
  `401 invalid_token`. MCP clients treat a 401 as a lost login and start the
  OAuth flow again. A momentary hiccup on GitHub's side therefore looked
  exactly like a revoked token.
- Each of those failures also counted toward the per-IP failed-verification
  window (ADR 0003). `/mcp` traffic arrives from Claude's shared egress IPs,
  so transient errors could push everyone on that IP into 429.
- Nothing was logged about why GitHub refused a token, so the cause of a
  drop could not be confirmed after the fact.

## Options considered

1. **Logging only.** Record GitHub's status and request id on every failed
   verification, change nothing else. Cheapest, and it would identify the
   cause, but users keep being logged out on every GitHub hiccup.
2. **Classify the result and answer transient errors with 503, plus
   logging.** Keep 401 for genuine rejections; answer 503 + `Retry-After`
   when GitHub cannot answer right now; count only genuine rejections toward
   the per-IP window.
3. **Cache successful verifications** (token hash → login, short TTL) and
   reuse them when GitHub is unavailable. Masks outages better, but it adds
   state and keeps accepting a token for a while after it has been revoked.

## Decision

Option 2, chosen by the maintainer on 2026-10-01, with structured audit
logging as part of the same change.

- **Classification** (`lib/github-auth.ts`), one `GET /user` per request,
  5 s timeout:
  - `ok` — 2xx with a login.
  - `rejected` — 401, or any other 4xx that is not a rate limit.
  - `transient` — 5xx; 403/429 with rate-limit evidence (`retry-after`,
    `x-ratelimit-remaining: 0`, or a body that mentions a rate limit);
    network error; timeout; a 2xx without a readable login.
- **Where it runs:** in the route handler, *before* `withMcpAuth`, because
  `withMcpAuth` cannot return anything but 401 for a verifier error. The
  result is handed to the verifier through a `WeakMap` keyed by the request,
  so the token is still checked only once.
- **Transient** → `503` with `Retry-After` taken from GitHub's own headers
  (clamped to 1–300 s, default 5 s). Not counted in the failure window.
- **Rejected** → counted in the failure window, then `withMcpAuth` answers
  401 as before.
- **Audit logging** (`lib/audit.ts`): one JSON line per auth or rate-limit
  event, never a token in clear text. See [SECURITY.md](../../SECURITY.md#audit-logging).

## Consequences

- A GitHub hiccup no longer logs users out; the client retries instead.
- A revoked token still triggers re-authentication, unchanged.
- During a long GitHub outage, `/mcp` answers 503 until GitHub recovers.
  Nothing is served from a cache, so no revoked token is ever accepted.
- The 403 rule relies on GitHub's headers and message wording. If GitHub
  changes how it signals rate limits, a rate-limited 403 could fall back to
  `rejected` (a 401) — the previous behavior, not a new failure mode.
- How a given MCP client reacts to a 503 is up to that client. The audit
  lines (`mcp.auth.transient`) show whether these cases happen in practice.

## Out of scope

- Option 3 (caching verifications).
- Logging successful tool calls.
