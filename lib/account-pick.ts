// Picks which linked account to use for a repository when the caller did not
// pass 'account' and more than one account is linked to the session.
// See docs/adr/0006-account-selection-by-write-access.md.
//
// Every account can read a public repository, so "has access" alone would
// make every public repo ambiguous. The decision is based on the permission
// level GitHub reports for each account instead:
//
// 1. Exactly one account can write  → use it.
// 2. More than one can write        → ask (real ambiguity).
// 3. None can write (read-only):
//    - exactly one can read         → use it;
//    - several can read             → the primary if it is among them,
//                                     otherwise ask.
// 4. None can read                  → no access.
//
// Before any of that (ADR 0007): if an account's token was revoked, or GitHub
// could not answer for an account, the server does not pick at all — it never
// decides on incomplete information.

export type RepoAccess = "write" | "read" | "none" | "revoked" | "unavailable";

export type AccountAccess<T> = { candidate: T; login: string; access: RepoAccess };

export type AccountPick<T> =
  | { kind: "picked"; candidate: T; login: string }
  | { kind: "ambiguous"; options: AccountAccess<T>[] }
  | { kind: "no-access" }
  | { kind: "revoked"; logins: string[] }
  | { kind: "unavailable"; logins: string[] };

// Maps the `permissions` object of GitHub's `GET /repos/{owner}/{repo}` to an
// access level. `push`, `maintain` and `admin` all allow writing.
export function accessFromPermissions(
  permissions: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean } | undefined
): RepoAccess {
  if (!permissions) return "read";
  if (permissions.admin || permissions.maintain || permissions.push) return "write";
  return "read";
}

// Classifies an error thrown by Octokit's `repos.get` for one account:
// - 401 → the token is no longer valid (revoked or expired);
// - 5xx, 429, a rate-limited 403, or no HTTP status at all (network error) →
//   GitHub could not answer right now;
// - anything else (404, a plain 403) → the account has no access.
export function accessFromError(err: unknown): RepoAccess {
  const e = err as { status?: unknown; message?: unknown; response?: { headers?: Record<string, unknown> } };
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === undefined) return "unavailable";
  if (status === 401) return "revoked";
  if (status >= 500 || status === 429) return "unavailable";
  if (status === 403) {
    const headers = e.response?.headers ?? {};
    const message = typeof e.message === "string" ? e.message : "";
    if (
      headers["x-ratelimit-remaining"] === "0" ||
      headers["retry-after"] !== undefined ||
      /rate limit/i.test(message)
    ) {
      return "unavailable";
    }
  }
  return "none";
}

export function pickAccount<T>(
  results: AccountAccess<T>[],
  primaryLogin: string | undefined
): AccountPick<T> {
  const revoked = results.filter((r) => r.access === "revoked");
  if (revoked.length > 0) return { kind: "revoked", logins: revoked.map((r) => r.login) };
  const unavailable = results.filter((r) => r.access === "unavailable");
  if (unavailable.length > 0) return { kind: "unavailable", logins: unavailable.map((r) => r.login) };

  const writers = results.filter((r) => r.access === "write");
  if (writers.length === 1) return { kind: "picked", candidate: writers[0].candidate, login: writers[0].login };
  if (writers.length > 1) return { kind: "ambiguous", options: writers };

  const readers = results.filter((r) => r.access === "read");
  if (readers.length === 0) return { kind: "no-access" };
  if (readers.length === 1) return { kind: "picked", candidate: readers[0].candidate, login: readers[0].login };

  const primary = primaryLogin
    ? readers.find((r) => r.login.toLowerCase() === primaryLogin.toLowerCase())
    : undefined;
  if (primary) return { kind: "picked", candidate: primary.candidate, login: primary.login };
  return { kind: "ambiguous", options: readers };
}
