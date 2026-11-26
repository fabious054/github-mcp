// Formatting and limits for the commit history tools (list_commits,
// get_commit, compare_commits — issue #96, ADR 0016). Pure, so the rules can
// be tested without GitHub.

export const LIST_MAX_PER_PAGE = 100;
export const STATS_MAX_PER_PAGE = 30;
export const STATS_CONCURRENCY = 5;
export const PATCH_MAX_CHARS = 4000;
export const COMMIT_FILES_PER_PAGE = 100;
export const COMMIT_FILES_MAX = 3000; // GitHub's hard limit for a single commit
export const COMPARE_MAX_COMMITS = 250;
export const COMPARE_MAX_FILES = 300;

// ---------- Shapes (only the fields the tools use) ----------

type Person = { name?: string | null; email?: string | null; date?: string | null } | null | undefined;
type Account = { login?: string | null } | null | undefined;

export type GhCommit = {
  sha: string;
  html_url?: string | null;
  author?: Account;
  committer?: Account;
  parents?: { sha: string }[];
  commit: {
    message: string;
    author?: Person;
    committer?: Person;
    verification?: { verified?: boolean | null; reason?: string | null } | null;
  };
  stats?: { additions?: number; deletions?: number; total?: number };
  files?: GhFile[];
};

export type GhFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  previous_filename?: string;
  patch?: string;
};

// ---------- Limits ----------

export type PageSize = { perPage: number; capped: boolean; requested: number };

export function resolvePerPage(requested: number | undefined, includeStats: boolean): PageSize {
  const max = includeStats ? STATS_MAX_PER_PAGE : LIST_MAX_PER_PAGE;
  const asked = requested ?? max;
  if (asked < 1) return { perPage: 1, capped: false, requested: asked };
  if (asked > max) return { perPage: max, capped: true, requested: asked };
  return { perPage: asked, capped: false, requested: asked };
}

// Runs `fn` over `items` with at most `limit` calls in flight, keeping order.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// GitHub's Link header: `<...&page=3>; rel="next", <...&page=9>; rel="last"`.
export function nextPageFromLink(link: string | undefined): number | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const url = part.match(/<([^>]+)>/)?.[1];
    if (!url) continue;
    const page = new URL(url).searchParams.get("page");
    if (page) return Number(page);
  }
  return null;
}

// ---------- Formatting ----------

function who(account: Account, person: Person): string {
  const parts: string[] = [];
  if (account?.login) parts.push(`@${account.login}`);
  const name = person?.name ?? "";
  const email = person?.email ?? "";
  if (name || email) parts.push(`${name}${email ? ` <${email}>` : ""}`.trim());
  return parts.length ? parts.join(" ") : "unknown";
}

export function formatFile(f: GhFile): string {
  const renamed = f.previous_filename ? ` (renamed from ${f.previous_filename})` : "";
  return `  ${f.status ?? "modified"} ${f.filename}${renamed} +${f.additions ?? 0} -${f.deletions ?? 0}`;
}

export function truncatePatch(patch: string | undefined, max = PATCH_MAX_CHARS): string {
  if (patch === undefined) return "    (no patch: binary file or diff too large for GitHub to return)";
  if (patch.length <= max) return patch;
  return `${patch.slice(0, max)}\n… [patch truncated: ${max} of ${patch.length} characters shown]`;
}

export type FormatOptions = { includeFiles?: boolean; includePatch?: boolean };

