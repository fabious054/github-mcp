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

// GitHub redireciona pra cá depois que a pessoa autoriza (ou nega) o acesso
// da conta ADICIONAL. Troca o code pelo token de verdade, descobre o login
// dessa conta, e grava o vínculo (primaryLogin -> login adicional) no Mongo,
// com o token criptografado — nunca em texto puro.
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
    return oauthErrorResponse(
      400,
      "invalid_request",
      "Fluxo de vínculo expirou, gere um novo link com a ferramenta link_account."
    );
  }

  if (githubError) {
    return htmlResponse("Autorização negada no GitHub. Nenhuma conta foi vinculada.");
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
      redirect_uri: `${origin}/link-callback`,
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

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, "User-Agent": "github-mcp-oauth" },
  });
  if (!userRes.ok) {
    return oauthErrorResponse(502, "server_error", "Não foi possível identificar a conta do GitHub recém-autorizada.");
  }
  const user = await userRes.json();
  const login: string | undefined = user.login;
  if (!login) {
    return oauthErrorResponse(502, "server_error", "GitHub não devolveu um login válido.");
  }

  if (login === asState.primaryLogin) {
    return htmlResponse(
      `'${login}' já é a sua conta primária — nada a vincular. Pra adicionar uma conta, autorize com uma conta do GitHub diferente.`
    );
  }

  await linkAccount(asState.primaryLogin, login, tokenBody.access_token);

  return htmlResponse(
    `Conta '${login}' vinculada com sucesso à sua conta primária ('${asState.primaryLogin}'). Pode fechar esta aba e voltar pro Claude.`
  );
}

function htmlResponse(message: string): Response {
  return new Response(
    `<!doctype html><html><body style="font-family: system-ui; padding: 2rem; max-width: 40rem; margin: 0 auto;"><p>${message}</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
