// Issue management — issue #109, ADR 0020.
// GraphQL documents, name resolution (labels, milestones, assignees, types),
// add/remove list computation and formatting. Pure, so the rules can be
// tested without GitHub.

// ---------- GraphQL documents ----------

export const ISSUE_FIELDS = `
  id number title state stateReason url body
  repository { nameWithOwner }
  labels(first: 100) { nodes { id name } }
  assignees(first: 20) { nodes { id login } }
  milestone { id title }
  issueType { id name }
  duplicateOf { number repository { nameWithOwner } }
  parent { number title state repository { nameWithOwner } }
  subIssuesSummary { total completed percentCompleted }
  subIssues(first: 50) { nodes { number title state repository { nameWithOwner } } }`;

// Everything a write needs to resolve names, in one round trip. `withIssue`
// is false for create_issue (no issue yet).
export const REPO_CONTEXT_QUERY = `query($owner: String!, $name: String!, $number: Int!, $withIssue: Boolean!) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner isInOrganization
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { id name } }
    milestones(first: 100, states: [OPEN, CLOSED], orderBy: { field: DUE_DATE, direction: ASC }) { nodes { id title state } }
    issueTypes(first: 50) { nodes { id name } }
    issue(number: $number) @include(if: $withIssue) { ${ISSUE_FIELDS} }
  }
}`;

export const ASSIGNABLE_USERS_QUERY = `query($owner: String!, $name: String!, $q: String!) {
  repository(owner: $owner, name: $name) { assignableUsers(first: 20, query: $q) { nodes { id login } } }
}`;

export const ISSUE_REF_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { id number title url repository { nameWithOwner } } }
}`;

export const ISSUE_VIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
}`;

export const UPDATE_ISSUE_MUTATION = `mutation($input: UpdateIssueInput!) {
  updateIssue(input: $input) { issue { ${ISSUE_FIELDS} } }
}`;

export const CREATE_ISSUE_MUTATION = `mutation($input: CreateIssueInput!) {
  createIssue(input: $input) { issue { ${ISSUE_FIELDS} } }
}`;

export const ADD_SUB_ISSUE_MUTATION = `mutation($issueId: ID!, $subIssueId: ID!, $replaceParent: Boolean) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId, replaceParent: $replaceParent }) { issue { ${ISSUE_FIELDS} } }
}`;

export const REMOVE_SUB_ISSUE_MUTATION = `mutation($issueId: ID!, $subIssueId: ID!) {
  removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { ${ISSUE_FIELDS} } }
}`;

export const UPDATE_ISSUE_COMMENT_MUTATION = `mutation($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id url updatedAt } }
}`;

export const UPDATE_REVIEW_COMMENT_MUTATION = `mutation($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { pullRequestReviewComment { id url updatedAt } }
}`;

// ---------- Shapes ----------

type Named = { id: string; name: string };
type RepoRef = { nameWithOwner: string };
type LinkedIssue = { number: number; title?: string; state?: string; repository: RepoRef };

export type IssueView = {
  id: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  url: string;
  body: string | null;
  repository: RepoRef;
  labels: { nodes: Named[] };
  assignees: { nodes: { id: string; login: string }[] };
  milestone: { id: string; title: string } | null;
  issueType: Named | null;
  duplicateOf: LinkedIssue | null;
  parent: LinkedIssue | null;
  subIssuesSummary: { total: number; completed: number; percentCompleted: number };
  subIssues: { nodes: LinkedIssue[] };
};

export type RepoContext = {
  id: string;
  nameWithOwner: string;
  isInOrganization: boolean;
  labels: { nodes: Named[] };
  milestones: { nodes: { id: string; title: string; state: string }[] };
  issueTypes: { nodes: Named[] } | null;
  issue?: IssueView | null;
};

// ---------- Name resolution ----------

const quoted = (xs: string[]) => (xs.length ? xs.map((x) => `'${x}'`).join(", ") : "(none)");
const norm = (s: string) => s.trim().toLowerCase();

// Resolves names to IDs, case-insensitively. Collects every unknown name so
// the caller sees all mistakes at once; nothing is written on error. `kind`
// is singular ("Label"); it is pluralized when more than one name is unknown.
export function resolveNames(kind: string, repo: string, all: Named[], names: string[]): Named[] {
  const out: Named[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const hit = all.find((x) => norm(x.name) === norm(n));
    if (hit) out.push(hit);
    else missing.push(n);
  }
  if (missing.length) {
    const what = missing.length === 1 ? kind : `${kind}s`;
    throw new Error(`${what} ${quoted(missing)} not found in ${repo}. Available: ${quoted(all.map((x) => x.name))}. Nothing was changed.`);
  }
  return out;
}

