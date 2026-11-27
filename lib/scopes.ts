// OAuth scopes requested from GitHub, in one place (ADR 0019).
// `project` (added 2026-11-27, issue #104) lets the board tools read and
// change GitHub Projects. GITHUB_OAUTH_SCOPES still overrides the default
// for self-hosted deployments.
export const DEFAULT_OAUTH_SCOPES = "repo read:org project";

export function oauthScopes(): string {
  return process.env.GITHUB_OAUTH_SCOPES || DEFAULT_OAUTH_SCOPES;
}
