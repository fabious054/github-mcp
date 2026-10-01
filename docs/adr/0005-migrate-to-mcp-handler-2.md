# ADR 0005: Migrate to mcp-handler 2 (MCP SDK v2)

## Status
Accepted (2026-10-01). Implemented in issue #43.

## Context

Dependabot proposed `mcp-handler` 1.1 → 2.2 (#29). Unlike the other major
bumps handled in #41, this one is a migration:

- `mcp-handler` 2 is built on the MCP SDK v2 (`@modelcontextprotocol/server`)
  and requires zod 4 and Node 20+ (both already in place after #41).
- It serves the **2026-07-28** MCP specification natively and falls back to
  stateless Streamable HTTP for 2025-era clients from the same handler.
  GET/DELETE session operations answer 405; the HTTP+SSE transport
  (2024-11-05) is gone.
- The variadic `server.tool(name, description, shape, cb)` API is removed in
  favor of `server.registerTool(name, { description, inputSchema }, cb)`, with
  `inputSchema` a full schema (`z.object({...})`).
- In tool callbacks, `extra.authInfo` becomes `ctx.http?.authInfo`.
- `createMcpHandler(init, serverOptions, config)` becomes
  `createMcpHandler(init, options)`; route options such as `maxDuration` are
  removed (the route sets them itself).
- `withMcpAuth` still answers 401 for any verifier error, so the transient
  error handling from ADR 0004 (verification answered before `withMcpAuth`)
  keeps working unchanged.

In this server that means rewriting all 23 tool registrations and 27
`extra.authInfo` call sites. Nothing about what each tool does changes.

Nothing is broken today: Claude works with 1.x. The question was timing.

## Options considered

1. **Stay on 1.x for now.** Close #29, ignore the major version in Dependabot,
   revisit later. No work and no risk today, but the migration grows with
   every tool added, and it may later be forced by a security fix that only
   ships in 2.x — under time pressure.
2. **Migrate now**, as a dedicated change with its own tests and a rollback
   plan.

## Decision

Option 2, chosen by the maintainer on 2026-10-01: migrating now, with 23 tools
and the context fresh, is cheaper and safer than migrating later with more
tools and possibly more urgency.

- Mechanical rewrite of every tool to `registerTool`, keeping names,
  descriptions and argument schemas identical.
- `extra?.authInfo` → `ctx.http?.authInfo` everywhere; `AuthInfo.extra`
  (where `githubLogin` lives) still exists in SDK v2.
- `maxDuration = 60` moves to a route segment export.
- The transient-error handling of ADR 0004 and the rate limiting of ADR 0003
  stay as they are: both run before `withMcpAuth`.

## Consequences

- The server speaks the current MCP protocol while still serving 2025-era
  clients through the SDK fallback.
- Tool behavior, names and arguments are unchanged; the advertised JSON
  schemas are produced by SDK v2 and may differ in formatting.
- Client compatibility can only be fully confirmed in production, because the
  OAuth App only accepts the production callback URL. Rollback is Vercel's
  instant rollback to the previous production deployment.
- Future tools must be written with `registerTool`.

## Out of scope

- Moving the authorization server from Dynamic Client Registration (`/register`)
  to Client ID Metadata Documents, which the 2026-07-28 spec now favors. That
  lives in this repository's own OAuth routes, not in `mcp-handler`, and is a
  separate decision.
