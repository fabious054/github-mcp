import { getPublicOrigin, protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";

export const runtime = "nodejs";

// Metadata RFC 9728: diz ao cliente MCP que este servidor (o /mcp) é
// protegido, e qual Authorization Server usar (o próprio, ver
// /.well-known/oauth-authorization-server) pra conseguir um token.
export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  return protectedResourceHandler({ authServerUrls: [origin] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
