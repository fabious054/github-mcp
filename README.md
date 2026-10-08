# GitHub MCP

*[Leia em português](./README.pt-br.md)*

An MCP server that gives Claude real access to GitHub: create and delete
branches, commit, open, edit and comment on PRs, list, create, read and comment
on issues, read files, and search code.

## Connect to this instance

There's already a running instance of this server — you don't need to set up
or deploy anything to use it.

1. In Claude, add a **custom connector (remote MCP)** pointing to:
   ```
   https://github-mcp-seven.vercel.app/mcp
   ```
2. Claude opens a real GitHub "Authorize" screen. Log in with your own
   GitHub account — no manual token to generate, nothing to configure.
3. That's it. Every tool call runs with your own GitHub access — never a
   shared account.

Want to use more than one GitHub account from the same connector (e.g. a
personal account and an organization account)? Call the `link_account` tool
— it walks you through linking additional accounts, and the server then
figures out on its own which linked account to use for each repository you
target. See [Available tools](#available-tools) below.

> Building or maintaining this server, or want to run your own separate
> instance of it? See [`docs/self-hosting.md`](./docs/self-hosting.md) for
> creating your own GitHub OAuth App, environment variables, and deploying
> on Vercel.

## Available tools

- `create_branch` — creates a branch from another one
- `delete_branch` — deletes a branch; refuses the default branch, protected branches and branches with an open PR
- `commit_file` — creates/updates a file with a commit message (full content, one file per call)
- `patch_file` — applies a unified diff to an existing file on a branch, without resending the whole content
- `get_branch_head` — reads the full (40-character) SHA of the commit a branch points to
- `open_pr` — opens a Pull Request
- `update_pr` — edits a PR's title, description or target branch, and closes or reopens it (never merges)
- `list_prs` — lists PRs
- `comment_pr` — comments on a PR
- `list_issues` — lists issues (board tasks)
- `get_issue` — reads an issue in full: description and every comment, in order
- `create_issue` — creates an issue
- `comment_issue` — comments on an issue (e.g. final QA report)
- `read_file` — reads a file's content on a branch (`branch`, or `ref` for a branch, tag or commit; default `main`)
- `search_code` — searches code in the repository
- `whoami` — shows which identity/account is being used in the current session
- `link_account` — links an ADDITIONAL GitHub account to your session
- `list_accounts` — lists the accounts linked to your session
- `unlink_account` — removes an additional account from your session and revokes its token on GitHub (never your primary account)
- `list_repos_by_account` — lists the repositories a specific linked account can access
- `create_repo` — creates an empty repository for you or an organization; you always choose private or public (there is no tool to delete one)

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
- `get_tree` — reads a tree (lists files and blob SHAs of a commit/branch; select it with `branch` or `tree_sha`, default `main`), useful for finding an already-existing blob's SHA and reusing it
- `get_branch_head` — reads a branch's current full commit SHA, required as `parents` for `create_commit` (GitHub requires the full SHA, not the abbreviated one `commit_file`/`patch_file`/`commit_tree` print in their response)
- `create_tree` — builds a new tree from a base tree, applying entries that bring `content` (new blob), `patch` (unified diff over the path's current content in the base tree), or `sha` (reused blob, or `null` to remove the path)
- `create_commit` — creates a commit from a tree and parent commit(s) (`parents` requires the full SHA — use `get_branch_head` to get it)
- `update_ref` — points a branch to a specific commit (not a fast-forward by default, unless `force: true`)
- `commit_tree` — **convenience tool**: orchestrates blob → tree → commit → update_ref in a single call, taking `branch`, `message` and a list of `files` (each with `content`, `patch` or `sha`). It's the direct replacement for "several `commit_file` calls, each with the full content" when the change touches several files, edits only part of some of them, or can reuse an existing one.

`commit_file`, `patch_file` and `commit_tree` print the commit's full SHA in
their response (in addition to the abbreviated one) — useful for chaining
with `create_commit` without an extra call to `get_branch_head`.

All tools accept an optional `owner`/`repo`. If you don't provide `owner`,
the server tries to use your own GitHub user as the default (but `repo`
still needs to be given).

Tools reject arguments they don't know: a misspelled or unsupported argument
returns an error naming it, instead of being silently ignored (see
[ADR 0008](./docs/adr/0008-strict-tool-arguments.md)).

## Linking multiple accounts to the same session

A single person can link more than one GitHub account to the same
connector, through successive logins — no need to add the connector twice
or juggle separate connections:

1. Call the `link_account` tool. It returns a one-time authorization link
   (valid for 10 minutes).
2. Open that link in a browser and authorize with the **different** GitHub
   account you want to add. The primary account you're already connected
   with never changes.
3. From then on, every repo-scoped tool picks the right account
   automatically: if only your primary account is linked, nothing changes;
   if more than one account is linked, the server checks what each one can
   do on the target repository and uses the only account that can **write**
   to it. For a repository none of them can write to (e.g. someone else's
   public repo), it uses your primary account. It asks you to repeat the
   call with an explicit `account` only when more than one account can
   write to the repository (see
   [ADR 0006](./docs/adr/0006-account-selection-by-write-access.md)).
4. `list_accounts` lists every account linked to your session, with the
   status of each linked account's authorization, and
   `list_repos_by_account` lists what a specific one can access — handy to
   check before a call, or to figure out which `account` to pass when the
   ambiguity error above happens.

If GitHub stops accepting a linked account's authorization (you revoked it,
or GitHub expired it), the server does not quietly fall back to another
account: calls that rely on automatic detection stop and tell you which
account to re-link with `link_account`, and `list_accounts` marks it as
revoked. You can still pass `account` explicitly in the meantime (see
[ADR 0007](./docs/adr/0007-revoked-linked-accounts.md)).

No longer using a linked account? `unlink_account` removes it from your
session and revokes its token on GitHub. It only ever touches accounts
linked to your own primary account — other people who linked the same
GitHub account keep theirs (see
[ADR 0013](./docs/adr/0013-unlink-account.md)).

## Rate limiting

Every public endpoint is rate limited (Redis-backed, see
[ADR 0003](./docs/adr/0003-redis-rate-limiting.md)). Over the limit, the
server answers `429 Too Many Requests` with a `Retry-After` header.

| Endpoint | Limit | Keyed by |
|---|---|---|
| `/register`, `/token`, `/authorize` | 20 requests / 5 min | client IP |
| `/token`, token renewal (`refresh_token`) | 30 renewals / 5 min | hash of the GitHub token |
| `/link-account`, `/link-callback`, `/callback` | 30 requests / 5 min | client IP |
| `/mcp` (OAuth mode) | 60 requests / min (bursts allowed) | hash of the bearer token |
| `/mcp` (legacy mode) | 60 requests / min (bursts allowed) | client IP |
| `/mcp`, invalid tokens | 20 rejected tokens / 5 min | client IP |

Normal use stays far below these limits. If Redis is unreachable, requests
are allowed (fail-open) so an outage never blocks login or tool calls.

If GitHub itself can't verify your token for a moment (5xx, rate limit,
network error), `/mcp` answers `503` with `Retry-After` instead of `401`, so
Claude retries and you are not asked to reconnect. Only a token GitHub
actually rejects counts as invalid (see
[ADR 0004](./docs/adr/0004-transient-github-errors-503.md)).

