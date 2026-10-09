import { decryptJson, encryptJson, isFresh, nowSeconds, oauthErrorResponse, requireOAuthEnabled } from "../../lib/oauth";
import { rateLimitOAuthRoute } from "../../lib/oauth-ratelimit";
import { audit } from "../../lib/audit";
import { revokeOAuthToken } from "../../lib/account-unlink";
import {
  checkGithubToken,
  chooseSessionToken,
  getStoredPrimaryToken,
  parseScopes,
  storePrimaryToken,
} from "../../lib/primary-token";

export const runtime = "nodejs";

type AsState = {
  mcpClientId: string;
  mcpRedirectUri: string;
  mcpState?: string;
  codeChallenge: string;
  iat: number;
};

type GithubTokenResponse = {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

// GitHub redirects the user here after they authorize (or deny) access. We
// exchange the code for the real access token, stash that token inside our
// own (encrypted) "authorization code", and send the browser back to the
// Claude's original redirect_uri.
export async function GET(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;
  const limited = await rateLimitOAuthRoute(req, "callback", "relaxed");
  if (limited) return limited;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const githubError = url.searchParams.get("error");

  if (!state) {
    return oauthErrorResponse(400, "invalid_request", "Missing state on the way back from GitHub.");
  }

  let asState: AsState;
  try {
    asState = decryptJson<AsState>(state);
  } catch {
    return oauthErrorResponse(400, "invalid_request", "Invalid or expired state.");
  }

  if (!isFresh(asState.iat, 10 * 60)) {
    return oauthErrorResponse(400, "invalid_request", "Authorization flow expired, try connecting again.");
  }

  if (githubError) {
    const deny = new URL(asState.mcpRedirectUri);
    deny.searchParams.set("error", "access_denied");
    deny.searchParams.set("error_description", "Authorization denied on GitHub.");
    if (asState.mcpState) deny.searchParams.set("state", asState.mcpState);
    return Response.redirect(deny.toString(), 302);
  }

  if (!code) {
    return oauthErrorResponse(400, "invalid_request", "Missing code on the way back from GitHub.");
  }

  const origin = new URL(req.url).origin;
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/callback`,
    }),
  });

  const tokenBody = (await tokenRes.json()) as GithubTokenResponse;
  if (!tokenRes.ok || !tokenBody.access_token) {
    return oauthErrorResponse(
      502,
      "server_error",
      `Failed to exchange the code with GitHub: ${tokenBody.error_description || tokenBody.error || tokenRes.status}`
    );
  }

  let githubUser: { id: number; login: string } | undefined;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": "github-mcp-oauth" },
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as { id?: unknown; login?: unknown };
      if (typeof user.id === "number" && typeof user.login === "string") {
        githubUser = { id: user.id, login: user.login };
      }
    }
  } catch {
    // not critical — continue without the cached login (and without token reuse)
  }

  // Keep a single GitHub token per user across every place they connect from
  // (ADR 0015): reuse the stored one when it is still valid, otherwise keep
  // this new one. Never fails the login.
  const session = await chooseSessionToken(
    { token: tokenBody.access_token, scopes: parseScopes(tokenBody.scope), user: githubUser },
    {
      getStored: getStoredPrimaryToken,
      store: storePrimaryToken,
      check: (t) => checkGithubToken(t),
      revoke: (t) =>
        revokeOAuthToken(t, process.env.GITHUB_OAUTH_CLIENT_ID, process.env.GITHUB_OAUTH_CLIENT_SECRET),
      audit: (event, fields) => audit(event, fields),
    }
  );

  const mcpCode = encryptJson({
    githubToken: session.token,
    githubScope: session.reused ? session.scopes.join(",") : tokenBody.scope,
    githubLogin: githubUser?.login,
    mcpClientId: asState.mcpClientId,
    mcpRedirectUri: asState.mcpRedirectUri,
    codeChallenge: asState.codeChallenge,
    iat: nowSeconds(),
  });

  const redirectBack = new URL(asState.mcpRedirectUri);
  redirectBack.searchParams.set("code", mcpCode);
  if (asState.mcpState) redirectBack.searchParams.set("state", asState.mcpState);

  return Response.redirect(redirectBack.toString(), 302);
}
