import { decryptJson, isFresh, oauthErrorResponse, requireOAuthEnabled } from "../../lib/oauth";
import { linkAccount } from "../../lib/accounts";

export const runtime = "nodejs";

type AsState = {
  primaryLogin: string;
  iat: number;
};

type GithubTokenResponse = {
  access_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

// GitHub redirects here after the person authorizes (or denies) access for
// the ADDITIONAL account. Exchanges the code for the real token, looks up
// that account's login, and writes the link (primaryLogin -> additional
// login) to MongoDB, with the token encrypted — never in plaintext.
export async function GET(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

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
    return oauthErrorResponse(
      400,
      "invalid_request",
      "The linking flow expired, generate a new link with the link_account tool."
    );
  }

  if (githubError) {
    return htmlResponse("Authorization denied on GitHub. No account was linked.");
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
      redirect_uri: `${origin}/link-callback`,
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

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": "github-mcp-oauth" },
  });
  if (!userRes.ok) {
    return oauthErrorResponse(502, "server_error", "Could not identify the newly authorized GitHub account.");
  }
  const user = await userRes.json();
  const login: string | undefined = user.login;
  if (!login) {
    return oauthErrorResponse(502, "server_error", "GitHub did not return a valid login.");
  }

  if (login === asState.primaryLogin) {
    return htmlResponse(
      `'${login}' is already your primary account — nothing to link. To add an account, authorize with a different GitHub account.`
    );
  }

  await linkAccount(asState.primaryLogin, login, tokenBody.access_token);

  return htmlResponse(
    `Account '${login}' was successfully linked to your primary account ('${asState.primaryLogin}'). You can close this tab and go back to Claude.`
  );
}

function htmlResponse(message: string): Response {
  return new Response(
    `<!doctype html><html><body style="font-family: system-ui; padding: 2rem; max-width: 40rem; margin: 0 auto;"><p>${message}</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
