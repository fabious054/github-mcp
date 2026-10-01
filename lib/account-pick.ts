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

export type RepoAccess = "write" | "read" | "none";

export type AccountAccess<T> = { candidate: T; login: string; access: RepoAccess };

export type AccountPick<T> =
  | { kind: "picked"; candidate: T; login: string }
  | { kind: "ambiguous"; options: AccountAccess<T>[] }
  | { kind: "no-access" };

// Maps the `permissions` object of GitHub's `GET /repos/{owner}/{repo}` to an
// access level. `push`, `maintain` and `admin` all allow writing.
export function accessFromPermissions(
  permissions: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean } | undefined
): RepoAccess {
  if (!permissions) return "read";
  if (permissions.admin || permissions.maintain || permissions.push) return "write";
  return "read";
}

export function pickAccount<T>(
  results: AccountAccess<T>[],
  primaryLogin: string | undefined
): AccountPick<T> {
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
