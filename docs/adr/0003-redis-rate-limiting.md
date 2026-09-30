# ADR 0003: Redis-backed rate limiting

## Status
Accepted (2026-09-30)

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
rate limiting to all routes, with these limits as the starting point:

- `/register`, `/token`, `/authorize`: 20 requests / 5 min per IP
- `/link-account`, `/link-callback`, `/callback`: 30 requests / 5 min per IP
- `/mcp`, OAuth mode: 60 requests / min per identity, token bucket to allow
  short bursts
- `/mcp`, legacy fixed-account mode: same limit, per IP
- Rejections return `429` with a `Retry-After` header.

**Fail-open:** if Redis is unreachable, errors, or exceeds a short timeout,
the request is allowed and the error is logged. A Redis outage must not
block login or tool calls. With `REDIS_URL` unset (local development), the
limiter is a no-op.

## Consequences

- A second stateful dependency (`REDIS_URL`) joins `MONGODB_URI` on Vercel;
  it must be documented in `.env.example`, the README and
  `docs/self-hosting.md`.
- Fail-open means a Redis outage temporarily removes protection. This is an
  accepted trade-off for a public connector where availability of legitimate
  use matters more than strict enforcement.
- Open implementation points, to be settled in issue #21 before coding: the
  identity key for `/mcp` (GitHub login vs a hash of the bearer token),
  atomicity approach (Lua script vs `INCR` + `EXPIRE`), and which header
  carries the trusted client IP on Vercel.