export function formatCommit(c: GhCommit, opts: FormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`commit ${c.sha}`);
  lines.push(`Author: ${who(c.author, c.commit.author)} · authored ${c.commit.author?.date ?? "unknown"}`);
  lines.push(`Committer: ${who(c.committer, c.commit.committer)} · committed ${c.commit.committer?.date ?? "unknown"}`);
  const parents = c.parents?.map((p) => p.sha) ?? [];
  lines.push(`Parents: ${parents.length ? parents.join(", ") : "(none — root commit)"}${parents.length > 1 ? " · merge commit" : ""}`);
  const v = c.commit.verification;
  if (v) lines.push(`Signature: ${v.verified ? "verified" : `not verified (${v.reason ?? "unknown"})`}`);
  if (c.html_url) lines.push(`URL: ${c.html_url}`);
  if (c.stats) {
    const fileCount = c.files ? ` · ${c.files.length} file(s)` : "";
    lines.push(`Stats: +${c.stats.additions ?? 0} -${c.stats.deletions ?? 0} (${c.stats.total ?? 0} lines changed)${fileCount}`);
  }
  lines.push("Message:");
  lines.push(...c.commit.message.split("\n").map((l) => `  ${l}`));
  if (opts.includeFiles && c.files) {
    lines.push("Files:");
    for (const f of c.files) {
      lines.push(formatFile(f));
      if (opts.includePatch) lines.push(truncatePatch(f.patch));
    }
  }
  return lines.join("\n");
}

export type Totals = { additions: number; deletions: number; changes: number; files: number };

export function fileTotals(files: GhFile[]): Totals {
  return files.reduce<Totals>(
    (t, f) => ({
      additions: t.additions + (f.additions ?? 0),
      deletions: t.deletions + (f.deletions ?? 0),
      changes: t.changes + (f.changes ?? (f.additions ?? 0) + (f.deletions ?? 0)),
      files: t.files + 1,
    }),
    { additions: 0, deletions: 0, changes: 0, files: 0 }
  );
}

export function commitFilesNote(count: number): string | null {
  if (count >= COMMIT_FILES_MAX) {
    return `Note: GitHub returns at most ${COMMIT_FILES_MAX} files for a single commit — this commit may touch more. The Stats line above is still the full total.`;
  }
  return null;
}

// Files in list_commits(include_stats) come from the first page of the commit
// detail only (one call per commit).
export function listFilesNote(c: GhCommit): string | null {
  if (c.files && c.files.length >= 300) {
    return `  Note: only the first ${c.files.length} files are listed for this commit; call get_commit for the full list. The Stats line is the full total.`;
  }
  return null;
}

export function compareLimitNotes(
  head: string,
  totalCommits: number,
  shownCommits: number,
  files: number | undefined
): string[] {
  const notes: string[] = [];
  if (totalCommits > shownCommits) {
    notes.push(
      `Note: ${totalCommits} commits differ but GitHub returns at most ${COMPARE_MAX_COMMITS} in a comparison (${shownCommits} listed). Use list_commits on '${head}' with since/until to see the rest.`
    );
  }
  if (files !== undefined && files >= COMPARE_MAX_FILES) {
    notes.push(
      `Note: GitHub returns at most ${COMPARE_MAX_FILES} files in a comparison — the file list and the totals below may be incomplete.`
    );
  }
  return notes;
}

// ---------- Errors ----------

type HttpError = { status?: number; message?: string; response?: { data?: { message?: string } } };

// Turns GitHub's raw errors into messages that say what to do next. Anything
// not recognized is returned unchanged (null) so the caller rethrows it.
export function historyErrorMessage(err: unknown, where: string): string | null {
  const e = err as HttpError;
  const ghMessage = e.response?.data?.message ?? e.message ?? "";
  if (e.status === 409 && /empty/i.test(ghMessage)) {
    return `${where} has no commits yet (empty repository).`;
  }
  if (e.status === 422 || (e.status === 404 && /no commit found|not found for/i.test(ghMessage))) {
    return `${where}: the branch, tag or SHA given does not exist (GitHub: "${ghMessage}"). Check the name, or use get_branch_head to read a branch's current SHA.`;
  }
  if (e.status === 404) {
    return `${where} was not found, or the account used can't read it. Check owner/repo and the ref, or pass 'account'.`;
  }
  return null;
}
