# Security policy

*[Leia em português](./SECURITY.pt-br.md)*

This document describes this server's security model, what was checked
before making the repository public, and how to report a vulnerability.

## Access model

- Everyone who connects authenticates with their **own** GitHub account
  through a real OAuth "Authorize" flow — there is no manual token to
  generate and no shared credential.
- The server never stores the primary account's token. It is forwarded from
  GitHub to Claude on each exchange and revalidated against the GitHub API
  on every tool call — nothing is written to disk or to a database.
- The only thing this server persists at all is a **linked (non-primary)
  account's** token (the `link_account` feature), and it is always stored
  encrypted (AES-256-GCM), never in plaintext. See
  [ADR 0002](./docs/adr/0002-multi-account-oauth-linking.md) for the design.
- `whoami` never returns a token, only the identity/session in use.
- Legacy mode (fixed `GITHUB_TOKEN`/`GITHUB_ACCOUNTS`, no OAuth) has no
  authentication of its own — anyone with the URL can call it, with access
  to every configured account. It exists for self-hosted, single-operator
  setups; OAuth mode is recommended for anything shared. See
  [`docs/self-hosting.md`](./docs/self-hosting.md).

## What was checked before opening this repository

- `.gitignore` excludes `.env`, `.env.local` and `.vercel` — no secret file
  is tracked.
- The current codebase was checked for common secret patterns (GitHub
  token prefixes, MongoDB connection strings, private key headers) with
  none found.

**Known limitation:** that check covers the current default-branch content
only, not the full git history. It rules out a secret being present today;
it does not prove one was never committed and later removed. If you ever
suspect a credential was exposed at any point, rotate it — regenerating
`OAUTH_ENCRYPTION_KEY` and the GitHub OAuth App's client secret costs
nothing and closes that door regardless of history.

## Reporting a vulnerability

If you find a security issue, please open a GitHub issue on this repository
marked clearly as a security report, or reach out to the maintainer
directly instead of disclosing it publicly first. Reports are taken
seriously and addressed as a priority.

## For self-hosted instances

Anyone running their own instance (see
[`docs/self-hosting.md`](./docs/self-hosting.md)) is responsible for their
own secrets: generate a fresh `OAUTH_ENCRYPTION_KEY` (never reuse one from
another instance), keep `MONGODB_URI` out of version control, and register
your own GitHub OAuth App rather than reusing anyone else's credentials.
