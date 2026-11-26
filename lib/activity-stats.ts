// Period handling, query building and formatting for the person-level
// activity tools (get_contribution_stats, search_commits, search_issues_prs —
// issue #98, ADR 0017). Pure, so the rules can be tested without GitHub.

export const GITHUB_EPOCH = Date.UTC(2008, 0, 1); // nothing on GitHub is older
export const REPOS_PER_CATEGORY = 100; // GraphQL maxRepositories limit
export const SEARCH_MAX_RESULTS = 1000;
export const SEARCH_ISSUES_DEFAULT_PER_PAGE = 10;
export const SEARCH_COMMITS_DEFAULT_PER_PAGE = 30;
export const SEARCH_MAX_PER_PAGE = 100;

// ---------- Period ----------

export type Period = { from: Date; to: Date };

function parseDate(value: string, name: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`'${name}' is not a valid date: '${value}'. Use ISO 8601, e.g. 2026-01-01 or 2026-01-01T00:00:00Z.`);
  }
  return d;
}

function addYears(d: Date, years: number): Date {
  const r = new Date(d.getTime());
  r.setUTCFullYear(r.getUTCFullYear() + years);
  return r;
}

// Default: the last 12 months, like GitHub's own profile.
export function resolvePeriod(from: string | undefined, to: string | undefined, now = new Date()): Period {
  const end = to ? parseDate(to, "to") : now;
  const start = from ? parseDate(from, "from") : addYears(end, -1);
  if (start.getTime() > end.getTime()) {
    throw new Error(`'from' (${start.toISOString()}) is after 'to' (${end.toISOString()}).`);
  }
  if (start.getTime() < GITHUB_EPOCH) return { from: new Date(GITHUB_EPOCH), to: end };
  return { from: start, to: end };
}

// GitHub's contributionsCollection accepts at most one year between `from`
// and `to`. Splits the period into consecutive windows of at most one year,
// newest first; each window ends one second before the next one starts.
export function yearlyWindows(p: Period): Period[] {
  const windows: Period[] = [];
  let start = p.from;
  do {
    const next = addYears(start, 1);
    const end = new Date(Math.min(next.getTime() - 1000, p.to.getTime()));
    windows.push({ from: start, to: end });
    start = next;
  } while (start.getTime() < p.to.getTime());
  return windows.reverse();
}

// Drops windows that end before the account's first contribution year.
export function windowsWithActivity(windows: Period[], contributionYears: number[]): Period[] {
  if (!contributionYears.length) return windows.slice(0, 1);
  const first = Math.min(...contributionYears);
  const firstStart = Date.UTC(first, 0, 1);
  return windows.filter((w) => w.to.getTime() >= firstStart);
}

// ---------- Contributions ----------

export type RepoCount = { repository: { nameWithOwner: string; isPrivate: boolean }; contributions: { totalCount: number } };

export type Collection = {
  startedAt: string;
  endedAt: string;
  totalCommitContributions: number;
  totalPullRequestContributions: number;
  totalPullRequestReviewContributions: number;
  totalIssueContributions: number;
  totalRepositoryContributions: number;
  restrictedContributionsCount: number;
  contributionYears: number[];
  contributionCalendar: { totalContributions: number; weeks: { contributionDays: { date: string; contributionCount: number }[] }[] };
  commitContributionsByRepository: RepoCount[];
  pullRequestContributionsByRepository: RepoCount[];
  pullRequestReviewContributionsByRepository: RepoCount[];
  issueContributionsByRepository: RepoCount[];
};

