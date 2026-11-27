# ADR 0018: Activity breakdown built from search, measured in batches with a privacy-preserving cache

## Status
Accepted (2026-11-26). Implemented in issue #100.

## Context

After ADR 0016 (one repository) and ADR 0017 (contribution totals across
repositories), three gaps remained, all found while validating issue #98:

1. **Lines changed for a whole period.** Lines added/removed only came per
   commit, one page at a time.
2. **PR size.** GitHub's issue search does not return additions, deletions or
   changed files.
3. **Private repositories by repository.** `contributionsCollection` withholds
   the per-repository detail of private contributions, even for their owner
   (live: 1,440 restricted contributions, only 4 public repositories listed;
   for an account that does not share private contribution counts, the
   private activity does not appear at all). REST search does see private
   repositories (198 PRs, same count as GitHub's own search).

Measuring lines needs one GitHub call per commit and per PR. A year of real
activity is hundreds to thousands of calls — more than one tool call can do
inside the function limit, and more than an MCP client will wait for.

## Decisions (maintainer, 2026-11-26)

1. **A new tool, `get_activity_breakdown`.** `get_contribution_stats` stays
   unchanged, so its cost does not grow.
2. **Commits are found with commit search**, so they are counted on each
   repository's default branch: work that actually landed, without counting
   the same commit once per branch.
3. **Batches + cache.** Every call recomputes the whole period, but:
   - discovery (search) is split into calendar months, and a month is halved
     again whenever it holds more than GitHub's 1,000-result cap; at most 20
     searches per account per call (GitHub allows 30 per minute);
   - detail calls (commit and PR sizes) stop starting after a 35-second
     budget, with 5 in flight;
   - everything measured is cached, so the next call with the same arguments
     resumes where the previous one stopped. No cursor is needed.
   The response always states the coverage ("measured N of M commits and
   P of Q PRs") and says to call again when it is partial.
4. **`search_issues_prs` gets `include_stats`** (PR size, page capped at 30).

## Cache design

On the Redis already used for rate limiting (ADR 0003), fail-open like it:
when Redis is unset, slow or down, the tool still answers and says
"Cache: OFF".

- **Keys are SHA-256 hashes**: repository names and SHAs never appear in keys.
- **Commit stats** (`repo + SHA`): lines added, lines removed, number of files.
  Numbers only — no file names, no content. No expiry: a commit never changes.
- **PR stats** (`repo + number`): the same numbers, stored only for **closed**
  PRs, since an open PR can still change.
- **Discovery lists** (which commits and PRs a login authored in a time
  slice) contain repository names, so they are **encrypted** with the server
  key (`OAUTH_ENCRYPTION_KEY`, as for refresh tokens), keyed by login, and
  expire: 10 minutes for slices that include the last day, 6 hours for the
  last week, 7 days for older slices. Without the key they are not stored.

A cached value is only used for an item that the caller's own search (with
their own token) returned, or for a slice of their own verified login, so
the cache never reveals anything the caller's token cannot see. The instance
is shared between companies; none of them leaves code or file names on it.

## Consequences

- A first call on a large period returns partial coverage; repeated calls
  converge, and once the cache is warm a whole year answers in well under a
  second (measured locally: 1,694 commits and 24 PRs, 20 + 19 searches over
  two calls, then 1 search and only the open PRs refetched).
- Commit search limits still apply and are stated: default branch only, and a
  single day with more than 1,000 commits is reported as incomplete.
- PR totals use the creation date; merged counts are the authored PRs that
  were merged.
- Costs stay on each account's own token (5,000 REST calls per hour).

## Addendum (2026-11-27, issue #102): merge commits

The live validation of #100 showed every merged PR counted twice: commit
search returns merge commits made on GitHub's UI, and GitHub reports each one
with the same lines as the commits it merges (2026-11-26 on `github-mcp`:
real change +1,892, breakdown +3,784).

Decision (maintainer): a commit with more than one parent is a merge commit.
Merge commits are left out of every total (totals, by repository, by month)
and reported on their own line ("N merge commits — not summed"). Their lines
are never fetched, which also saves one GitHub call per merge. Discovery
lists cached before this change do not carry the merge flag, so the commit
discovery key moved to a new version (`commits-v2`) and old lists are ignored.
