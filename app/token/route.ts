import crypto from "node:crypto";
import { decryptJson, isFresh, jsonResponse, oauthErrorResponse, requireOAuthEnabled } from "../../lib/oauth";

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

// This is where Claude exchanges the code it got from /callback for the
// real access_token. The "access_token" we return IS the GitHub token —
// this server is just a proxy, it never stores tokens anywhere.
export async function POST(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  const contentType = req.headers.get("content-type") || "";
  let params: URLSearchParams;
  if (contentType.includes("application/json")) {
    const body = await req.json();
    params = new URLSearchParams(body as Record<string, string>);
  } else {
    params = new URLSearchParams(await req.text());
  }

  const grantType = params.get("grant_type");
  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");

  if (grantType !== "authorization_code") {
    return oauthErrorResponse(400, "unsupported_grant_type", "Only 'authorization_code' is supported.");
  }
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

  return jsonResponse({
    access_token: authCode.githubToken,
    token_type: "bearer",
    scope: authCode.githubScope || "",
  });
}

export async function OPTIONS() {
  return jsonResponse({}, { status: 204 });
}
