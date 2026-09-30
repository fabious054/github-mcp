import { createHash } from "node:crypto";
import { createClient } from "redis";

// Redis-backed rate limiting (see docs/adr/0003-redis-rate-limiting.md).
//
// Design points:
// - Fail-open: if Redis is unreachable, errors or is slow, the request is
//   allowed and the error is logged. A Redis outage must never block login
//   or tool calls.
// - No-op when REDIS_URL is unset (local development).
// - Each serverless invocation is isolated, so counters live in Redis. The
//   check and the update happen inside a single Lua script (EVAL), which
//   Redis runs atomically, and the clock comes from Redis (TIME) so that
//   different instances never disagree about "now".

type RedisClient = ReturnType<typeof makeClient>;

declare global {
  // eslint-disable-next-line no-var
  var _redisClientPromise: Promise<RedisClient> | undefined;
}

// Short on purpose: rate limiting must not add noticeable latency, and a
// slow Redis is treated the same as an unreachable one (fail-open).
const TIMEOUT_MS = 300;
const KEY_PREFIX = "rl:";

export type RateLimitResult = {
  allowed: boolean;
  // Seconds until the caller may retry. 0 when allowed.
  retryAfterSeconds: number;
};

const ALLOWED: RateLimitResult = { allowed: true, retryAfterSeconds: 0 };

// One script for both algorithms.
//   ARGV[1] = "window" | "bucket"
//   window: ARGV[2] = limit, ARGV[3] = window length (ms)
//           fixed window counter: INCR, expire on first hit.
//   bucket: ARGV[2] = capacity, ARGV[3] = time to refill a full bucket (ms)
//           token bucket: allows short bursts up to `capacity`, refilling
//           at capacity / ARGV[3] tokens per ms.
// Returns { allowed (1|0), retryAfterMs }.
const SCRIPT = `
local mode = ARGV[1]
local limit = tonumber(ARGV[2])
local span = tonumber(ARGV[3])

if mode == "window" then
  local n = redis.call("INCR", KEYS[1])
  if n == 1 then
    redis.call("PEXPIRE", KEYS[1], span)
  end
  local ttl = redis.call("PTTL", KEYS[1])
  if ttl < 0 then
    redis.call("PEXPIRE", KEYS[1], span)
    ttl = span
  end
  if n > limit then
    return { 0, ttl }
  end
  return { 1, 0 }
end

local t = redis.call("TIME")
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local data = redis.call("HMGET", KEYS[1], "tokens", "ts")
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = limit
  ts = now
end
local elapsed = math.max(0, now - ts)
tokens = math.min(limit, tokens + elapsed * limit / span)
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) * span / limit)
end
redis.call("HSET", KEYS[1], "tokens", tostring(tokens), "ts", tostring(now))
redis.call("PEXPIRE", KEYS[1], span)
return { allowed, retry }
`;

function makeClient(url: string) {
  return createClient({
    url,
    socket: {
      connectTimeout: TIMEOUT_MS,
      // Never retry in the background: in a serverless function a retry
      // loop would only keep the invocation alive. A failed connection is
      // dropped below and re-attempted by the next request.
      reconnectStrategy: false,
    },
  });
}

function getRedisClientPromise(): Promise<RedisClient> | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (!global._redisClientPromise) {
    const client = makeClient(url);
    // Without an 'error' listener node-redis would throw on socket errors.
    client.on("error", (err) => {
      console.error("[ratelimit] redis client error:", err);
      global._redisClientPromise = undefined;
    });
    global._redisClientPromise = client.connect().then(() => client);
    global._redisClientPromise.catch(() => {
      global._redisClientPromise = undefined;
    });
  }
  return global._redisClientPromise;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`redis timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function run(
  mode: "window" | "bucket",
  key: string,
  limit: number,
  spanMs: number
): Promise<RateLimitResult> {
  const clientPromise = getRedisClientPromise();
  if (!clientPromise) return ALLOWED; // REDIS_URL unset: no-op.

  try {
    const reply = await withTimeout(
      (async () => {
        const client = await clientPromise;
        return client.eval(SCRIPT, {
          keys: [KEY_PREFIX + key],
          arguments: [mode, String(limit), String(spanMs)],
        });
      })()
    );
    const [allowed, retryMs] = reply as [number, number];
    if (Number(allowed) === 1) return ALLOWED;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(Number(retryMs) / 1000)),
    };
  } catch (err) {
    // Fail-open.
    console.error("[ratelimit] check failed, allowing request:", err);
    return ALLOWED;
  }
}

// Fixed window: at most `limit` hits per `windowMs` for `key`.
export function checkWindow(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  return run("window", `w:${key}`, limit, windowMs);
}

// Token bucket: bursts up to `capacity`, refilling a full bucket every
// `refillMs` (sustained rate = capacity / refillMs).
export function checkBucket(
  key: string,
  capacity: number,
  refillMs: number
): Promise<RateLimitResult> {
  return run("bucket", `b:${key}`, capacity, refillMs);
}

// Client IP as seen by Vercel. Vercel overwrites x-forwarded-for with the
// real client address, so its first value can be trusted there.
// https://vercel.com/docs/headers/request-headers
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
}

// Stable, non-reversible key fragment, so secrets (e.g. bearer tokens) are
// never stored in Redis in clear text.
export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      error_description: "Too many requests. Try again later.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    }
  );
}
