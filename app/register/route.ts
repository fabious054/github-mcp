import { encryptJson, jsonResponse, oauthErrorResponse, requireOAuthEnabled, nowSeconds } from "../../lib/oauth";

export const runtime = "nodejs";

// Dynamic Client Registration (RFC 7591) — stateless: em vez de guardar o
// registro num banco, o client_id É o registro, criptografado. /authorize
// depois só decripta o client_id recebido pra saber os redirect_uris válidos.
export async function POST(req: Request) {
  const disabled = requireOAuthEnabled();
  if (disabled) return disabled;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return oauthErrorResponse(400, "invalid_client_metadata", "Corpo da requisição precisa ser JSON.");
  }

  const redirectUris = body?.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((u) => typeof u === "string")) {
    return oauthErrorResponse(400, "invalid_client_metadata", "'redirect_uris' é obrigatório e precisa ser uma lista de URLs.");
  }

  const clientName = typeof body?.client_name === "string" ? body.client_name : undefined;
  const issuedAt = nowSeconds();

  const clientId = encryptJson({
    redirectUris,
    clientName,
    iat: issuedAt,
  });

  return jsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      redirect_uris: redirectUris,
      client_name: clientName,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 }
  );
}

export async function OPTIONS() {
  return jsonResponse({}, { status: 204 });
}
