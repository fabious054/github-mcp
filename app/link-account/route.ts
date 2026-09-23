import { decryptJson, encryptJson, isFresh, nowSeconds, oauthErrorResponse, requireOAuthEnabled } from "../../lib/oauth";

export const runtime = "nodejs";

type LinkState = {
  primaryLogin: string;
  iat: number;
};

// Human entry point (opened in a browser, not driven by the MCP client's
// OAuth flow) returned by the 'link_account' tool. Validates the signed
// 'state' the tool generated (proof it was requested by a call already
// authenticated with the primary account) and sends the browser to GitHub's
// real authorization screen, to link an ADDITIONAL account.
export async function GET(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (!state) {
    return oauthErrorResponse(400, "invalid_request", "Missing state.");
  }

  let linkState: LinkState;
  try {
    linkState = decryptJson<LinkState>(state);
  } catch {
    return oauthErrorResponse(
      400,
      "invalid_request",
      "Invalid or expired link — generate a new one with the link_account tool."
    );
  }

  if (!isFresh(linkState.iat, 10 * 60)) {
    return oauthErrorResponse(
      400,
      "invalid_request",
      "Link expired (valid for 10 minutes) — generate a new one with the link_account tool."
    );
  }

  const githubClientId = process.env.GITHUB_OAUTH_CLIENT_ID!;
  const origin = new URL(req.url).origin;
  const callbackUrl = `${origin}/link-callback`;
  const scope = process.env.GITHUB_OAUTH_SCOPES || "repo read:org";

  const asState = encryptJson({
    primaryLogin: linkState.primaryLogin,
    iat: nowSeconds(),
  });

  const githubAuthorizeUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthorizeUrl.searchParams.set("client_id", githubClientId);
  githubAuthorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  githubAuthorizeUrl.searchParams.set("scope", scope);
  githubAuthorizeUrl.searchParams.set("state", asState);
  githubAuthorizeUrl.searchParams.set("allow_signup", "false");

  return Response.redirect(githubAuthorizeUrl.toString(), 302);
}
