# GitHub MCP

*[Leia em português](./README.pt-br.md)*

An MCP server that gives Claude real access to GitHub: create branches, commit,
open/comment on PRs, list/create/comment on issues, read files, and search
code.

Supports two ways to connect accounts:

- **OAuth (recommended)** — anyone who adds this connector in Claude logs in
  with their own GitHub account, on the spot, with no manual token
  generation. Everyone uses their own account, dynamically — a real
  "multi-user" mode. It also supports linking more than one GitHub account
  to the same person, with automatic per-repository detection.
- **Fixed account(s) via environment variable (legacy)** — simpler to set
  up, but the token(s) are fixed on Vercel and only whoever you configured
  has access.

The same deploy works in both modes — which one applies depends only on
which environment variables you set (see below). If `GITHUB_OAUTH_CLIENT_ID`
is set, OAuth takes priority.

## Available tools

- `create_branch` — creates a branch from another one
- `commit_file` — creates/updates a file with a commit message (full content, one file per call)
- `patch_file` — applies a unified diff to an existing file on a branch, without resending the whole content
- `get_branch_head` — reads the full (40-character) SHA of the commit a branch points to
- `open_pr` — opens a Pull Request
- `list_prs` — lists PRs
- `comment_pr` — comments on a PR
- `list_issues` — lists issues (board tasks)
- `create_issue` — creates an issue
- `comment_issue` — comments on an issue (e.g. final QA report)
- `read_file` — reads a file's content
- `search_code` — searches code in the repository
- `whoami` — shows which identity/account is being used in the current session
- `link_account` — links an ADDITIONAL GitHub account to your session (OAuth mode only)
- `list_accounts` — lists the accounts linked to your session (OAuth mode only)
- `list_repos_by_account` — lists the repositories a specific linked account can access (OAuth mode only)

### Editing a small chunk of a large file

`commit_file` always requires the file's full content, even when only one
line changed. `patch_file` solves that for the single-file case: it takes a
unified diff (`diff -u` or `git diff` format), fetches the file's current
content on the branch, applies the patch, and commits the result — never
needing the file's full content in the call.

### Git Data API — large or multi-file commits

For changes spread across many files (not just one), these tools expose the
Git data model directly (blob → tree → commit → ref), letting you reuse an
already-existing blob by SHA (a file that hasn't changed between commits
never needs to be resent) and group several files into a single atomic
commit. Each file entry also accepts `patch` — the same unified-diff
mechanism as `patch_file`, but inside a multi-file commit:

