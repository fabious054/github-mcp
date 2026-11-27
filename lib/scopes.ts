// OAuth scopes requested from GitHub, in one place (ADR 0019, ADR 0022, ADR 0023).
// `project` (added 2026-11-27, issue #104) lets the board tools read and
// change GitHub Projects. `admin:org` (added 2026-11-27, issue #123) replaces
// `read:org`, which it includes, so the issue type tools can change an
// organization's issue types. `workflow` (added 2026-11-27, issue #131) lets
// the commit tools create and change files under .github/workflows/.
// GITHUB_OAUTH_SCOPES still overrides the default for self-hosted deployments.
export const DEFAULT_OAUTH_SCOPES = "repo admin:org project workflow";

export function oauthScopes(): string {
  return process.env.GITHUB_OAUTH_SCOPES || DEFAULT_OAUTH_SCOPES;
}
