# ADR 0003: Redis-backed rate limiting

## Status
Accepted (2026-09-30). Implemented in #23, #24 and #25 (issue #21).

## Context

The connector is publicly open and frequently shared. No endpoint has any
rate limiting today. Exposed without limit: `/register`, `/token`,
`/authorize`, `/link-account`, `/link-callback`, `/callback` and `/mcp`.
Every call costs a serverless invocation, and `/link-account` and
`/link-callback` also write to MongoDB.

Two facts shape the design:

- `/mcp` calls originate from Claude's backend, not from the end user's IP,
  so per-IP limiting does not identify individual users there. Per-identity
  limiting fits `/mcp`; per-IP limiting fits the public OAuth endpoints,
  where no identity exists yet.
- Allowlisting Claude's own IP range is not an option: that traffic is
  shared by all Claude users, cannot tell abuse from legitimate use, and
  does not cover the endpoints the user's browser hits directly during the
  OAuth flow.

Each serverless invocation runs in isolation, so counters need a store shared
across invocations.

## Options considered

1. **MongoDB** (already in the project for linked accounts), using
   `findOneAndUpdate` with `$inc` and a TTL index. Works at the planned
   volumes, but adds a disk write to every request and puts abuse traffic on
   the same database that stores linked OAuth accounts: a burst of abuse
   could degrade login for everyone.
2. **Vercel Firewall rate-limit rules.** No code or new store, but
   availability of custom rate-limit rules on the current plan could not be
   confirmed, and it cannot key on identity for `/mcp`.
3. **Redis** (dedicated store from the Vercel Redis integration). In-memory
   atomic counters with expiry, isolated from the accounts database.
   Chosen.

## Decision

Use Redis, connected through `REDIS_URL` (Preview and Production). Apply
rate limiting to all routes, with these limits:

| Endpoint | Limit | Keyed by |
|---|---|---|
| `/register`, `/token`, `/authorize` | 20 requests / 5 min | client IP |
| `/link-account`, `/link-callback`, `/callback` | 30 requests / 5 min | client IP |
| `/mcp`, OAuth mode | 60 requests / min, token bucket (bursts up to 60) | hash of the bearer token |
| `/mcp`, legacy fixed-account mode | same bucket | client IP |
| `/mcp`, failed token verifications | 20 failures / 5 min | client IP |

Rejections return `429` with a `Retry-After` header. Each OAuth route has
its own counter.

**Fail-open:** if Redis is unreachable, errors, or exceeds a timeout, the
request is allowed and the error is logged. A Redis outage must not block
login or tool calls. With `REDIS_URL` unset (local development), the limiter
is a no-op.

### Decisions made during implementation

The points left open when this ADR was accepted were settled in issue #21:

- **Identity key for `/mcp`:** a SHA-256 hash of the bearer token, checked
  *before* `verifyGithubToken`. The GitHub login is only known after that
  verification, which already costs one `GET /user` per request; limiting
  first means requests over the limit never reach GitHub. Hashing keeps the
  token itself out of Redis. To stop floods of *invalid* tokens (each of
  which would otherwise cost a `GET /user` and get a fresh key), failed
  verifications are counted in a separate per-IP window, checked without
  incrementing before anything else and incremented only when GitHub rejects
  a token.
- **Atomicity:** a single Lua script (`EVAL`) handles the fixed window, the
  token bucket and the read-only check of the failure window. Redis runs it
  atomically, and it takes the time from Redis `TIME` so different instances
  never disagree about "now". `INCR` + `EXPIRE` was rejected because the two
  steps are not atomic: a crash between them leaves a counter without expiry.
- **Client IP:** the first value of `x-forwarded-for`. Vercel overwrites that
  header with the real client address, so it cannot be spoofed by the caller
  (https://vercel.com/docs/headers/request-headers).
- **Timeouts:** opening the Redis connection on a cold start takes longer
  than a command, and with a single 300 ms timeout the first request of every
  cold instance failed open. Connecting now waits up to 1 s; each command
  still times out after 300 ms. Only the first request of an instance pays
  the connection wait.

## Consequences

- A second stateful dependency (`REDIS_URL`) joins `MONGODB_URI` on Vercel;
  it is documented in `.env.example`, the README and `docs/self-hosting.md`.
- The Redis provider must support `EVAL`.
- Fail-open means a Redis outage temporarily removes protection. This is an
  accepted trade-off for a public connector where availability of legitimate
  use matters more than strict enforcement. The limiter reduces exposure; it
  is not a substitute for a WAF.
- `/mcp` in OAuth mode makes two Redis round trips per request (failure-window
  check, then the bucket).
- Limits are constants in the code. Changing them means a code change.
- Clients sharing one GitHub token share one `/mcp` bucket.

## Out of scope

- Caching the token-to-login resolution in Redis to avoid a `GET /user` on
  every `/mcp` request. It would reduce GitHub API usage further, but it is a
  separate optimization.
