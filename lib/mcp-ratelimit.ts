import {
  checkBucket,
  checkWindow,
  getClientIp,
  hashKey,
  peekWindow,
  tooManyRequests,
} from "./ratelimit";

// Rate limiting for /mcp (see docs/adr/0003-redis-rate-limiting.md).
//
// /mcp calls come from Claude's backend, so the client IP does not identify
// the end user. In OAuth mode the identity is the bearer token, so the main
// limit is a token bucket keyed by a hash of it, checked BEFORE the token is
// verified against GitHub (verification costs one GET /user per request).
// Requests that fail token verification are counted per IP in a separate
// window, so a flood of invalid tokens is cut off before it reaches GitHub.
// In legacy fixed-account mode there is no identity, so the IP is the key.

// 60 requests / min, with bursts up to 60.
const BUCKET_CAPACITY = 60;
const BUCKET_REFILL_MS = 60 * 1000;

// Failed token verifications allowed per IP in the window.
const FAILED_VERIFICATION_LIMIT = 20;
const FAILED_VERIFICATION_WINDOW_MS = 5 * 60 * 1000;

function getBearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function failedVerificationKey(req: Request): string {
  return `mcp-fail:${getClientIp(req)}`;
}

// Returns a 429 response when the caller is over a limit, or null when the
// request may proceed. Fail-open and no-op behavior live in ./ratelimit.
export async function rateLimitMcp(req: Request, oauth: boolean): Promise<Response | null> {
  if (oauth) {
    const blocked = await peekWindow(
      failedVerificationKey(req),
      FAILED_VERIFICATION_LIMIT,
      FAILED_VERIFICATION_WINDOW_MS
    );
    if (!blocked.allowed) return tooManyRequests(blocked.retryAfterSeconds);
  }

  const token = oauth ? getBearerToken(req) : undefined;
  // No token (legacy mode, or an unauthenticated probe): fall back to the IP.
  const key = token ? `mcp:token:${hashKey(token)}` : `mcp:ip:${getClientIp(req)}`;
  const result = await checkBucket(key, BUCKET_CAPACITY, BUCKET_REFILL_MS);
  return result.allowed ? null : tooManyRequests(result.retryAfterSeconds);
}

// Call when GitHub rejects a bearer token, so repeated failures from one IP
// get blocked by the check above.
export async function recordFailedTokenVerification(req: Request): Promise<void> {
  await checkWindow(
    failedVerificationKey(req),
    FAILED_VERIFICATION_LIMIT,
    FAILED_VERIFICATION_WINDOW_MS
  );
}
