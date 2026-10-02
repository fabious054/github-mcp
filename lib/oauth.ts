import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Generic utilities for the OAuth proxy (GitHub <-> MCP).
//
// The server has no database: instead of storing client registrations,
// authorization codes and the flow's "state" in a store, all of it is
// serialized as a signed, encrypted blob (AES-256-GCM) that travels inside
// the OAuth parameter itself (client_id, state, code). Only whoever holds
// OAUTH_ENCRYPTION_KEY (kept on Vercel) can generate or read these blobs,
// and each one carries its issued-at timestamp so it expires on its own.
// ---------------------------------------------------------------------------

const ALG = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.OAUTH_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it on Vercel."
    );
  }
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY must decode to 32 bytes in base64 (generate with: openssl rand -base64 32)."
    );
  }
  return key;
}

export function encryptJson(payload: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptJson<T>(blob: string): T {
  const key = getKey();
  const raw = Buffer.from(blob, "base64url");
  if (raw.length < 28) throw new Error("Invalid blob.");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8")) as T;
}

export function isFresh(iatSeconds: number, maxAgeSeconds: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return iatSeconds <= now && now - iatSeconds <= maxAgeSeconds;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Token lifetimes (see docs/adr/0011-stateless-refresh-tokens.md).
//
// The access token handed to the MCP client IS the user's GitHub OAuth App
// token, which GitHub never expires. Without an `expires_in` and a
// `refresh_token`, clients apply their own lifetime and then have no way to
// renew except sending the user through the whole OAuth flow again. So the
// token response advertises a lifetime and a refresh token, and the client
// renews silently.
// ---------------------------------------------------------------------------

// How long the client should treat an access token as valid before
// refreshing it. Every refresh re-checks the GitHub token with GitHub.
export const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;

// Refresh token: an encrypted blob, like every other OAuth artifact here.
// It never expires on its own; it stops working only when GitHub stops
// accepting the token inside it (checked on every refresh). `typ` keeps it
// from being confused with the other blobs encrypted with the same key
// (client_id, state, authorization code).
export type McpRefreshToken = {
  typ: "refresh";
  githubToken: string;
  githubScope?: string;
  githubLogin?: string;
  mcpClientId: string;
  iat: number;
};

export function issueRefreshToken(fields: Omit<McpRefreshToken, "typ" | "iat">): string {
  return encryptJson({ typ: "refresh", ...fields, iat: nowSeconds() } satisfies McpRefreshToken);
}

// Returns the decoded refresh token, or undefined when the blob is not a
// valid refresh token issued by this server (garbage, tampered, another key,
// or another kind of blob).
export function readRefreshToken(blob: string | null | undefined): McpRefreshToken | undefined {
  if (!blob) return undefined;
  let decoded: Partial<McpRefreshToken>;
  try {
    decoded = decryptJson<Partial<McpRefreshToken>>(blob);
  } catch {
    return undefined;
  }
  if (
    !decoded ||
    decoded.typ !== "refresh" ||
    typeof decoded.githubToken !== "string" ||
    !decoded.githubToken ||
    typeof decoded.mcpClientId !== "string" ||
    !decoded.mcpClientId
  ) {
    return undefined;
  }
  return decoded as McpRefreshToken;
}

// Successful token response (RFC 6749 section 5.1), shared by both grants.
export function tokenResponse(fields: {
  githubToken: string;
  githubScope?: string;
  githubLogin?: string;
  mcpClientId: string;
}): Response {
  return jsonResponse(
    {
      access_token: fields.githubToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: issueRefreshToken(fields),
      scope: fields.githubScope || "",
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

export function sha256Base64Url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

// CORS: /register and /token are called via fetch by the MCP client
// (running in the browser, in claude.ai's case), so they need to allow CORS.
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function oauthErrorResponse(status: number, error: string, description?: string): Response {
  return jsonResponse({ error, error_description: description }, { status });
}

export function redirectWithError(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export function oauthEnabled(): boolean {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

export function requireOAuthEnabled(): Response | undefined {
  if (!oauthEnabled()) {
    return oauthErrorResponse(
      500,
      "server_error",
      "OAuth is not configured on this server (missing GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET)."
    );
  }
  return undefined;
}
