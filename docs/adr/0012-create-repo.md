# ADR 0012: `create_repo` picks the account by owner, creates empty, and has no default visibility

## Status
Accepted (2026-10-08). Implemented in issue #67.

## Context

There was no tool to create a repository, so starting a new project still
needed a manual step on GitHub. The OAuth scope already requested (`repo`)
allows creating repositories, so no new permission is needed.

Three things had to be decided:

- **Which linked account creates it.** Every other tool picks the account by
  its access to an existing repository (ADR 0006). A repository that does
  not exist yet has no access to compare.
- **What it starts with.** GitHub can create it empty, or with a README,
  license and `.gitignore`.
- **Visibility.** A public repository created by mistake exposes its content
  at once, and this server cannot delete repositories (see below).

## Options considered

Account:

1. **By the given owner.** The owner is a linked login → that account; any
   other owner is an organization → the linked account that is a member.
2. **Always the primary account**, with `account` to override. Simple, but
   wrong for organizations only a linked account belongs to.

Content:

1. **Empty**, filled afterwards with the existing tools.
2. **README + MIT license + `.gitignore`**, matching the CodeWave.IT
   documentation pattern.

Visibility:

1. **Private by default**, with a parameter for public.
2. **No default**: the caller must say; if it does not, nothing is created.

## Decision

Chosen by the maintainer on 2026-10-08: account by owner, created empty, no
default visibility.

- **Account resolution** (`lib/repo-create.ts`):
  - `account` given → that linked account; personal repository when `owner`
    is its login, organization repository otherwise.
  - `owner` is a linked login → that account, personal repository.
  - Only one account in the session → it is used for the organization, and
    GitHub decides whether it may create there.
  - Several accounts → `GET /user/memberships/orgs/{owner}` for each. One
    active member → use it; several → ask for `account`; none → refuse, with
    a hint when an organization's OAuth App access restrictions blocked the
    check. A revoked account, or GitHub not answering for one, stops the
    call before anything is picked (ADR 0007).
  - Legacy mode: the configured account is resolved as for every other tool;
    the repository is personal when `owner` is that token's login.
- **Empty repository.** GitHub rejects the Git Data API on a repository with
  no commits, so `commit_tree`, `create_tree`, `create_blob`, `create_commit`
  and `create_branch` fail until the first commit exists. `commit_file` (the
  Contents API) works and creates the default branch. The `create_repo`
  response says so, with the default branch name.
- **Visibility.** `private` is optional in the schema so a missing value
  reaches the handler: it returns an error that creates nothing and tells the
  client to ask the user, instead of a generic validation error.

## Consequences

- One extra GitHub call per linked account when creating in an organization
  with more than one account linked; none otherwise.
- The first commit of a new repository must be a single `commit_file`.
- **No delete.** The server does not request the `delete_repo` scope and has
  no tool to delete a repository. A repository created by mistake is deleted
  by hand on GitHub. This is intentional: deleting a repository is too
  destructive to be one tool call away.

## Out of scope

- Creating from a template, forking, or initial files.
- Repository settings (topics, branch protection, team access).
