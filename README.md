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
- `list_pr_comments` — a PR's conversation comments and inline review comments, with their IDs
- `edit_comment` — replaces the text of an issue comment, a PR conversation comment or an inline review comment
- `list_issues` — lists issues (board tasks)
- `get_issue` — reads an issue in full: state and close reason, labels, assignees, milestone, type, parent and sub-issues, description and every comment (with its ID), in order
- `create_issue` — creates an issue, optionally with labels, assignees, milestone, type, parent issue and a project board with initial fields, in one call
- `update_issue` — edits title/body, closes (completed, not planned, duplicate) or reopens, adds/removes labels and assignees, sets milestone and type — one atomic write: see [ADR 0020](./docs/adr/0020-issue-management-graphql.md)
- `add_sub_issue` / `remove_sub_issue` — links or unlinks a sub-issue (also across repositories)
- `comment_issue` — comments on an issue (e.g. final QA report)
- `read_file` — reads a file's content on a branch (`branch`, or `ref` for a branch, tag or commit; default `main`)
- `search_code` — searches code in the repository
- `list_commits` — lists commits with author, dates, message and parents; filters by branch, path, author and date range; `include_stats` adds lines added/removed and changed files per commit (see [ADR 0016](./docs/adr/0016-commit-history-stats.md))
- `get_commit` — reads one commit in full: stats and every changed file, optionally with each file's diff
- `compare_commits` — compares two branches, tags or SHAs: ahead/behind, commits, changed files and totals
- `get_contribution_stats` — your own activity across every repository you can reach, per linked account: totals of commits, PRs, reviews, issues and repositories created, breakdown by repository, contribution calendar; any period (split by year) — see [ADR 0017](./docs/adr/0017-person-level-activity-stats.md)
- `search_commits` — the commits you authored across repositories, per linked account, with optional per-commit stats (default branches only)
- `search_issues_prs` — the PRs and issues you authored, reviewed, merged, were assigned or commented on, across repositories, with totals per role; `include_stats` adds each PR's size
- `get_activity_breakdown` — how much you changed in a period, private repositories included: commits, lines added/removed, files and PRs with their size — totals, by repository and by month; large periods are measured in batches (call again to continue) — see [ADR 0018](./docs/adr/0018-activity-breakdown-batches-and-cache.md)
- `list_projects` — the GitHub Projects (boards) of a user or organization
- `get_project` — a project's fields, Status options, iterations, linked repositories and views
- `list_project_items` — the items on a board with every field value, optionally filtered by one (e.g. `Status=In progress`)
- `add_project_item` — adds an issue/PR or a draft to a board, optionally setting fields
- `update_project_item` — changes Status, Priority, dates, iteration and custom fields by name, several at once
- `move_project_item` — moves an item after another one, or to the top
- `archive_project_item` / `unarchive_project_item` — archives or restores an item (keeps its fields)
- `remove_project_item` — removes an item from a board (the issue/PR itself is untouched) — board tools need the `project` scope: see [ADR 0019](./docs/adr/0019-projects-v2-board-tools.md)
- `create_project` / `update_project` — creates a board (optionally linked to a repository); edits title, description, README, visibility, closes or reopens it
- `delete_project` — deletes a board; without `confirm: true` it only reports what would be lost
- `link_project_repo` / `unlink_project_repo` — links or unlinks a repository
- `copy_project` / `set_project_template` — copies a board (e.g. a template) into a new one; marks or unmarks a template
- `create_project_field` — adds a text, number, date, single-select (with options) or iteration field
- `update_project_field` — renames a field; adds, renames, recolors or removes options (Status included); edits iterations (add, rename, reschedule, remove) — removals report the impact first and need `confirm: true`: see [ADR 0021](./docs/adr/0021-board-structure-tools.md)
- `delete_project_field` — deletes a custom field; without `confirm: true` it only reports how many items have a value
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

If the connector still drops every time you connect from another place, your
account was already at GitHub's limit of 10 tokens for this app before
[ADR 0015](./docs/adr/0015-one-token-per-user.md). Revoke the app once on
GitHub (Settings → Applications → Authorized OAuth Apps → Revoke) and
reconnect; from then on every place you connect from shares one token.

## Security

- No token is ever committed to this repository.
- You get **one** GitHub token from this app, shared by every place you
  connect from, so GitHub's 10-tokens-per-app limit never drops your
  sessions. The server stores it encrypted (AES-256-GCM), only ever hands it
  back to you, and revalidates it against the GitHub API on every tool call
  (see [ADR 0015](./docs/adr/0015-one-token-per-user.md)).
- `whoami` never returns tokens, only identifies the account/session.
- A linked (non-primary) account's token is also stored encrypted
  (AES-256-GCM) — never in plaintext.
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
- [0015 — One GitHub token per user (GitHub's 10-token limit)](./docs/adr/0015-one-token-per-user.md)
- [0016 — Commit history tools, per-commit stats on request](./docs/adr/0016-commit-history-stats.md)
- [0017 — Person-level activity stats: GraphQL contributions, own accounts only](./docs/adr/0017-person-level-activity-stats.md)
- [0018 — Activity breakdown in batches with a privacy-preserving cache](./docs/adr/0018-activity-breakdown-batches-and-cache.md)
- [0019 — Projects (v2) board tools: `project` scope, fields by name](./docs/adr/0019-projects-v2-board-tools.md)
- [0020 — Issue management via GraphQL: one atomic write, add/remove computed server-side](./docs/adr/0020-issue-management-graphql.md)
- [0021 — Board structure tools: confirmation before deletes, option and iteration lists rebuilt with their IDs](./docs/adr/0021-board-structure-tools.md)

## License

[MIT](./LICENSE)
