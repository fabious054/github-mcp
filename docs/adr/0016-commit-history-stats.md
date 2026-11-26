# ADR 0016: Commit history tools, with per-commit stats fetched by the server on request

## Status
Accepted (2026-11-26). Implemented in issue #96.

## Context

The connector had no commit-history tool: no way to list commits, read one
commit's stats, or compare two refs. The goal set by the maintainer is to
give the connected user everything needed to build statistics about their
work, and the more detail the better.

GitHub's REST API splits this information:

- `GET /repos/{owner}/{repo}/commits` lists commits with author, dates,
  message and parents, but **no** lines added/removed and **no** files.
- `GET /repos/{owner}/{repo}/commits/{ref}` returns one commit with its stats
  and changed files.
- `GET /repos/{owner}/{repo}/compare/{base}...{head}` returns the commits
  between two refs and the aggregate file changes, capped at 250 commits and
  300 files.

So per-commit stats for a list of commits cost one extra call per commit.
The question was who makes those calls.

## Options considered

1. **`list_commits` stays light; stats only through `get_commit`.** The
   client calls `get_commit` once per commit. Simple on the server, but
   measuring 30 commits takes 31 tool calls, each one a full round trip
   through the model.
2. **`list_commits` takes `include_stats`.** When asked, the server fetches
   each commit's detail itself and returns everything in one response.
3. **Always include stats.** Every listing pays the extra calls, even when
   only dates and authors are needed.

## Decision

Option 2, chosen by the maintainer on 2026-11-26, together with `get_commit`
and `compare_commits` (the "most complete for statistics" package).

- `include_stats` defaults to `false`, so a plain listing costs one call.
- With `include_stats: true`, `per_page` is capped at **30** (100 otherwise),
  and the response says when the requested size was capped.
- The detail calls run with at most **5 in flight**, to stay clear of
  GitHub's secondary rate limits and of the function's 60-second limit.
- In that mode each commit lists the files from the first page of its detail
  (up to 300); the stats totals are always complete, and `get_commit` reads
  the full file list (paginated, up to GitHub's 3,000-file limit).
- `compare_commits` states in its response when GitHub's 250-commit or
  300-file limit was hit, instead of returning a silently partial result.

## Consequences

- One `list_commits` call with stats costs up to 31 GitHub requests. They
  count against the **caller's own token** (5,000 requests per hour per
  user), so one user's statistics never consume another company's quota on
  the shared instance.
- The tools are read-only and follow the existing account rules
  (ADR 0006, ADR 0007): no new OAuth scope is needed.
- Person-level statistics across all repositories (contribution totals,
  cross-repo search) are out of scope here. They need GraphQL and are
  planned as a separate phase with their own ADR.
