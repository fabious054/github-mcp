import { decryptJson, encryptJson, isFresh, nowSeconds, oauthErrorResponse, requireOAuthEnabled } from "../../lib/oauth";

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

// O GitHub redireciona o usuário pra cá depois que ele autoriza (ou nega) o
// acesso. Trocamos o code pelo token de acesso de verdade, guardamos esse
// token dentro de um "authorization code" nosso (criptografado) e devolvemos
// o navegador pro redirect_uri original do Claude.
export async function GET(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const githubError = url.searchParams.get("error");

  if (!state) {
    return oauthErrorResponse(400, "invalid_request", "state ausente na volta do GitHub.");
  }

  let asState: AsState;
  try {
    asState = decryptJson<AsState>(state);
  } catch {
    return oauthErrorResponse(400, "invalid_request", "state inválido ou expirado.");
  }

  if (!isFresh(asState.iat, 10 * 60)) {
    return oauthErrorResponse(400, "invalid_request", "Fluxo de autorização expirou, tente conectar de novo.");
  }

  if (githubError) {
    const deny = new URL(asState.mcpRedirectUri);
    deny.searchParams.set("error", "access_denied");
    deny.searchParams.set("error_description", "Autorização negada no GitHub.");
    if (asState.mcpState) deny.searchParams.set("state", asState.mcpState);
    return Response.redirect(deny.toString(), 302);
  }

  if (!code) {
    return oauthErrorResponse(400, "invalid_request", "code ausente na volta do GitHub.");
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
      `Falha ao trocar o code com o GitHub: ${tokenBody.error_description || tokenBody.error || tokenRes.status}`
    );
  }

  let githubLogin: string | undefined;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": "github-mcp-oauth" },
    });
    if (userRes.ok) {
      const user = await userRes.json();
      githubLogin = user.login;
    }
  } catch {
    // não crítico — segue sem o login em cache
  }

  const mcpCode = encryptJson({
    githubToken: tokenBody.access_token,
    githubScope: tokenBody.scope,
    githubLogin,
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
