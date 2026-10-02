# ADR 0008: Reject unknown tool arguments, and accept `branch` in the read tools

## Status
Accepted (2026-10-01). Implemented in issue #53.

## Context

The read tools name their branch selector differently from the write tools:
`read_file` takes `ref` and `get_tree` takes `tree_sha` (both default to
`main`), while `commit_file`, `patch_file`, `commit_tree`, `update_ref` and
`get_branch_head` take `branch`.

Tool input schemas were plain (non-strict) zod objects, so an unknown
argument was silently dropped. A call such as `read_file(branch: "feat/x")`
therefore read **`main`** and returned no error. On 2026-09-26 this made a
post-commit byte-for-byte verification read `main` instead of the feature
branch; a file that exists on both branches looked verified when it was not.

It was reproduced again on 2026-10-01, after the migration to mcp-handler 2
(ADR 0005): `read_file` and `get_tree` with a `branch` that does not exist
both returned `main`'s content. Since SDK v2 the advertised JSON schemas no
longer carry `additionalProperties: false`, so a client has nothing that
would catch a wrong argument name before the call reaches the server.

## Options considered

1. **Accept `branch` as an alias** in `read_file` and `get_tree`. Fixes the
   case that was hit, breaks nothing, but every other misnamed argument on any
   tool would still be ignored without an error.
2. **Make every tool's input schema strict**, so an unknown argument fails
   with a validation error. Protects every tool, now and for tools added
   later. A call that today carries a harmless extra argument starts failing,
   with a message naming the argument.
3. **Both.**

## Decision

Option 3, chosen by the maintainer on 2026-10-01, following the project's
rule of picking the most correct and safe option.

- **`branch` in `read_file` and `get_tree`.** `ref` / `tree_sha` keep working
  and still default to `main`. If `branch` and `ref` (or `tree_sha`) are both
  given with different values, the call fails without calling GitHub instead
  of silently preferring one (`lib/ref-pick.ts`).
- **Strict schemas everywhere.** Every tool's `inputSchema` is a
  `z.strictObject`, including nested objects such as the file entries of
  `commit_tree` and `create_tree`. An unknown key returns
  `Input validation error: … Unrecognized key: "<name>"`. The advertised JSON
  schemas include `additionalProperties: false` again, so clients that
  validate before calling catch the mistake even earlier.
- New tools must use `z.strictObject` (see the self-hosting guide).

## Consequences

- A misnamed argument can no longer change what a tool does without anyone
  noticing: it fails with a message that names it, and the caller retries
  with the right name.
- The read and write tools now share the same name for selecting a branch.
- A client that sends extra, unused arguments gets a validation error where
  it used to succeed. For an AI client this is a one-step correction; for a
  scripted client it surfaces a bug that was already there.
