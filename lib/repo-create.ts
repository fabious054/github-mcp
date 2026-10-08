// Decides which linked account creates a new repository for `create_repo`.
// See docs/adr/0012-create-repo.md.
//
// The repository does not exist yet, so the write-access detection used by
// every other tool (ADR 0006) cannot apply. The owner the caller gives
// decides instead:
//
// 1. `owner` is the login of a linked account → that account, personal repo.
// 2. Otherwise `owner` is an organization → the linked account that is an
//    active member of it:
//    - exactly one member  → use it;
//    - several members     → ask for `account`;
//    - none                → refuse (with a hint when the organization
//                            restricts OAuth App access).
//
// As everywhere else (ADR 0007): if an account's token was revoked, or GitHub
// could not answer for an account, nothing is picked.

export type OrgMembership = "member" | "none" | "restricted" | "revoked" | "unavailable";

export type MembershipResult<T> = { candidate: T; login: string; membership: OrgMembership };

export type CreatorPick<T> =
  | { kind: "user"; candidate: T; login: string }
  | { kind: "org"; candidate: T; login: string }
  | { kind: "ambiguous"; logins: string[] }
  | { kind: "no-member"; restricted: boolean }
  | { kind: "revoked"; logins: string[] }
  | { kind: "unavailable"; logins: string[] };

// Returns the candidate whose login is `owner` (case-insensitive), if any.
export function findOwnAccount<T extends { login: string }>(owner: string, candidates: T[]): T | undefined {
  const o = owner.toLowerCase();
  return candidates.find((c) => c.login.toLowerCase() === o);
}

// Maps the answer of `GET /user/memberships/orgs/{org}` for one account.
// `state` is "active" or "pending"; only an active membership counts.
export function membershipFromState(state: unknown): OrgMembership {
  return state === "active" ? "member" : "none";
}

// Classifies an error from `GET /user/memberships/orgs/{org}`:
// - 401 → revoked; 5xx, 429, rate-limited 403, network error → unavailable;
// - 403 mentioning OAuth App access restrictions → restricted;
// - anything else (404, plain 403) → not a member.
export function membershipFromError(err: unknown): OrgMembership {
  const e = err as { status?: unknown; message?: unknown; response?: { headers?: Record<string, unknown> } };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : "";
  if (status === undefined) return "unavailable";
  if (status === 401) return "revoked";
  if (status >= 500 || status === 429) return "unavailable";
  if (status === 403) {
    const headers = e.response?.headers ?? {};
    if (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined || /rate limit/i.test(message)) {
      return "unavailable";
    }
    if (/OAuth App access restrictions/i.test(message)) return "restricted";
  }
  return "none";
}

// Picks the account for an organization owner from the membership of every
// candidate. Called only when `owner` is not one of the linked logins.
export function pickOrgCreator<T>(results: MembershipResult<T>[]): CreatorPick<T> {
  const revoked = results.filter((r) => r.membership === "revoked");
  if (revoked.length > 0) return { kind: "revoked", logins: revoked.map((r) => r.login) };
  const unavailable = results.filter((r) => r.membership === "unavailable");
  if (unavailable.length > 0) return { kind: "unavailable", logins: unavailable.map((r) => r.login) };

  const members = results.filter((r) => r.membership === "member");
  if (members.length === 1) return { kind: "org", candidate: members[0].candidate, login: members[0].login };
  if (members.length > 1) return { kind: "ambiguous", logins: members.map((m) => m.login) };
  return { kind: "no-member", restricted: results.some((r) => r.membership === "restricted") };
}

// Message returned when the caller did not say whether the repository is
// private: nothing is created, and the client is told to ask the user.
export const VISIBILITY_REQUIRED_MESSAGE =
  "Nothing was created: 'private' was not given. Ask the user whether the repository should be private or public, then call create_repo again with private: true or private: false.";

// Text of a successful creation, including how to make the first commit:
// an empty repository rejects the Git Data API until it has one commit.
export function createdMessage(r: {
  fullName: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string;
  account: string;
}): string {
  return [
    `Created ${r.isPrivate ? "private" : "public"} repository '${r.fullName}' with account '${r.account}'.`,
    `URL: ${r.url}`,
    `Default branch: '${r.defaultBranch}' — it does not exist yet, the repository is empty.`,
    `Next step: make the first commit with commit_file on branch '${r.defaultBranch}' (it creates the branch).`,
    "commit_tree, create_tree, create_blob, create_commit and create_branch only work after that first commit.",
  ].join("\n");
}

// Turns a GitHub error from the create call into a readable message.
export function createErrorMessage(owner: string, name: string, account: string, err: unknown): string {
  const e = err as { status?: unknown; message?: unknown; response?: { data?: { errors?: { message?: string }[] } } };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const details = (e?.response?.data?.errors ?? [])
    .map((x) => x?.message)
    .filter((m): m is string => typeof m === "string" && m.length > 0);
  const base = typeof e?.message === "string" ? e.message : "unknown error";
  if (status === 422) {
    return `GitHub refused to create '${owner}/${name}': ${details.length ? details.join("; ") : base}. Nothing was created.`;
  }
  if (status === 403 || status === 404) {
    return `Account '${account}' is not allowed to create repositories in '${owner}' (organization settings, or the organization restricts OAuth App access). Nothing was created. GitHub said: ${base}`;
  }
  return `Could not create '${owner}/${name}' with account '${account}': ${base}`;
}
