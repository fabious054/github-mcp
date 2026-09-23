import { getPublicOrigin, protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";

export const runtime = "nodejs";

// RFC 9728 metadata: tells the MCP client that this server (the /mcp
// endpoint) is protected, and which Authorization Server to use (this same
// server, see /.well-known/oauth-authorization-server) to get a token.
export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  return protectedResourceHandler({ authServerUrls: [origin] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
