// One GitHub token per GitHub user, shared by every place that user connects
// from. See docs/adr/0015-one-token-per-user.md.
//
// GitHub keeps at most 10 OAuth tokens per user, app and scope; each token
// past that revokes another one (`max_for_app`). Every Claude surface (web,
// desktop, mobile, cloud and scheduled sessions) logs in on its own, so
// without this a login in one place silently kills a session in another.
//
// On each login the server checks the token it already stores for that
// GitHub user. If it is still valid and covers the requested scopes, it hands
// that one out and revokes the token GitHub just created, so the user stays at
// a single live token. Anything uncertain (GitHub or the database not
// answering) falls back to the new token without storing or revoking — a login
// never fails because of this.
//
// Tokens are keyed by GitHub's numeric user id, never by login (logins can be
// renamed), so one user's token is never returned to anyone else.

import { encryptJson, decryptJson } from "./oauth";
import { getDb } from "./mongo";

export type StoredToken = { token: string; scopes: string[] };

export type TokenCheck =
  | { kind: "ok"; userId: number; scopes: string[] }
  | { kind: "rejected" }
  | { kind: "transient" };

export type RevokeResult = { outcome: "revoked" | "already-invalid" | "failed"; reason?: string };

export type ReuseDeps = {
  getStored: (userId: number) => Promise<StoredToken | undefined>;
  store: (userId: number, login: string, token: string, scopes: string[]) => Promise<void>;
  check: (token: string) => Promise<TokenCheck>;
  revoke: (token: string) => Promise<RevokeResult>;
  audit: (event: "oauth.token.reused" | "oauth.token.stored", fields: Record<string, string | number | undefined>) => void;
};

export type NewLogin = {
  token: string;
  scopes: string[];
  user?: { id: number; login: string };
};

export type SessionToken = { token: string; scopes: string[]; reused: boolean };

// "read:org,repo" / "repo read:org" → ["read:org", "repo"]
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

// Whether `have` grants everything in `want`. GitHub's `repo` scope includes
// its `repo:*` and `public_repo` sub-scopes; `admin:org` / `write:org` include
// `read:org`.
export function coversScopes(have: string[], want: string[]): boolean {
  const h = new Set(have);
  return want.every((w) => {
    if (h.has(w)) return true;
    if ((w.startsWith("repo:") || w === "public_repo") && h.has("repo")) return true;
    if (w === "read:org" && (h.has("write:org") || h.has("admin:org"))) return true;
    return false;
  });
}

export async function chooseSessionToken(login: NewLogin, deps: ReuseDeps): Promise<SessionToken> {
  const fresh: SessionToken = { token: login.token, scopes: login.scopes, reused: false };
  const user = login.user;
  if (!user) return fresh; // could not identify the user: nothing to match against

  let stored: StoredToken | undefined;
  try {
    stored = await deps.getStored(user.id);
  } catch {
    return fresh; // database unavailable: fail open
  }

  const keepNew = async (reason: string) => {
    try {
      await deps.store(user.id, user.login, login.token, login.scopes);
      deps.audit("oauth.token.stored", { githubLogin: user.login, reason });
    } catch {
      // database unavailable: the login still works with the new token
    }
    return fresh;
  };

  if (!stored) return keepNew("first-login");

  const check = await deps.check(stored.token);
  if (check.kind === "transient") return fresh; // can't tell: change nothing
  if (check.kind === "rejected") return keepNew("stored-token-invalid");
  if (check.userId !== user.id) return keepNew("stored-token-other-user");
  if (!coversScopes(check.scopes, login.scopes)) return keepNew("scopes-changed");

  // The stored token is valid for this user and covers the request: reuse it
  // and drop the one GitHub just created, so the user keeps a single token.
  const revocation = await deps.revoke(login.token);
  deps.audit("oauth.token.reused", {
    githubLogin: user.login,
    revocation: revocation.outcome,
    reason: revocation.reason,
  });
  return { token: stored.token, scopes: check.scopes, reused: true };
}

// ---------- real dependencies (MongoDB + GitHub) ----------

type PrimaryTokenDoc = {
  githubUserId: number;
  login: string;
  encryptedToken: string;
  scopes: string[];
  updatedAt: string;
};

const COLLECTION = "primary_tokens";

export async function getStoredPrimaryToken(userId: number): Promise<StoredToken | undefined> {
  const db = await getDb();
  const doc = await db.collection<PrimaryTokenDoc>(COLLECTION).findOne({ githubUserId: userId });
  if (!doc) return undefined;
  const { token } = decryptJson<{ token: string }>(doc.encryptedToken);
  return { token, scopes: doc.scopes ?? [] };
}

export async function storePrimaryToken(userId: number, login: string, token: string, scopes: string[]): Promise<void> {
  const db = await getDb();
  await db.collection<PrimaryTokenDoc>(COLLECTION).updateOne(
    { githubUserId: userId },
    {
      $set: {
        githubUserId: userId,
        login,
        encryptedToken: encryptJson({ token }),
        scopes,
        updatedAt: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// GET /user with the token: who it belongs to and which scopes it has.
export async function checkGithubToken(token: string, fetchImpl: FetchLike = fetch): Promise<TokenCheck> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "github-mcp-oauth" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { kind: "transient" };
  }
  if (res.status === 401) return { kind: "rejected" };
  if (!res.ok) return { kind: "transient" };
  try {
    const user = (await res.json()) as { id?: unknown };
    if (typeof user.id !== "number") return { kind: "transient" };
    return { kind: "ok", userId: user.id, scopes: parseScopes(res.headers.get("x-oauth-scopes")) };
  } catch {
    return { kind: "transient" };
  }
}
