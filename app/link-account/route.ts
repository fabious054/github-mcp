import { decryptJson, encryptJson, isFresh, nowSeconds, oauthErrorResponse, requireOAuthEnabled } from "../../lib/oauth";

export const runtime = "nodejs";

type LinkState = {
  primaryLogin: string;
  iat: number;
};

// Ponto de entrada humano (aberto num navegador, não pelo fluxo OAuth do
// cliente MCP) devolvido pela ferramenta 'link_account'. Valida o 'state'
// assinado que a ferramenta gerou (prova que foi pedido por uma chamada já
// autenticada com a conta primária) e manda o navegador pra tela real de
// autorização do GitHub, pra vincular uma conta ADICIONAL.
export async function GET(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  if (!state) {
    return oauthErrorResponse(400, "invalid_request", "state ausente.");
  }

  let linkState: LinkState;
  try {
    linkState = decryptJson<LinkState>(state);
  } catch {
    return oauthErrorResponse(
      400,
      "invalid_request",
      "Link inválido ou expirado — gere um novo com a ferramenta link_account."
    );
  }

  if (!isFresh(linkState.iat, 10 * 60)) {
    return oauthErrorResponse(
      400,
      "invalid_request",
      "Link expirado (validade de 10 minutos) — gere um novo com a ferramenta link_account."
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
