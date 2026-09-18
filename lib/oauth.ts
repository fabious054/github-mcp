import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Utilitários genéricos para o proxy de OAuth (GitHub <-> MCP).
//
// O servidor não tem banco de dados: em vez de guardar client registrations,
// authorization codes e o "state" do fluxo num storage, tudo isso é
// serializado como um blob assinado e criptografado (AES-256-GCM) que viaja
// dentro do próprio parâmetro OAuth (client_id, state, code). Só quem tem a
// OAUTH_ENCRYPTION_KEY (guardada na Vercel) consegue gerar ou ler esses blobs,
// e cada um carrega o timestamp de emissão para expirar sozinho.
// ---------------------------------------------------------------------------

const ALG = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.OAUTH_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY não configurado. Gere uma com `openssl rand -base64 32` e defina na Vercel."
    );
  }
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error(
      "OAUTH_ENCRYPTION_KEY precisa decodificar para 32 bytes em base64 (gere com: openssl rand -base64 32)."
    );
  }
  return key;
}

export function encryptJson(payload: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

export function decryptJson<T>(blob: string): T {
  const key = getKey();
  const raw = Buffer.from(blob, "base64url");
  if (raw.length < 28) throw new Error("Blob inválido.");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8")) as T;
}

export function isFresh(iatSeconds: number, maxAgeSeconds: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return iatSeconds <= now && now - iatSeconds <= maxAgeSeconds;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function sha256Base64Url(input: string): string {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

// CORS: /register e /token são chamados via fetch pelo cliente MCP (rodando
// no navegador, no caso do claude.ai), então precisam liberar CORS.
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function oauthErrorResponse(status: number, error: string, description?: string): Response {
  return jsonResponse({ error, error_description: description }, { status });
}

export function redirectWithError(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export function oauthEnabled(): boolean {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

export function requireOAuthEnabled(): Response | undefined {
  if (!oauthEnabled()) {
    return oauthErrorResponse(
      500,
      "server_error",
      "OAuth não está configurado neste servidor (faltam GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET)."
    );
  }
  return undefined;
}
