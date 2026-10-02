import { checkWindow, getClientIp, hashKey, tooManyRequests } from "./ratelimit";
import { audit } from "./audit";

// Per-IP limits for the public OAuth routes (see docs/adr/0003-redis-rate-limiting.md).
// No identity exists yet at these endpoints, so the client IP is the only
// key available. Each route has its own counter.
const WINDOW_MS = 5 * 60 * 1000;
const TIERS = {
  // /register, /token, /authorize
  strict: { limit: 20, windowMs: WINDOW_MS },
  // /link-account, /link-callback, /callback
  relaxed: { limit: 30, windowMs: WINDOW_MS },
} as const;

// Returns a 429 response when the caller is over the limit, or null when the
// request may proceed. Fail-open and no-op behavior live in ./ratelimit.
export async function rateLimitOAuthRoute(
  req: Request,
  route: string,
  tier: keyof typeof TIERS
): Promise<Response | null> {
  const { limit, windowMs } = TIERS[tier];
  const ip = getClientIp(req);
  const result = await checkWindow(`oauth:${route}:${ip}`, limit, windowMs);
  if (result.allowed) return null;
  audit("ratelimit.blocked", {
    route,
    limit: `${tier}-window`,
    ip,
    retryAfterSeconds: result.retryAfterSeconds,
  });
  return tooManyRequests(result.retryAfterSeconds);
}

// Refreshes (grant_type=refresh_token) arrive from the MCP client's backend,
// whose IPs are shared by every user of that client — keying them by IP
// would let one busy IP lock everyone out of renewing. A valid refresh token
// is keyed by a hash of the GitHub token inside it instead. Invalid refresh
// tokens never reach this: they count against the per-IP /token limit.
const REFRESH_LIMIT = { limit: 30, windowMs: WINDOW_MS };

export async function rateLimitRefresh(githubToken: string): Promise<Response | null> {
  const result = await checkWindow(
    `oauth:refresh:${hashKey(githubToken)}`,
    REFRESH_LIMIT.limit,
    REFRESH_LIMIT.windowMs
  );
  if (result.allowed) return null;
  audit("ratelimit.blocked", {
    route: "token-refresh",
    limit: "refresh-window",
    retryAfterSeconds: result.retryAfterSeconds,
  });
  return tooManyRequests(result.retryAfterSeconds);
}