- `create_blob` — creates a blob (raw content) and returns its SHA
- `get_tree` — reads a tree (lists files and blob SHAs of a commit/branch), useful for finding an already-existing blob's SHA and reusing it
- `get_branch_head` — reads a branch's current full commit SHA, required as `parents` for `create_commit` (GitHub requires the full SHA, not the abbreviated one `commit_file`/`patch_file`/`commit_tree` print in their response)
- `create_tree` — builds a new tree from a base tree, applying entries that bring `content` (new blob), `patch` (unified diff over the path's current content in the base tree), or `sha` (reused blob, or `null` to remove the path)
- `create_commit` — creates a commit from a tree and parent commit(s) (`parents` requires the full SHA — use `get_branch_head` to get it)
- `update_ref` — points a branch to a specific commit (not a fast-forward by default, unless `force: true`)
- `commit_tree` — **convenience tool**: orchestrates blob → tree → commit → update_ref in a single call, taking `branch`, `message` and a list of `files` (each with `content`, `patch` or `sha`). It's the direct replacement for "several `commit_file` calls, each with the full content" when the change touches several files, edits only part of some of them, or can reuse an existing one.

`commit_file`, `patch_file` and `commit_tree` now print the commit's full
SHA in their response (in addition to the abbreviated one) — useful for
chaining with `create_commit` without an extra call to `get_branch_head`.

All of these operations are stateless — each one is an isolated call to the
GitHub API, with nothing to keep between invocations, which fits well with
the serverless deploy on Vercel. `patch_file` and the `patch` support use
the [`diff`](https://www.npmjs.com/package/diff) library (unified-diff
parsing and application in pure JS, no native dependencies).

All tools accept an optional `owner`/`repo`. In OAuth mode, if you don't
provide `owner`, the server tries to use your own GitHub user as the
default (but `repo` still needs to be given, unless `DEFAULT_REPO` is
configured). In legacy mode, `account`/`owner`/`repo` follow the
`DEFAULT_ACCOUNT`/`DEFAULT_OWNER`/`DEFAULT_REPO` rules described below.

## OAuth mode — how it works

1. Create **one** GitHub OAuth App (github.com → Settings → Developer
   settings → OAuth Apps → New OAuth App), with:
   - Homepage URL: your project's Vercel URL.
   - Authorization callback URL: `https://<your-project>.vercel.app/callback`
     (has to be exactly that — it's fixed, so add it once you know the final
     Vercel URL). GitHub accepts multiple callback URLs on the same OAuth
     App, so you can also add `https://<your-project>.vercel.app/link-callback`
     (needed for multi-account linking, see below).
2. On Vercel, set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` and
   `OAUTH_ENCRYPTION_KEY` (generate it with `openssl rand -base64 32`).
3. Everyone who adds this MCP as a custom connector in Claude is taken to a
   real "Authorize `<your OAuth App>`" screen on GitHub. Once approved,
   Claude calls the tools using that person's token — never a shared token.
4. `whoami` confirms, at any time, which account is authenticated in the
   session.

If the target repository belongs to an organization (e.g. `robozz-br`), the
organization may need to explicitly approve the OAuth App for access to its
private repos (organization Settings → Third-party access).

### Linking multiple accounts to the same session

A single person can link more than one GitHub account to the same
connector, through successive logins — no need to add the connector twice
or juggle separate connections:

1. Call the `link_account` tool. It returns a one-time authorization link
   (valid for 10 minutes).
2. Open that link in a browser and authorize with the **different** GitHub
   account you want to add. GitHub redirects to `/link-callback`, which
   exchanges the code, identifies the account, and stores the link
   (encrypted token) — the primary account never changes.
3. From then on, `resolveRepo` (used by every repo-scoped tool) picks the
   right account automatically: if only the primary account is linked,
   nothing changes; if more than one account is linked, it checks which
   one(s) have access to the target repository and uses the one match
   automatically, or asks you to repeat the call with an explicit `account`
   when more than one matches.
4. `list_accounts` lists every account linked to the session, and
   `list_repos_by_account` lists what a specific one can access — handy to
   check before a call, or to figure out which `account` to pass when the
   ambiguity error above happens.

This requires `MONGODB_URI` to be set (see below) — it's the only piece of
state this otherwise-stateless server keeps, and it stores only the account
link itself, with the linked account's token always encrypted (see
Security).

### How OAuth is implemented (no database)

This server runs in stateless functions on Vercel, so instead of storing
sessions/codes in a database, everything the OAuth flow needs to remember
travels **encrypted (AES-256-GCM)** inside the parameters themselves — the
`client_id` returned by `/register`, the `state` used with GitHub, and the
`code` exchanged at `/token`. Only whoever holds `OAUTH_ENCRYPTION_KEY` can
generate or read these blobs.

Known limitation: since there's no database, an authorization `code` isn't
invalidated after first use — it simply expires on its own (2 minutes).
That's acceptable for this use case (the code only ever exists inside an
HTTPS redirect between GitHub and Claude), but it's a difference from a
"full" Authorization Server with storage — worth knowing.

The token Claude receives **is the person's own GitHub access token** — the
server never stores or logs that token, it only forwards it.

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

## Connecting in Claude

In Claude, add a **custom connector (remote MCP)** pointing to
`https://<your-project>.vercel.app/mcp`.

- In OAuth mode, Claude automatically detects that the server requires
  authentication and opens the GitHub login screen for each person who
  connects.
- In legacy mode, Claude doesn't ask for any authentication — the token is
  already fixed on Vercel.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in the variables for the mode you're using
npm run dev
```

The local MCP server comes up at `http://localhost:3000/mcp`.

## Security

- No token is ever committed — tokens (fixed or OAuth) only live in
  environment variables / pass through the server without being persisted.
- In OAuth mode, the server never stores anyone's token — it's forwarded
  from GitHub to Claude on each exchange, and revalidated against the
  GitHub API on every tool call.
- `whoami` never returns tokens, only identifies the account/session.
- In OAuth mode, a linked (non-primary) account's token is the only thing
  this server persists at all, and it's always stored encrypted
  (AES-256-GCM) in MongoDB — never in plaintext.
- In legacy mode, using scoped (fine-grained) tokens, limited to only the
  repos this MCP should touch, is recommended.
- In legacy mode, this server has no authentication of its own — anyone
  with the URL can call it, with access to every configured account. Use
  OAuth mode if that's a concern.

## Architecture decisions

Notable design decisions live as ADRs in [`docs/adr/`](./docs/adr/):

- [0001 — Git Data API for large commits](./docs/adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./docs/adr/0002-multi-account-oauth-linking.md)
