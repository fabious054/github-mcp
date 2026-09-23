import { getPublicOrigin, metadataCorsOptionsRequestHandler } from "mcp-handler";

export const runtime = "nodejs";

// "Authorization Server" metadata (RFC 8414). The MCP client (Claude) reads
// this to discover this server's /authorize, /token and /register
// endpoints, which under the hood proxy GitHub's OAuth.
export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  const scopes = (process.env.GITHUB_OAUTH_SCOPES || "repo read:org").split(" ");

  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: scopes,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
