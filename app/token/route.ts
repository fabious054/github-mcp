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

// O Claude troca aqui o code recebido em /callback pelo access_token de
// verdade. O "access_token" que devolvemos É o token do GitHub — este
// servidor é só um proxy, nunca guarda os tokens em lugar nenhum.
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
    return oauthErrorResponse(400, "unsupported_grant_type", "Só 'authorization_code' é suportado.");
  }
  if (!code) {
    return oauthErrorResponse(400, "invalid_request", "code ausente.");
  }

  let authCode: McpAuthCode;
  try {
    authCode = decryptJson<McpAuthCode>(code);
  } catch {
    return oauthErrorResponse(400, "invalid_grant", "code inválido ou já usado.");
  }

  if (!isFresh(authCode.iat, 2 * 60)) {
    return oauthErrorResponse(400, "invalid_grant", "code expirado — refaça a autorização.");
  }
  if (clientId && clientId !== authCode.mcpClientId) {
    return oauthErrorResponse(400, "invalid_grant", "client_id não corresponde ao code.");
  }
  if (redirectUri && redirectUri !== authCode.mcpRedirectUri) {
    return oauthErrorResponse(400, "invalid_grant", "redirect_uri não corresponde ao code.");
  }
  if (!codeVerifier || sha256Base64Url(codeVerifier) !== authCode.codeChallenge) {
    return oauthErrorResponse(400, "invalid_grant", "code_verifier (PKCE) inválido.");
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
