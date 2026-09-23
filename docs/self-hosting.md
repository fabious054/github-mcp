# Self-hosting

*[Leia em português](./self-hosting.pt-br.md)*

This document is for developers working on this repository, or anyone who
wants to run their own separate instance of this MCP server. If you just
want to use the existing hosted instance, see the main
[`README.md`](../README.md) instead — no setup needed.

The same codebase supports two authentication modes, decided purely by which
environment variables are set. If `GITHUB_OAUTH_CLIENT_ID` is set, OAuth
takes priority.

## OAuth mode (recommended)

Anyone who adds this connector in Claude logs in with their own GitHub
account, on the spot, with no manual token generation. Everyone uses their
own account, dynamically — a real "multi-user" mode. It also supports
linking more than one GitHub account to the same person (see `link_account`
in the main README), with automatic per-repository detection.

### Setup

1. Create **one** GitHub OAuth App (github.com → Settings → Developer
   settings → OAuth Apps → New OAuth App), with:
   - Homepage URL: your project's Vercel URL.
   - Authorization callback URL: `https://<your-project>.vercel.app/callback`
     (has to be exactly that — it's fixed, so add it once you know the final
     Vercel URL). GitHub accepts multiple callback URLs on the same OAuth
     App, so also add `https://<your-project>.vercel.app/link-callback`
     (needed for multi-account linking).
2. On Vercel, set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` and
   `OAUTH_ENCRYPTION_KEY` (generate it with `openssl rand -base64 32`).
3. If you want multi-account linking, also set `MONGODB_URI` (see
   "Multi-account linking storage" below). Without it, `link_account` fails
   — everything else in OAuth mode still works fine with a single account
   per person.

Everyone who adds this MCP as a custom connector in Claude is taken to a
real "Authorize `<your OAuth App>`" screen on GitHub. Once approved, Claude
calls the tools using that person's token — never a shared token. `whoami`
confirms, at any time, which account is authenticated in the session.

If the target repository belongs to an organization (e.g. `robozz-br`), the
organization may need to explicitly approve the OAuth App for access to its
private repos (organization Settings → Third-party access).

### How OAuth is implemented (no database for the base flow)

This server runs in stateless functions on Vercel, so instead of storing
sessions/codes in a database, everything the base OAuth flow needs to
remember travels **encrypted (AES-256-GCM)** inside the parameters
themselves — the `client_id` returned by `/register`, the `state` used with
GitHub, and the `code` exchanged at `/token`. Only whoever holds
`OAUTH_ENCRYPTION_KEY` can generate or read these blobs.

Known limitation: since there's no database for this part, an authorization
`code` isn't invalidated after first use — it simply expires on its own (2
minutes). That's acceptable for this use case (the code only ever exists
inside an HTTPS redirect between GitHub and Claude), but it's a difference
from a "full" Authorization Server with storage — worth knowing.

The token Claude receives **is the person's own GitHub access token** — the
server never stores or logs that token, it only forwards it.

### Multi-account linking storage

Linking more than one account to the same primary identity (the
`link_account` tool) is the one part of this server that isn't stateless —
see [ADR 0002](./adr/0002-multi-account-oauth-linking.md) for the full
reasoning. It requires `MONGODB_URI` (a MongoDB Atlas connection string; the
free M0 tier is enough). A linked account's token is stored encrypted
(AES-256-GCM, reusing the same helpers as the base OAuth flow) — never in
plaintext.

## Legacy mode (no OAuth) — single or multiple fixed accounts

If `GITHUB_OAUTH_CLIENT_ID` isn't set, the server automatically falls back
to this mode:

- **Single account**: set `GITHUB_TOKEN` (+ optional
  `DEFAULT_OWNER`/`DEFAULT_REPO`).
- **Multiple pre-configured accounts**: set `GITHUB_ACCOUNTS` (JSON, a map
  of account name → `{token, defaultOwner, defaultRepo, owners}`) and,
  optionally, `DEFAULT_ACCOUNT`. Use the `account` parameter on the tools to
  choose which one to use, or let the server infer it from `owner`.

This mode is simpler but not dynamic: only whoever you manually configured
has access, and switching accounts means editing the environment variable.
This server has no authentication of its own in this mode — anyone with the
URL can call it, with access to every configured account. Use OAuth mode if
that's a concern.

## Deploying on Vercel

1. Push this project to a GitHub repository.
2. On Vercel, import the repository as a new project and run the first
   deploy (to find out the final URL).
3. If using OAuth: create the GitHub OAuth App pointing the callback to
   `https://<your-vercel-url>/callback`, then set the variables
   (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `OAUTH_ENCRYPTION_KEY`, and `MONGODB_URI` if you want multi-account
   linking) and redeploy.
4. If using legacy mode: set `GITHUB_TOKEN` (or `GITHUB_ACCOUNTS`) and
   redeploy.
5. The MCP URL is: `https://<your-project>.vercel.app/mcp`

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the variables for the mode you're using
npm run dev
```

The local MCP server comes up at `http://localhost:3000/mcp`.

## Environment variables reference

See [`.env.example`](../.env.example) for the full list with inline
comments, grouped by mode.

## Architecture decisions

- [0001 — Git Data API for large commits](./adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./adr/0002-multi-account-oauth-linking.md)
