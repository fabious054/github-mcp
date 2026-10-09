import crypto from "node:crypto";
import {
  decryptJson,
  isFresh,
  jsonResponse,
  oauthErrorResponse,
  readRefreshToken,
  requireOAuthEnabled,
  tokenResponse,
} from "../../lib/oauth";
import { rateLimitOAuthRoute, rateLimitRefresh } from "../../lib/oauth-ratelimit";
import { audit } from "../../lib/audit";
import { verifyGithubTokenWithGithub } from "../../lib/github-auth";

export const runtime = "nodejs";

type McpAuthCode = {
  githubToken: string;
  githubScope?: string;
  githubLogin?: string;
  mcpClientId: string;
  mcpRedirectUri: string;
  codeChallenge: string;
  iat: number;
};

function sha256Base64Url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const body = await req.json();
      return new URLSearchParams(body as Record<string, string>);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(await req.text());
}

// This is where Claude exchanges the code it got from /callback for the
// real access_token, and later renews it with the refresh token. The
// "access_token" we return IS the GitHub token — the one /callback chose for
// this user (one per GitHub user, see docs/adr/0015). Refresh tokens are
// stateless, see docs/adr/0011.
export async function POST(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  const params = await readParams(req);
  const grantType = params.get("grant_type");

  // Refreshes have their own rate limit (by identity, not by the shared
  // client IP), so they branch off before the per-IP limit below.
  if (grantType === "refresh_token") return refresh(req, params);

  const limited = await rateLimitOAuthRoute(req, "token", "strict");
  if (limited) return limited;

  if (grantType !== "authorization_code") {
    return oauthErrorResponse(
      400,
      "unsupported_grant_type",
      "Only 'authorization_code' and 'refresh_token' are supported."
    );
  }
  return exchangeCode(params);
}

async function exchangeCode(params: URLSearchParams): Promise<Response> {
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");

  if (!code) {
    return oauthErrorResponse(400, "invalid_request", "Missing code.");
  }

  let authCode: McpAuthCode;
  try {
    authCode = decryptJson<McpAuthCode>(code);
  } catch {
    return oauthErrorResponse(400, "invalid_grant", "Invalid or already-used code.");
  }

  if (!isFresh(authCode.iat, 2 * 60)) {
    return oauthErrorResponse(400, "invalid_grant", "Code expired — redo the authorization.");
  }
  if (clientId && clientId !== authCode.mcpClientId) {
    return oauthErrorResponse(400, "invalid_grant", "client_id doesn't match the code.");
  }
  if (redirectUri && redirectUri !== authCode.mcpRedirectUri) {
    return oauthErrorResponse(400, "invalid_grant", "redirect_uri doesn't match the code.");
  }
  if (!codeVerifier || sha256Base64Url(codeVerifier) !== authCode.codeChallenge) {
    return oauthErrorResponse(400, "invalid_grant", "Invalid code_verifier (PKCE).");
  }

  audit("oauth.token.issued", {
    githubLogin: authCode.githubLogin,
    mcpClientId: authCode.mcpClientId.slice(0, 16),
  });

  return tokenResponse({
    githubToken: authCode.githubToken,
    githubScope: authCode.githubScope,
    githubLogin: authCode.githubLogin,
    mcpClientId: authCode.mcpClientId,
  });
}

// grant_type=refresh_token (RFC 6749 section 6).
// - Invalid blob or client_id mismatch → invalid_grant, counted per IP.
// - GitHub rejects the token inside it → invalid_grant: the user must log in
//   again (the token was revoked on GitHub's side).
// - GitHub can't answer right now → 503 + Retry-After, never invalid_grant,
//   so the client keeps its refresh token and retries (same rule as ADR 0004).
// - Otherwise → the same GitHub token with a fresh lifetime and a new
//   refresh token.
async function refresh(req: Request, params: URLSearchParams): Promise<Response> {
  const refreshToken = readRefreshToken(params.get("refresh_token"));
  const clientId = params.get("client_id");

  if (!refreshToken || (clientId && clientId !== refreshToken.mcpClientId)) {
    const limited = await rateLimitOAuthRoute(req, "token", "strict");
    if (limited) return limited;
    return oauthErrorResponse(400, "invalid_grant", "Invalid refresh token — reconnect.");
  }

  const limited = await rateLimitRefresh(refreshToken.githubToken);
  if (limited) return limited;

  const check = await verifyGithubTokenWithGithub(refreshToken.githubToken);

  if (check.kind === "transient") {
    audit("oauth.token.refresh_transient", {
      githubLogin: refreshToken.githubLogin,
      mcpClientId: refreshToken.mcpClientId.slice(0, 16),
      githubStatus: check.githubStatus,
      networkError: check.networkError,
      retryAfterSeconds: check.retryAfterSeconds,
    });
    return jsonResponse(
      {
        error: "temporarily_unavailable",
        error_description: "GitHub could not verify the token right now. Retry shortly; no need to reconnect.",
      },
      {
        status: 503,
        headers: { "Retry-After": String(check.retryAfterSeconds), "Cache-Control": "no-store" },
      }
    );
  }

  if (check.kind === "rejected") {
    audit("oauth.token.refresh_rejected", {
      githubLogin: refreshToken.githubLogin,
      mcpClientId: refreshToken.mcpClientId.slice(0, 16),
      githubStatus: check.githubStatus,
      githubRequestId: check.githubRequestId,
    });
    return oauthErrorResponse(400, "invalid_grant", "GitHub no longer accepts this authorization — reconnect.");
  }

  audit("oauth.token.refreshed", {
    githubLogin: check.login,
    mcpClientId: refreshToken.mcpClientId.slice(0, 16),
  });

  return tokenResponse({
    githubToken: refreshToken.githubToken,
    githubScope: refreshToken.githubScope,
    githubLogin: check.login,
    mcpClientId: refreshToken.mcpClientId,
  });
}

export async function OPTIONS() {
  return jsonResponse({}, { status: 204 });
}