export const CONTRIBUTIONS_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      startedAt
      endedAt
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      totalRepositoryContributions
      restrictedContributionsCount
      contributionYears
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      commitContributionsByRepository(maxRepositories: ${REPOS_PER_CATEGORY}) { repository { nameWithOwner isPrivate } contributions { totalCount } }
      pullRequestContributionsByRepository(maxRepositories: ${REPOS_PER_CATEGORY}) { repository { nameWithOwner isPrivate } contributions { totalCount } }
      pullRequestReviewContributionsByRepository(maxRepositories: ${REPOS_PER_CATEGORY}) { repository { nameWithOwner isPrivate } contributions { totalCount } }
      issueContributionsByRepository(maxRepositories: ${REPOS_PER_CATEGORY}) { repository { nameWithOwner isPrivate } contributions { totalCount } }
    }
  }
}`;

type Totals = {
  commits: number;
  pullRequests: number;
  reviews: number;
  issues: number;
  repositories: number;
  restricted: number;
  calendar: number;
};

function totalsOf(c: Collection): Totals {
  return {
    commits: c.totalCommitContributions,
    pullRequests: c.totalPullRequestContributions,
    reviews: c.totalPullRequestReviewContributions,
    issues: c.totalIssueContributions,
    repositories: c.totalRepositoryContributions,
    restricted: c.restrictedContributionsCount,
    calendar: c.contributionCalendar.totalContributions,
  };
}

function addTotals(a: Totals, b: Totals): Totals {
  return {
    commits: a.commits + b.commits,
    pullRequests: a.pullRequests + b.pullRequests,
    reviews: a.reviews + b.reviews,
    issues: a.issues + b.issues,
    repositories: a.repositories + b.repositories,
    restricted: a.restricted + b.restricted,
    calendar: a.calendar + b.calendar,
  };
}

const ZERO: Totals = { commits: 0, pullRequests: 0, reviews: 0, issues: 0, repositories: 0, restricted: 0, calendar: 0 };

type RepoRow = { name: string; isPrivate: boolean; commits: number; pullRequests: number; reviews: number; issues: number };

export type MergedStats = {
  totals: Totals;
  perWindow: { from: string; to: string; totals: Totals }[];
  repos: RepoRow[];
  truncatedCategories: string[];
  days: Map<string, number>;
  contributionYears: number[];
};

export function mergeCollections(windows: { window: Period; collection: Collection }[]): MergedStats {
  const repos = new Map<string, RepoRow>();
  const truncated = new Set<string>();
  const days = new Map<string, number>();
  let totals = ZERO;
  const perWindow: MergedStats["perWindow"] = [];
  let years: number[] = [];

  const categories: [keyof Collection, keyof Omit<RepoRow, "name" | "isPrivate">, string][] = [
    ["commitContributionsByRepository", "commits", "commits"],
    ["pullRequestContributionsByRepository", "pullRequests", "pull requests"],
    ["pullRequestReviewContributionsByRepository", "reviews", "reviews"],
    ["issueContributionsByRepository", "issues", "issues"],
  ];

  for (const { window, collection: c } of windows) {
    const t = totalsOf(c);
    totals = addTotals(totals, t);
    perWindow.push({ from: window.from.toISOString(), to: window.to.toISOString(), totals: t });
    if (c.contributionYears.length > years.length) years = c.contributionYears;

    for (const [field, key, label] of categories) {
      const list = c[field] as RepoCount[];
      if (list.length >= REPOS_PER_CATEGORY) truncated.add(label);
      for (const r of list) {
        const name = r.repository.nameWithOwner;
        const row = repos.get(name) ?? { name, isPrivate: r.repository.isPrivate, commits: 0, pullRequests: 0, reviews: 0, issues: 0 };
        row[key] += r.contributions.totalCount;
        repos.set(name, row);
      }
    }

    const fromDay = window.from.toISOString().slice(0, 10);
    const toDay = window.to.toISOString().slice(0, 10);
    for (const w of c.contributionCalendar.weeks) {
      for (const d of w.contributionDays) {
        if (d.date < fromDay || d.date > toDay) continue;
        days.set(d.date, Math.max(days.get(d.date) ?? 0, d.contributionCount));
      }
    }
  }

  const rows = [...repos.values()].sort(
    (a, b) => b.commits + b.pullRequests + b.reviews + b.issues - (a.commits + a.pullRequests + a.reviews + a.issues)
  );
  return { totals, perWindow, repos: rows, truncatedCategories: [...truncated], days, contributionYears: years };
}

export type CalendarMode = "none" | "monthly" | "daily";

export function formatContributionStats(login: string, p: Period, s: MergedStats, calendar: CalendarMode): string {
  const t = s.totals;
  const lines: string[] = [];
  lines.push(`## ${login}`);
  lines.push(`Period: ${p.from.toISOString()} → ${p.to.toISOString()}`);
  lines.push(
    `Totals: ${t.commits} commits · ${t.pullRequests} pull requests opened · ${t.reviews} pull request reviews · ${t.issues} issues opened · ${t.repositories} repositories created`
  );
  lines.push(`Contribution calendar total: ${t.calendar}`);
  if (t.restricted > 0) {
    lines.push(
      `Restricted contributions: ${t.restricted} — GitHub counts these (private repositories) but does not detail them, so they are not in the totals or the per-repository breakdown above.`
    );
  }
  if (s.contributionYears.length) lines.push(`Years with contributions: ${s.contributionYears.join(", ")}`);

  if (s.perWindow.length > 1) {
    lines.push("", "Per year (GitHub allows at most one year per query):");
    for (const w of [...s.perWindow].reverse()) {
      const x = w.totals;
      lines.push(
        `  ${w.from.slice(0, 10)} → ${w.to.slice(0, 10)}: ${x.commits} commits · ${x.pullRequests} PRs · ${x.reviews} reviews · ${x.issues} issues · ${x.repositories} repos${x.restricted ? ` · ${x.restricted} restricted` : ""}`
      );
    }
  }

  lines.push("", `By repository (${s.repos.length}):`);
  if (!s.repos.length) {
    lines.push(
      t.restricted > 0
        ? "  (none listed — GitHub withheld the per-repository breakdown; see the restricted count above)"
        : "  (no contributions in this period)"
    );
  }
  for (const r of s.repos) {
    lines.push(
      `  ${r.name}${r.isPrivate ? " (private)" : ""}: ${r.commits} commits · ${r.pullRequests} PRs · ${r.reviews} reviews · ${r.issues} issues`
    );
  }
  if (s.truncatedCategories.length) {
    lines.push(
      `  Note: GitHub lists at most ${REPOS_PER_CATEGORY} repositories per category and query; the breakdown for ${s.truncatedCategories.join(", ")} may be incomplete (the totals are not).`
    );
  }

  if (calendar !== "none" && s.days.size) {
    const sorted = [...s.days.entries()].sort(([a], [b]) => a.localeCompare(b));
    if (calendar === "daily") {
      lines.push("", "Daily contributions (days with activity):");
      for (const [date, count] of sorted) if (count > 0) lines.push(`  ${date}: ${count}`);
    } else {
      const months = new Map<string, { total: number; activeDays: number }>();
      for (const [date, count] of sorted) {
        const m = months.get(date.slice(0, 7)) ?? { total: 0, activeDays: 0 };
        m.total += count;
        if (count > 0) m.activeDays += 1;
        months.set(date.slice(0, 7), m);
      }
      lines.push("", "Monthly contributions:");
      for (const [month, m] of months) lines.push(`  ${month}: ${m.total} (${m.activeDays} active days)`);
    }
  }
  return lines.join("\n");
}

