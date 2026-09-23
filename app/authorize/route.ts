import {
  decryptJson,
  encryptJson,
  nowSeconds,
  oauthErrorResponse,
  redirectWithError,
  requireOAuthEnabled,
} from "../../lib/oauth";
import { getPublicOrigin } from "mcp-handler";

export const runtime = "nodejs";

type RegisteredClient = {
  redirectUris: string[];
  clientName?: string;
  iat: number;
};

// The Claude (MCP client) brings the user here in the browser. We validate
// the request, pack everything we need to remember (client, redirect_uri,
// code_challenge, state) into our own "state", and send the browser to
// GitHub's real authorization screen.
export async function GET(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  const url = new URL(req.url);
  const params = url.searchParams;

  const responseType = params.get("response_type");
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state") || undefined;
  const codeChallenge = params.get("code_challenge");
  const codeChallengeMethod = params.get("code_challenge_method");

  if (!clientId) {
    return oauthErrorResponse(400, "invalid_request", "Missing client_id.");
  }

  let client: RegisteredClient;
  try {
    client = decryptJson<RegisteredClient>(clientId);
  } catch {
    return oauthErrorResponse(400, "invalid_client", "Invalid or expired client_id — redo client registration.");
  }

  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return oauthErrorResponse(400, "invalid_request", "Missing redirect_uri, or it doesn't match the registered one.");
  }

  if (responseType !== "code") {
    return redirectWithError(redirectUri, state, "unsupported_response_type", "Only 'code' is supported.");
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return redirectWithError(redirectUri, state, "invalid_request", "PKCE (code_challenge with S256) is required.");
  }

  const githubClientId = process.env.GITHUB_OAUTH_CLIENT_ID!;
  const origin = getPublicOrigin(req);
  const callbackUrl = `${origin}/callback`;
  const scope = process.env.GITHUB_OAUTH_SCOPES || "repo read:org";

  const asState = encryptJson({
    mcpClientId: clientId,
    mcpRedirectUri: redirectUri,
    mcpState: state,
    codeChallenge,
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
