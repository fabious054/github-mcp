# ADR 0017: Person-level activity stats — GraphQL contributions, own accounts only, yearly split

## Status
Accepted (2026-11-26). Implemented in issue #98.

## Context

ADR 0016 added commit history inside one repository. The goal set by the
maintainer is broader: statistics of everything done by the person who is
connected, across every repository their token can reach.

GitHub only offers that view in two places:

- **GraphQL `viewer.contributionsCollection`**: totals of commits, pull
  requests, reviews, issues and repositories created, the breakdown by
  repository, and the contribution calendar. It accepts at most **one year**
  between `from` and `to`, lists at most **100 repositories** per category,
  and reports contributions it will not detail (private repositories) only
  as `restrictedContributionsCount`.
- **REST search** (`/search/commits`, `/search/issues`): commits, pull
  requests and issues across repositories. At most **1,000 results** per
  search, **30 requests per minute** per user; commit search covers only
  each repository's default branch; issue search from a user token must say
  `is:issue` or `is:pr` (mixed queries return 422).

This is the first use of GraphQL in the connector. `@octokit/rest` already
includes the GraphQL client (`octokit.graphql`), so no new dependency is
needed, and the `repo` scope already requested covers private contributions.

## Decisions (maintainer, 2026-11-26)

1. **Only the caller's own accounts.** The tools take no login argument:
   they report the primary account and every account linked with
   `link_account`. Another person's statistics are out of scope, even when
   public.
2. **Every linked account in its own section, never merged.** `account`
   limits the call to one. A revoked linked account gets its own section
   saying so (ADR 0007) instead of being skipped; a rate limit on one
   account does not hide the others.
3. **Any period.** Default: the last 12 months, like GitHub's profile. Longer
   periods are split into consecutive windows of at most one year (each
   ending one second before the next starts), queried and summed, with
   per-year subtotals. Windows before the account's first contribution year
   are skipped; nothing before 2008 is queried.
4. **Roles for pull requests and issues:** authored, reviewed, merged,
   assigned, commented. One search per role and type. The period filter uses
   the creation date (authored, assigned), the last update (reviewed,
   commented — GitHub search has no "reviewed at" or "commented at"
   qualifier) or the merge date (merged).

## Consequences

- One `get_contribution_stats` call costs one GraphQL query per account and
  per year of the period (at most 4 in flight). One `search_issues_prs` call
  with every role and both types costs 8 searches per account — under the
  30-per-minute limit for up to three accounts. When the limit is hit, the
  results already fetched are kept and the missing roles are named.
- All calls count against **each account's own token**, so one user's
  statistics never consume another company's quota on the shared instance.
- GitHub limits are stated in the responses rather than hidden: restricted
  contributions, the 100-repository breakdown cap, the 1,000-result search
  cap, default-branch-only commit search.
- Known risk to verify live: GitHub has been reported to withhold the
  per-repository breakdown for private repositories even for their owner,
  returning only the restricted count. The tool reports that explicitly; a
  workaround (walking repositories one by one) is left for later if it
  matters in practice.
