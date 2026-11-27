// Pure parts of get_activity_breakdown (issue #100, ADR 0018): day-based
// time slices for search discovery, aggregation by repository and month, and
// formatting. Tested without GitHub or Redis.

import type { Stats } from "./stats-cache";

export const SEARCH_PAGE_SIZE = 100;
export const SEARCH_RESULT_CAP = 1000;
export const SEARCHES_PER_CALL = 20; // per account; GitHub allows 30 searches/minute
export const DETAIL_TIME_BUDGET_MS = 35_000; // stop starting new detail calls after this
export const DETAIL_CONCURRENCY = 5;
export const PR_STATS_MAX_PER_PAGE = 30;

// ---------- Day slices ----------

export type Slice = { from: string; to: string }; // inclusive days, YYYY-MM-DD

const DAY = 86_400_000;
const toDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

// Calendar months (UTC) covering [from, to], clipped to the period.
export function monthSlices(from: Date, to: Date): Slice[] {
  const slices: Slice[] = [];
  const end = toDay(to.getTime());
  let cur = toDay(from.getTime());
  while (cur <= end) {
    const d = new Date(dayMs(cur));
    const monthEnd = toDay(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - DAY);
    const sliceEnd = monthEnd < end ? monthEnd : end;
    slices.push({ from: cur, to: sliceEnd });
    cur = toDay(dayMs(sliceEnd) + DAY);
  }
  return slices;
}

// Splits a slice in two halves by day; null when it is a single day.
export function splitSlice(s: Slice): [Slice, Slice] | null {
  const a = dayMs(s.from);
  const b = dayMs(s.to);
  if (a >= b) return null;
  const mid = a + Math.floor((b - a) / DAY / 2) * DAY;
  return [
    { from: s.from, to: toDay(mid) },
    { from: toDay(mid + DAY), to: s.to },
  ];
}

export const pagesFor = (total: number) => Math.ceil(Math.min(total, SEARCH_RESULT_CAP) / SEARCH_PAGE_SIZE);

// A slice whose last day ended long enough ago is stable enough to cache for
// longer; recent slices still receive new commits and PRs.
export function discoveryTtlSeconds(s: Slice, now = Date.now()): number {
  const ageDays = (now - (dayMs(s.to) + DAY)) / DAY;
  if (ageDays >= 7) return 7 * 86_400;
  if (ageDays >= 1) return 6 * 3_600;
  return 600;
}

// ---------- Items ----------

// `merge`: more than one parent. Merge commits made on GitHub repeat the lines
// of the commits they merge, so they are counted apart and never summed.
export type CommitItem = { repo: string; sha: string; date: string; private: boolean; merge?: boolean };
export type PrItem = { repo: string; number: number; created: string; merged: string | null; state: string; private: boolean };

// ---------- Aggregation ----------

type Bucket = {
  commits: number;
  merges: number;
  measuredCommits: number;
  additions: number;
  deletions: number;
  files: number;
  prs: number;
  mergedPrs: number;
  measuredPrs: number;
  prAdditions: number;
  prDeletions: number;
  prFiles: number;
};

const empty = (): Bucket => ({
  commits: 0,
  merges: 0,
  measuredCommits: 0,
  additions: 0,
  deletions: 0,
  files: 0,
  prs: 0,
  mergedPrs: 0,
  measuredPrs: 0,
  prAdditions: 0,
  prDeletions: 0,
  prFiles: 0,
});

export type Breakdown = {
  total: Bucket;
  byRepo: Map<string, Bucket & { private: boolean }>;
  byMonth: Map<string, Bucket>;
};