// ---------- Search queries ----------

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function range(qualifier: string, p: Period | undefined): string | null {
  if (!p) return null;
  return `${qualifier}:${dateOnly(p.from)}..${dateOnly(p.to)}`;
}

export function searchPeriod(since: string | undefined, until: string | undefined): Period | undefined {
  if (!since && !until) return undefined;
  const from = since ? parseDate(since, "since") : new Date(GITHUB_EPOCH);
  const to = until ? parseDate(until, "until") : new Date();
  if (from.getTime() > to.getTime()) throw new Error(`'since' (${since}) is after 'until' (${until}).`);
  return { from, to };
}

export function commitSearchQuery(login: string, p: Period | undefined, owner?: string, repo?: string): string {
  const parts = [`author:${login}`];
  const r = range("author-date", p);
  if (r) parts.push(r);
  if (owner && repo) parts.push(`repo:${owner}/${repo}`);
  else if (owner) parts.push(`user:${owner}`);
  return parts.join(" ");
}

export type Role = "authored" | "reviewed" | "merged" | "assigned" | "commented";
export type ItemType = "pr" | "issue";
export const ALL_ROLES: Role[] = ["authored", "reviewed", "merged", "assigned", "commented"];

export type IssueQuery = { role: Role; type: ItemType; q: string; dateField: string };

