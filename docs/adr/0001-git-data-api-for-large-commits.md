# ADR 0001: Expose the Git Data API for large / multi-file commits

## Status
Accepted (2026-09) — amended (2026-09) to add unified-diff patch support

## Context

`commit_file` only accepts full file `content` inline, one file per call.
This becomes a real limitation for large files where only a small part
changed, or for changes spanning many files: the caller has to reproduce
the entire content of every touched file inside the tool call.

Four options were considered:

1. **Diff/patch support** in `commit_file` — the caller sends a unified
   diff instead of full content; the server fetches current content,
   applies the patch, commits. Fully compatible with a stateless deploy
   (no state needed between calls). Directly reduces what the caller has
   to reproduce for a file that itself changed — the only option of the
   four that does.
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
   It allows reusing an existing blob by SHA (a file unchanged between
   commits is never re-uploaded) and grouping many files into one atomic
   commit — but on its own does **not** reduce what has to be sent for a
   file that itself changed: an entry with new content still needs that
   content in full, same as `commit_file`.

## Decision

Implement option 4 in full — `create_blob`, `get_tree`, `create_tree`,
`create_commit`, `update_ref`, plus a convenience tool `commit_tree` that
orchestrates all four for the common case (one atomic multi-file commit
in a single tool call) — **and** option 1, since option 4 alone does not
cover the original reported case (a small edit inside one large file):

- `patch_file` — single-file convenience tool: fetches the current
  content of a file on a branch, applies a unified diff, commits the
  result. Direct replacement for "resend the whole file to change a few
  lines."
- Tree entries in `create_tree`/`commit_tree` also accept `patch`: applies
  a unified diff to the current content of that path in the base tree,
  so a multi-file commit can include both brand-new files (`content`),
  untouched files reused by `sha`, and files with a small in-place edit
  (`patch`) — all in the same atomic commit.

Patch application uses the `diff` npm package (pure JS, no native
dependencies), via its `applyPatch`. If the patch fails to apply (base
content drifted since the diff was generated), the tool throws a clear
error asking the caller to re-read the current content and regenerate
the diff, rather than silently producing a wrong result.

`commit_file` is kept as-is for the common single-small-file
full-rewrite case.

## Consequences

- The original problem (large file, small in-place edit) is now actually
  solved: `patch_file` (or a `patch` entry in `commit_tree`) only
  requires the diff, never the full file content.
- Large or multi-file changes no longer require resending unchanged file
  content — callers can look up an existing blob SHA (via `get_tree`) and
  reference it instead of re-uploading, or patch just the parts that
  changed.
- More tool surface than a single `commit_file` patch would have added,
  but each tool maps directly to a Git primitive (or a thin convenience
  over them), which keeps the behavior predictable and composable for
  future needs without another redesign.
- `update_ref` defaults to non-force, so a concurrent branch move is
  never silently overwritten. `patch_file`/patch entries fail loudly
  (rather than guessing) when the base content has drifted.
