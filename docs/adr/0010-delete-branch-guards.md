# ADR 0010: `delete_branch` refuses the default branch, protected branches and branches with open PRs

## Status
Accepted (2026-10-01). Implemented in issue #60.

## Context

There was no tool to delete a branch: `create_branch` only creates and
`update_ref` only moves a branch. Every finished feature, fix or test branch
had to be deleted by hand on GitHub.

Deleting a branch is destructive, and GitHub's
`DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}` has side effects beyond
removing the name: deleting the head or base branch of an open pull request
closes that pull request. The question was which guards the tool should apply
before calling it.

## Options considered

Guards on top of "never the default branch", which was not in question:

1. **Refuse when the branch is the head or base of an open pull request.**
2. **Refuse when the branch has commits that are not in the default branch,
   unless `force: true` is passed.**
3. **Refuse when the branch is protected on GitHub** (GitHub normally blocks
   this already; the tool would say so clearly instead of passing on a
   generic error).

## Decision

Guards 1 and 3, chosen by the maintainer on 2026-10-01. Guard 2 was not
adopted: unmerged commits do not block deletion and there is no `force` flag.

Before deleting, `delete_branch` checks, in order:

1. the branch exists — otherwise "does not exist";
2. it is not the repository's **default branch**;
3. it is not **protected** on GitHub;
4. no **open pull request** uses it as head or base — otherwise the error
   lists those PRs and asks to merge or close them first.

Any failed check stops the call before anything is deleted
(`lib/branch-delete.ts`). On success, the response gives the branch's last
commit SHA, so the branch can be recreated from that commit if it was deleted
by mistake.

## Consequences

- Finished branches can be cleaned up from Claude, closing the loop of the
  branch → commit → PR flow.
- A deletion can never silently close a PR or remove the default or a
  protected branch.
- A branch with work that was never merged can still be deleted. The way back
  is the last commit SHA in the response (create a branch from it) or, for a
  branch that was the head of a pull request, the "Restore branch" button on
  that PR's page on GitHub.