export function aggregate(
  commits: CommitItem[],
  commitStats: Map<string, Stats>,
  prs: PrItem[],
  prStats: Map<string, Stats>
): Breakdown {
  const total = empty();
  const byRepo = new Map<string, Bucket & { private: boolean }>();
  const byMonth = new Map<string, Bucket>();
  const buckets = (repo: string, isPrivate: boolean, date: string): Bucket[] => {
    let r = byRepo.get(repo);
    if (!r) {
      r = { ...empty(), private: isPrivate };
      byRepo.set(repo, r);
    }
    const m = date.slice(0, 7);
    let mb = byMonth.get(m);
    if (!mb) {
      mb = empty();
      byMonth.set(m, mb);
    }
    return [total, r, mb];
  };

  for (const c of commits) {
    if (c.merge) {
      for (const b of buckets(c.repo, c.private, c.date)) b.merges += 1;
      continue;
    }
    const s = commitStats.get(`${c.repo}@${c.sha}`);
    for (const b of buckets(c.repo, c.private, c.date)) {
      b.commits += 1;
      if (s) {
        b.measuredCommits += 1;
        b.additions += s.additions;
        b.deletions += s.deletions;
        b.files += s.files;
      }
    }
  }
  for (const p of prs) {
    const s = prStats.get(`${p.repo}#${p.number}`);
    for (const b of buckets(p.repo, p.private, p.created)) {
      b.prs += 1;
      if (p.merged) b.mergedPrs += 1;
      if (s) {
        b.measuredPrs += 1;
        b.prAdditions += s.additions;
        b.prDeletions += s.deletions;
        b.prFiles += s.files;
      }
    }
  }
  return { total, byRepo, byMonth };
}

// ---------- Formatting ----------

const n = (x: number) => x.toLocaleString("en-US");

function row(b: Bucket): string {
  const parts = [`${n(b.commits)} commits, +${n(b.additions)} −${n(b.deletions)} lines, ${n(b.files)} files`];
  if (b.measuredCommits < b.commits) parts[0] += ` (${n(b.measuredCommits)} measured)`;
  parts.push(
    `${n(b.prs)} PRs (${n(b.mergedPrs)} merged), +${n(b.prAdditions)} −${n(b.prDeletions)} in PRs${
      b.measuredPrs < b.prs ? ` (${n(b.measuredPrs)} measured)` : ""
    }`
  );
  if (b.merges) parts.push(`${n(b.merges)} merge commits not summed`);
  return parts.join(" · ");
}

export type Coverage = {
  discoveryComplete: boolean;
  pendingSlices: number;
  truncatedSlices: string[];
  cache: "on" | "off";
  cacheHits: number;
  fetchedNow: number;
};

export function formatBreakdown(login: string, from: string, to: string, b: Breakdown, cov: Coverage): string {
  const t = b.total;
  const done = cov.discoveryComplete && t.measuredCommits === t.commits && t.measuredPrs === t.prs;
  const lines = [
    `## ${login}`,
    `Period: ${from} → ${to} (commits on each repository's default branch; PRs by creation date)`,
    `Coverage: ${done ? "complete" : "PARTIAL"} — measured ${n(t.measuredCommits)} of ${n(t.commits)} commits and ${n(
      t.measuredPrs
    )} of ${n(t.prs)} PRs${cov.discoveryComplete ? "" : `; ${cov.pendingSlices} time slice(s) not searched yet`}`,
  ];
  if (!done) lines.push("  → Call again with the same arguments to continue; measured items are cached, so it resumes where it stopped.");
  lines.push(
    `Cache: ${cov.cache === "on" ? `on (${n(cov.cacheHits)} hits, ${n(cov.fetchedNow)} fetched from GitHub now)` : "OFF — Redis unavailable; nothing is kept between calls"}`
  );
  for (const s of cov.truncatedSlices) {
    lines.push(`  Note: more than ${SEARCH_RESULT_CAP} results on ${s} (a single day) — GitHub's search cap; that day is incomplete.`);
  }
  lines.push("", `Totals: ${row(t)}`);
  if (t.merges) {
    lines.push(`Merge commits: ${n(t.merges)} — not summed (GitHub reports a merge with the same lines as the commits it merges)`);
  }

  const repos = [...b.byRepo.entries()].sort(([, x], [, y]) => y.additions + y.deletions + y.prAdditions + y.prDeletions - (x.additions + x.deletions + x.prAdditions + x.prDeletions) || y.commits - x.commits);
  lines.push("", `By repository (${repos.length}):`);
  if (!repos.length) lines.push("  (no commits or PRs found in this period)");
  for (const [name, r] of repos) lines.push(`  ${name}${r.private ? " (private)" : ""}: ${row(r)}`);

  const months = [...b.byMonth.entries()].sort(([x], [y]) => x.localeCompare(y));
  if (months.length) {
    lines.push("", "By month:");
    for (const [m, r] of months) lines.push(`  ${m}: ${row(r)}`);
  }
  return lines.join("\n");
}
