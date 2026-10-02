# ADR 0009: `update_pr` edits title, description and target branch, and can close or reopen

## Status
Accepted (2026-10-01). Implemented in issue #57.

## Context

The PR tools were `open_pr`, `list_prs` and `comment_pr`. Nothing could change
a PR after it was opened, so a stale description (scope changed, a
verification limit found) could only be patched over with a comment, while the
working flow expects a PR's description to say what changed and how it was
validated.

GitHub's `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` changes the title,
the body, the target (`base`) branch and the state (`open` / `closed`). The
question was how much of that to expose.

## Options considered

1. **Title and description only.** Smallest surface; closing, reopening and
   retargeting stay manual on GitHub.
2. **Title, description and target branch.**
3. **Everything the endpoint offers, including closing and reopening.**

## Decision

Option 3, chosen by the maintainer on 2026-10-01.

- `update_pr` takes `pr_number` plus any of `title`, `body`, `base`, `state`
  (`open` / `closed`). At least one is required; otherwise the call fails
  without calling GitHub.
- Only the fields given are sent. `body` replaces the whole description
  (an empty string clears it).
- **Merging is out of scope.** `state: "closed"` closes without merging, and
  there is no merge tool.
- Editing issues (`update_issue`) is left to the broader issue/PR/Projects
  management work, so it is designed together with labels, assignees and
  the rest.

## Consequences

- A PR's title and description can be kept accurate from Claude.
- Claude can close and reopen PRs and change what they target. Closing is
  reversible (reopen), and changing `base` is visible in the PR's timeline on
  GitHub; neither merges anything.