export function resolveLabels(ctx: RepoContext, names: string[]): Named[] {
  return resolveNames("Label", ctx.nameWithOwner, ctx.labels.nodes, names);
}

export function resolveMilestone(ctx: RepoContext, title: string): { id: string; title: string } {
  const all = ctx.milestones.nodes;
  const hit = all.find((m) => norm(m.title) === norm(title));
  if (!hit) {
    throw new Error(
      `Milestone '${title}' not found in ${ctx.nameWithOwner}. Available: ${quoted(all.map((m) => `${m.title}${m.state === "CLOSED" ? " (closed)" : ""}`))}. Nothing was changed.`
    );
  }
  return hit;
}

export const TYPES_ORG_ONLY =
  "Issue types are only available on organization repositories; this repository belongs to a user. Nothing was changed.";

export function resolveType(ctx: RepoContext, name: string): Named {
  if (!ctx.isInOrganization) throw new Error(TYPES_ORG_ONLY.replace("this repository", ctx.nameWithOwner));
  const all = ctx.issueTypes?.nodes ?? [];
  if (!all.length) throw new Error(`${ctx.nameWithOwner} has no issue types enabled. Nothing was changed.`);
  return resolveNames("Issue type", ctx.nameWithOwner, all, [name])[0];
}

// Final list after add/remove, keeping the current order. Removing something
// that isn't there, or adding something already there, is a no-op.
export function applyAddRemove<T extends { id: string }>(current: T[], add: T[], remove: T[]): T[] {
  const removeIds = new Set(remove.map((x) => x.id));
  const out = current.filter((x) => !removeIds.has(x.id));
  for (const a of add) if (!out.some((x) => x.id === a.id) && !removeIds.has(a.id)) out.push(a);
  return out;
}

export function overlap(a: string[] | undefined, b: string[] | undefined): string[] {
  if (!a || !b) return [];
  const bs = new Set(b.map(norm));
  return a.filter((x) => bs.has(norm(x)));
}

