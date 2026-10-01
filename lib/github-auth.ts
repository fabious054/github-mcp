// Verification of a GitHub token against GET /user, with the result
// classified so that a hiccup on GitHub's side is never mistaken for a
// revoked token (see issue #37).
//
// - "ok":        the token is valid; carries the GitHub login.
// - "rejected":  GitHub says the token is not valid (401, or another 4xx that
//                is not a rate limit). The client must re-authenticate.
// - "transient": GitHub could not answer right now (5xx, rate-limited 403/429,
//                network error, timeout). The token may be perfectly fine, so
//                the client should retry instead of re-authenticating.

const GITHUB_USER_URL = "https://api.github.com/user";
const VERIFY_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_RETRY_AFTER_SECONDS = 300;

export type GithubDiagnostics = {
  githubStatus?: number;
  githubRequestId?: string;
  rateLimitRemaining?: string;
  rateLimitReset?: string;
  networkError?: string;
};

export type GithubVerification =
  | { kind: "ok"; login: string }
  | ({ kind: "rejected" } & GithubDiagnostics)
  | ({ kind: "transient"; retryAfterSeconds: number } & GithubDiagnostics);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function diagnosticsFrom(res: Response): GithubDiagnostics {
  return {
    githubStatus: res.status,
    githubRequestId: res.headers.get("x-github-request-id") ?? undefined,
    rateLimitRemaining: res.headers.get("x-ratelimit-remaining") ?? undefined,
    rateLimitReset: res.headers.get("x-ratelimit-reset") ?? undefined,
  };
}

function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 1) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

// Retry-After from GitHub's own headers when present: `retry-after` (seconds),
// else `x-ratelimit-reset` (epoch seconds) when the primary limit is exhausted.
function retryAfterFrom(res: Response, nowMs: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) return clampRetryAfter(Number(retryAfter));
  const reset = res.headers.get("x-ratelimit-reset");
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset.trim())) {
    return clampRetryAfter(Number(reset) - nowMs / 1000);
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
}

// GitHub signals both primary and secondary rate limits with 403 or 429.
// Evidence: 429 itself, `retry-after`, `x-ratelimit-remaining: 0`, or a body
// message mentioning a rate limit.
async function isRateLimited(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status !== 403) return false;
  if (res.headers.get("retry-after")) return true;
  if (res.headers.get("x-ratelimit-remaining") === "0") return true;
  try {
    const body = await res.clone().text();
    return /rate limit/i.test(body);
  } catch {
    return false;
  }
}

export async function verifyGithubTokenWithGithub(
  token: string,
  fetchImpl: FetchLike = fetch,
  nowMs: () => number = Date.now
): Promise<GithubVerification> {
  let res: Response;
  try {
    res = await fetchImpl(GITHUB_USER_URL, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "github-mcp-oauth" },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return {
      kind: "transient",
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
      networkError: name === "TimeoutError" ? `timeout after ${VERIFY_TIMEOUT_MS}ms` : name,
    };
  }

  if (res.ok) {
    try {
      const user = (await res.json()) as { login?: unknown };
      if (typeof user.login === "string" && user.login) return { kind: "ok", login: user.login };
    } catch {
      // Unreadable 2xx body: GitHub-side problem, not the token's fault.
    }
    return { kind: "transient", retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS, ...diagnosticsFrom(res) };
  }

  if (res.status >= 500 || (await isRateLimited(res))) {
    return { kind: "transient", retryAfterSeconds: retryAfterFrom(res, nowMs()), ...diagnosticsFrom(res) };
  }

  return { kind: "rejected", ...diagnosticsFrom(res) };
}

export function serviceUnavailable(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "GitHub could not verify the token right now. Retry shortly; no need to reconnect.",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    }
  );
}
