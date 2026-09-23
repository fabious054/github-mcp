# GitHub MCP

*[Leia em português](./README.pt-br.md)*

An MCP server that gives Claude real access to GitHub: create branches, commit,
open/comment on PRs, list/create/comment on issues, read files, and search
code.

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
- `link_account` — links an ADDITIONAL GitHub account to your session
- `list_accounts` — lists the accounts linked to your session
- `list_repos_by_account` — lists the repositories a specific linked account can access

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

`commit_file`, `patch_file` and `commit_tree` print the commit's full SHA in
their response (in addition to the abbreviated one) — useful for chaining
with `create_commit` without an extra call to `get_branch_head`.

All tools accept an optional `owner`/`repo`. If you don't provide `owner`,
the server tries to use your own GitHub user as the default (but `repo`
still needs to be given).

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
   if more than one account is linked, the server checks which one(s) have
   access to the target repository and uses the match automatically, or
   asks you to repeat the call with an explicit `account` when more than
   one matches.
4. `list_accounts` lists every account linked to your session, and
   `list_repos_by_account` lists what a specific one can access — handy to
   check before a call, or to figure out which `account` to pass when the
   ambiguity error above happens.

## Security

- No token is ever committed to this repository.
- The server never stores your primary account's token — it's forwarded
  from GitHub to Claude on each exchange, and revalidated against the
  GitHub API on every tool call.
- `whoami` never returns tokens, only identifies the account/session.
- A linked (non-primary) account's token is the only thing this server
  persists at all, and it's always stored encrypted (AES-256-GCM) — never
  in plaintext.

Full security policy, threat model, and how to report a vulnerability:
[`SECURITY.md`](./SECURITY.md).

## Architecture decisions

Notable design decisions live as ADRs in [`docs/adr/`](./docs/adr/):

- [0001 — Git Data API for large commits](./docs/adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./docs/adr/0002-multi-account-oauth-linking.md)

## License

[MIT](./LICENSE)
