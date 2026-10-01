import { checkWindow, getClientIp, tooManyRequests } from "./ratelimit";
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
