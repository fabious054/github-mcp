import { createHash } from "node:crypto";

// Structured audit logging.
//
// Every event is a single JSON line on stdout/stderr, so it can be searched
// and grouped in the Vercel runtime logs (e.g. query `"audit":"mcp.auth.transient"`).
//
// Hard rule: no token is ever logged in clear text — not the MCP bearer, not a
// GitHub token, not a linked account's token. When a log line needs to tell
// two tokens apart, it uses tokenFingerprint(), a short, non-reversible hash.

export type AuditEvent =
  | "mcp.auth.rejected"
  | "mcp.auth.transient"
  | "ratelimit.blocked"
  | "oauth.token.issued"
  | "oauth.token.refreshed"
  | "oauth.token.refresh_rejected"
  | "oauth.token.refresh_transient"
  | "oauth.link.completed"
  | "oauth.link.removed"
  | "oauth.link.failed"
  | "oauth.link.token_revoked";

type AuditValue = string | number | boolean | null | undefined;

const WARN_EVENTS: ReadonlySet<AuditEvent> = new Set([
  "mcp.auth.rejected",
  "mcp.auth.transient",
  "ratelimit.blocked",
  "oauth.token.refresh_rejected",
  "oauth.token.refresh_transient",
  "oauth.link.failed",
  "oauth.link.token_revoked",
]);

export function audit(event: AuditEvent, fields: Record<string, AuditValue> = {}): void {
  const clean: Record<string, AuditValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) clean[key] = value;
  }
  const line = JSON.stringify({ audit: event, ts: new Date().toISOString(), ...clean });
  if (WARN_EVENTS.has(event)) console.warn(line);
  else console.log(line);
}

// First 12 hex chars of the token's SHA-256: enough to correlate events from
// the same token, useless for recovering it.
export function tokenFingerprint(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