// '#12' (same repo), 'owner/repo#12' or an issue URL.
export function parseIssueRef(ref: string, defaultOwner: string, defaultRepo: string): { owner: string; repo: string; number: number } | null {
  const r = ref.trim();
  const url = r.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const full = r.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (full) return { owner: full[1], repo: full[2], number: Number(full[3]) };
  const short = r.match(/^#?(\d+)$/);
  if (short) return { owner: defaultOwner, repo: defaultRepo, number: Number(short[1]) };
  return null;
}

// ---------- State ----------

export type StateArgs = {
  state?: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "duplicate";
  duplicate_of?: string;
};

// Validates the state arguments and returns the target, or null when the
// state isn't being changed. A close reason (or duplicate_of) implies closing.
export function planState(a: StateArgs): { value: "OPEN" | "CLOSED"; reason?: "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" } | null {
  if (a.duplicate_of && a.state_reason && a.state_reason !== "duplicate") {
    throw new Error(`'duplicate_of' only goes with state_reason 'duplicate' (got '${a.state_reason}').`);
  }
  const reason = a.state_reason ?? (a.duplicate_of ? "duplicate" : undefined);
  if (a.state === "open") {
    if (reason) throw new Error("A close reason ('state_reason' / 'duplicate_of') can't be used when reopening (state 'open').");
    return { value: "OPEN" };
  }
  if (a.state === "closed" || reason) {
    const r = reason ?? "completed";
    if (r === "duplicate" && !a.duplicate_of) throw new Error("Closing as duplicate needs 'duplicate_of': the original issue ('#12', 'owner/repo#12' or its URL).");
    return { value: "CLOSED", reason: r.toUpperCase() as "COMPLETED" | "NOT_PLANNED" | "DUPLICATE" };
  }
  return null;
}

// ---------- Comments ----------

// GraphQL node IDs tell the comment kind apart: IC_… are issue / PR
// conversation comments, PRRC_… are PR inline review comments.
export function checkCommentKind(id: string, kind: "conversation" | "review"): void {
  const t = id.trim();
  if (/^\d+$/.test(t)) {
    throw new Error(`'${t}' looks like a numeric REST ID. Use the comment's node ID (IC_… or PRRC_…) shown by get_issue or list_pr_comments.`);
  }
  const isConv = t.startsWith("IC_");
  const isReview = t.startsWith("PRRC_");
  if (kind === "conversation" && isReview) {
    throw new Error(`'${t}' is a PR inline review comment — use kind 'review'. Nothing was edited.`);
  }
  if (kind === "review" && isConv) {
    throw new Error(`'${t}' is an issue / PR conversation comment — use kind 'conversation'. Nothing was edited.`);
  }
  if (!isConv && !isReview) {
    throw new Error(`'${t}' is not a comment ID. Use the ID shown by get_issue (IC_…) or list_pr_comments (IC_… / PRRC_…).`);
  }
}

// ---------- Formatting ----------

const ref = (i: LinkedIssue, home: string) => `${i.repository.nameWithOwner === home ? "" : i.repository.nameWithOwner}#${i.number}`;

export function stateText(i: Pick<IssueView, "state" | "stateReason">): string {
  if (i.state === "OPEN") return i.stateReason === "REOPENED" ? "open (reopened)" : "open";
  const r = i.stateReason ? i.stateReason.toLowerCase().replace("_", " ") : "closed";
  return `closed (${r})`;
}

// Header lines shared by get_issue and every write tool.
export function formatIssue(i: IssueView): string {
  const home = i.repository.nameWithOwner;
  const lines = [`${home}#${i.number} [${stateText(i)}] ${i.title}`, `URL: ${i.url}`];
  if (i.duplicateOf) lines.push(`Duplicate of: ${ref(i.duplicateOf, home)}`);
  lines.push(`Labels: ${i.labels.nodes.length ? i.labels.nodes.map((l) => l.name).join(", ") : "(none)"}`);
  lines.push(`Assignees: ${i.assignees.nodes.length ? i.assignees.nodes.map((a) => a.login).join(", ") : "(none)"}`);
  lines.push(`Milestone: ${i.milestone?.title ?? "(none)"}`);
  if (i.issueType) lines.push(`Type: ${i.issueType.name}`);
  if (i.parent) lines.push(`Parent: ${ref(i.parent, home)} ${i.parent.title ?? ""}`.trimEnd());
  const s = i.subIssuesSummary;
  if (s.total) {
    lines.push(`Sub-issues: ${s.completed}/${s.total} done (${s.percentCompleted}%)`);
    for (const c of i.subIssues.nodes) lines.push(`  ${ref(c, home)} [${(c.state ?? "").toLowerCase()}] ${c.title ?? ""}`);
    if (i.subIssues.nodes.length < s.total) lines.push(`  … ${s.total - i.subIssues.nodes.length} more`);
  }
  return lines.join("\n");
}

// What changed, for the write tools' first line.
export function diffIssue(before: IssueView, after: IssueView): string[] {
  const out: string[] = [];
  if (before.title !== after.title) out.push("title");
  if ((before.body ?? "") !== (after.body ?? "")) out.push("body");
  if (before.state !== after.state || before.stateReason !== after.stateReason) out.push(`state → ${stateText(after)}`);
  const names = (xs: { name: string }[]) => xs.map((x) => x.name);
  const added = names(after.labels.nodes).filter((n) => !names(before.labels.nodes).includes(n));
  const removed = names(before.labels.nodes).filter((n) => !names(after.labels.nodes).includes(n));
  if (added.length) out.push(`+labels ${added.join(", ")}`);
  if (removed.length) out.push(`−labels ${removed.join(", ")}`);
  const logins = (xs: { login: string }[]) => xs.map((x) => x.login);
  const aAdd = logins(after.assignees.nodes).filter((n) => !logins(before.assignees.nodes).includes(n));
  const aRem = logins(before.assignees.nodes).filter((n) => !logins(after.assignees.nodes).includes(n));
  if (aAdd.length) out.push(`+assignees ${aAdd.join(", ")}`);
  if (aRem.length) out.push(`−assignees ${aRem.join(", ")}`);
  if ((before.milestone?.id ?? null) !== (after.milestone?.id ?? null)) out.push(`milestone → ${after.milestone?.title ?? "(none)"}`);
  if ((before.issueType?.id ?? null) !== (after.issueType?.id ?? null)) out.push(`type → ${after.issueType?.name ?? "(none)"}`);
  return out;
}