## Staying connected

Your connection stays up however long you leave the connector unused: every
token is announced with a 10-year lifetime (plus a refresh token as a
fallback), so Claude never considers it expired. You only log in again if you
revoke the authorization on GitHub (Settings → Applications) — and that takes
effect on your very next tool call, because every call is checked with
GitHub. If GitHub is briefly unavailable during a
renewal, it is retried instead of logging you out (see
[ADR 0011](./docs/adr/0011-stateless-refresh-tokens.md) and
[ADR 0014](./docs/adr/0014-long-token-lifetime.md)).

## Security

- No token is ever committed to this repository.
- The server never stores your primary account's token — it's forwarded
  from GitHub to Claude on each exchange, and revalidated against the
  GitHub API on every tool call.
- `whoami` never returns tokens, only identifies the account/session.
- A linked (non-primary) account's token is the only thing this server
  persists at all, and it's always stored encrypted (AES-256-GCM) — never
  in plaintext.
- Authentication and rate-limit events are written to the server logs for
  auditing, without any token — see
  [`SECURITY.md`](./SECURITY.md#audit-logging).

Full security policy, threat model, and how to report a vulnerability:
[`SECURITY.md`](./SECURITY.md).

## Architecture decisions

Notable design decisions live as ADRs in [`docs/adr/`](./docs/adr/):

- [0001 — Git Data API for large commits](./docs/adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./docs/adr/0002-multi-account-oauth-linking.md)
- [0003 — Redis-backed rate limiting](./docs/adr/0003-redis-rate-limiting.md)
- [0004 — Transient GitHub errors answered with 503, not 401](./docs/adr/0004-transient-github-errors-503.md)
- [0005 — Migrate to mcp-handler 2 (MCP SDK v2)](./docs/adr/0005-migrate-to-mcp-handler-2.md)
- [0006 — Pick the linked account by write access](./docs/adr/0006-account-selection-by-write-access.md)
- [0007 — Never pick an account while a linked one is revoked](./docs/adr/0007-revoked-linked-accounts.md)
- [0008 — Reject unknown tool arguments; `branch` in the read tools](./docs/adr/0008-strict-tool-arguments.md)
- [0009 — `update_pr` scope: edit, retarget, close/reopen](./docs/adr/0009-update-pr-scope.md)
- [0010 — `delete_branch` guards: default, protected, open PRs](./docs/adr/0010-delete-branch-guards.md)
- [0011 — Stateless refresh tokens so Claude renews silently](./docs/adr/0011-stateless-refresh-tokens.md)
- [0012 — `create_repo`: account by owner, empty, no default visibility](./docs/adr/0012-create-repo.md)
- [0013 — `unlink_account`: own links only, token revoked](./docs/adr/0013-unlink-account.md)
- [0014 — Access token lifetime: 8 hours → 10 years (never expires in practice)](./docs/adr/0014-long-token-lifetime.md)

## License

[MIT](./LICENSE)
