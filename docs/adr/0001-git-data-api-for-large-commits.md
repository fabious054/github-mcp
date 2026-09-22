# ADR 0001: Expose the Git Data API for large / multi-file commits

## Status
Accepted (2026-09)

## Context

`commit_file` only accepts full file `content` inline, one file per call.
This becomes a real limitation for large files where only a small part
changed, or for changes spanning many files: the caller has to reproduce
the entire content of every touched file inside the tool call.

Four options were considered:

1. **Diff/patch support** in `commit_file` — the caller sends a unified
   diff instead of full content; the server fetches current content,
   applies the patch, commits. Fully compatible with a stateless deploy
   (no state needed between calls), but only reduces payload size for
   contiguous changes — a change scattered across many lines/files still
   requires sending most of it.
2. **Staged/buffered upload** — several small calls append to a
   server-side buffer, a final call commits it. Requires state to survive
   between invocations, which a stateless Vercel function does not have
   on its own — would need an external store (KV/Blob).
3. **Local file path** — the server reads the file itself instead of
   receiving inline content. Ruled out: this server runs on Vercel
   (stateless serverless functions), with no filesystem shared with the
   caller's environment.
4. **Git Data API** (`create_blob` / `create_tree` / `create_commit` /
   `update_ref`) — the native Git object model, exposed directly. Each
   operation is a single, independent GitHub API call — no state to keep
   between invocations, which fits the serverless deployment naturally.
   It also allows reusing an existing blob by SHA (a file unchanged
   between commits is never re-uploaded) and grouping many files into one
   atomic commit.

## Decision

Implement option 4 in full: `create_blob`, `get_tree`, `create_tree`,
`create_commit`, `update_ref`, plus a convenience tool `commit_tree` that
orchestrates all four for the common case (one atomic multi-file commit
in a single tool call). `commit_file` is kept as-is for the common
single-small-file case.

## Consequences

- Large or multi-file changes no longer require resending unchanged file
  content — callers can look up an existing blob SHA (via `get_tree`) and
  reference it instead of re-uploading.
- More tool surface than a single `commit_file` patch would have added,
  but each tool maps directly to a Git primitive, which keeps the
  behavior predictable and composable for future needs (e.g. commit
  signing, partial tree updates) without another redesign.
- `update_ref` defaults to non-force, so a concurrent branch move is
  never silently overwritten.