// One query per role and type: GitHub refuses mixed issue/PR searches from
// user tokens (422), and 'reviewed'/'merged' only exist for pull requests.
export function issueSearchQueries(
  login: string,
  roles: Role[],
  type: "pr" | "issue" | "both",
  state: "open" | "closed" | "all",
  p: Period | undefined,
  owner?: string
): { queries: IssueQuery[]; skipped: string[] } {
  const types: ItemType[] = type === "both" ? ["pr", "issue"] : [type];
  const queries: IssueQuery[] = [];
  const skipped: string[] = [];
  for (const role of roles) {
    for (const t of types) {
      if ((role === "reviewed" || role === "merged") && t === "issue") {
        if (type === "issue") skipped.push(`'${role}' applies to pull requests only — skipped because type is 'issue'.`);
        continue;
      }
      const parts = [t === "pr" ? "is:pr" : "is:issue"];
      let dateField = "created";
      switch (role) {
        case "authored":
          parts.push(`author:${login}`);
          break;
        case "reviewed":
          parts.push(`reviewed-by:${login}`);
          dateField = "updated";
          break;
        case "merged":
          parts.push(`author:${login}`, "is:merged");
          dateField = "merged";
          break;
        case "assigned":
          parts.push(`assignee:${login}`);
          break;
        case "commented":
          parts.push(`commenter:${login}`);
          dateField = "updated";
          break;
      }
      if (role !== "merged" && state !== "all") parts.push(`is:${state}`);
      const r = range(dateField, p);
      if (r) parts.push(r);
      if (owner) parts.push(`user:${owner}`);
      queries.push({ role, type: t, q: parts.join(" "), dateField });
    }
  }
  return { queries, skipped };
}

export type SearchIssue = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  repository_url: string;
  created_at: string;
  closed_at?: string | null;
  pull_request?: { merged_at?: string | null } | null;
};

export function repoFromUrl(repositoryUrl: string): string {
  const m = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : repositoryUrl;
}

export function formatIssueItem(i: SearchIssue): string {
  const kind = i.pull_request ? "PR" : "issue";
  const dates = [`created ${i.created_at}`];
  if (i.pull_request?.merged_at) dates.push(`merged ${i.pull_request.merged_at}`);
  else if (i.closed_at) dates.push(`closed ${i.closed_at}`);
  const state = i.pull_request?.merged_at ? "merged" : i.state;
  return `  ${repoFromUrl(i.repository_url)}#${i.number} [${kind}, ${state}] ${i.title} · ${dates.join(" · ")} · ${i.html_url}`;
}

export function searchLimitNote(total: number): string | null {
  return total > SEARCH_MAX_RESULTS
    ? `  Note: GitHub's search returns at most ${SEARCH_MAX_RESULTS} results (${total} match); narrow the period to page through all of them.`
    : null;
}

// ---------- Errors ----------

type HttpError = { status?: number; message?: string; response?: { headers?: Record<string, string | undefined> } };

export function isAuthError(err: unknown): boolean {
  return (err as HttpError).status === 401;
}

export function rateLimitMessage(err: unknown): string | null {
  const e = err as HttpError;
  if (e.status !== 403 && e.status !== 429) return null;
  const msg = e.message ?? "";
  const headers = e.response?.headers ?? {};
  if (!/rate limit|abuse/i.test(msg) && headers["x-ratelimit-remaining"] !== "0") return null;
  const reset = headers["x-ratelimit-reset"];
  const when = reset ? ` It resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
  return `GitHub's rate limit was reached for this account (search allows 30 requests per minute).${when} Try again later, or narrow the call (fewer roles, one account).`;
}
