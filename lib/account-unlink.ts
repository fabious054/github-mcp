// `unlink_account`: removes an additional account linked to the caller's
// primary account, and revokes that link's token on GitHub.
// See docs/adr/0013-unlink-account.md.
//
// Built for a shared instance used by many people and companies:
// - the primary login always comes from the verified token of the request,
//   never from a tool argument, so a caller can only touch their own links;
// - a link is the pair {primaryLogin, login}: other users who linked the same
//   GitHub account keep their own link and their own token;
// - the primary account itself can never be unlinked;
// - revoking the token on GitHub is best-effort and never blocks the unlink.

export type RevokeOutcome =
  | { outcome: "revoked" }
  | { outcome: "already-invalid" }
  | { outcome: "failed"; reason: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REVOKE_TIMEOUT_MS = 5000;

// Revokes ONE OAuth token of this app on GitHub
// (DELETE /applications/{client_id}/token). Only that token is affected: the
// user's authorization and their other tokens stay valid. Never throws.
export async function revokeOAuthToken(
  token: string,
  clientId: string | undefined,
  clientSecret: string | undefined,
  fetchImpl: FetchLike = fetch
): Promise<RevokeOutcome> {
  if (!clientId || !clientSecret) {
    return { outcome: "failed", reason: "the server's OAuth app credentials are not configured" };
  }
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "github-mcp-oauth",
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { outcome: "failed", reason: name === "TimeoutError" ? "GitHub did not answer in time" : `network error (${name})` };
  }
  if (res.status === 204) return { outcome: "revoked" };
  // GitHub answers 404 when the token is not a valid token of this app
  // (already revoked or expired).
  if (res.status === 404) return { outcome: "already-invalid" };
  return { outcome: "failed", reason: `GitHub answered ${res.status}` };
}

export type UnlinkDeps = {
  getLinkedLogins: (primaryLogin: string) => Promise<{ login: string; token: string }[]>;
  deleteLink: (primaryLogin: string, login: string) => Promise<boolean>;
  revoke: (token: string) => Promise<RevokeOutcome>;
  audit: (fields: { primaryLogin: string; linkedLogin: string; revocation: string; reason?: string }) => void;
};

export type UnlinkResult = { ok: true; text: string } | { ok: false; text: string };

export async function unlinkLinkedAccount(
  primaryLogin: string | undefined,
  account: string,
  deps: UnlinkDeps
): Promise<UnlinkResult> {
  if (!primaryLogin) {
    return { ok: false, text: "Could not identify your primary account (GitHub login missing from the session). Nothing was changed." };
  }
  const target = account.trim();
  if (target.toLowerCase() === primaryLogin.toLowerCase()) {
    return {
      ok: false,
      text: `'${primaryLogin}' is your primary account and cannot be unlinked. To stop using it, disconnect the connector in Claude instead. Nothing was changed.`,
    };
  }

  const linked = await deps.getLinkedLogins(primaryLogin);
  const match = linked.find((a) => a.login.toLowerCase() === target.toLowerCase());
  if (!match) {
    return {
      ok: false,
      text: `'${target}' is not linked to your session.${
        linked.length
          ? ` Linked accounts: ${linked.map((a) => a.login).join(", ")}.`
          : " You have no additional accounts linked."
      } Nothing was changed.`,
    };
  }

  const removed = await deps.deleteLink(primaryLogin, match.login);
  if (!removed) {
    return { ok: false, text: `'${match.login}' was already unlinked (it was not found when removing it). Nothing else was changed.` };
  }

  const revocation = await deps.revoke(match.token);
  deps.audit({
    primaryLogin,
    linkedLogin: match.login,
    revocation: revocation.outcome,
    reason: revocation.outcome === "failed" ? revocation.reason : undefined,
  });

  const revokeLine =
    revocation.outcome === "revoked"
      ? "Its token was revoked on GitHub."
      : revocation.outcome === "already-invalid"
        ? "Its token was already invalid on GitHub (revoked or expired), so there was nothing to revoke."
        : `Its token could not be revoked on GitHub (${revocation.reason}); it is no longer stored here. To revoke it yourself, sign in to GitHub as '${match.login}' → Settings → Applications.`;

  const remaining = linked.filter((a) => a !== match).map((a) => a.login);
  return {
    ok: true,
    text: [
      `Unlinked '${match.login}' from your session.`,
      revokeLine,
      `Accounts now in your session: ${[`${primaryLogin} [primary]`, ...remaining].join(", ")}.`,
    ].join("\n"),
  };
}
