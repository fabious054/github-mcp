// Board structure, piece 3b — issue #121, ADR 0021.
// Labels and milestones (REST, per repository) and issue types (GraphQL, per
// organization): name resolution, input parsing, formatting and GraphQL
// documents. Pure, so the rules can be tested without GitHub.

// ---------- Shared ----------

const norm = (s: string) => s.trim().toLowerCase();
const quoted = (xs: string[]) => (xs.length ? xs.map((x) => `'${x}'`).join(", ") : "(none)");

// Case-insensitive lookup; an unknown name lists every valid one and nothing
// is written (same rule as phases 1–3a).
export function findByName<T>(kind: string, where: string, all: T[], name: string, nameOf: (x: T) => string): T {
  const hit = all.find((x) => norm(nameOf(x)) === norm(name));
  if (!hit) throw new Error(`${kind} '${name}' not found in ${where}. Available: ${quoted(all.map(nameOf))}. Nothing was changed.`);
  return hit;
}

// A rename or a create must not collide with another entry (GitHub matches
// these names case-insensitively too). `except` is the entry being renamed.
export function checkNameFree<T>(kind: string, where: string, all: T[], name: string, nameOf: (x: T) => string, except?: T): void {
  const clash = all.find((x) => x !== except && norm(nameOf(x)) === norm(name));
  const k = kind.toLowerCase();
  if (clash) throw new Error(`${where} already has ${/^[aeiou]/.test(k) ? "an" : "a"} ${k} named '${nameOf(clash)}'. Nothing was changed.`);
}

export function checkName(kind: string, name: string): string {
  const n = name.trim();
  if (!n) throw new Error(`A ${kind.toLowerCase()} name can't be empty. Nothing was changed.`);
  return n;
}

// ---------- Labels ----------

export type Label = { name: string; color: string; description: string | null };

export const DEFAULT_LABEL_COLOR = "ededed"; // GitHub's default label gray

// Accepts 'd73a4a' or '#d73a4a' (any case); GitHub wants 6 hex digits, no '#'.
export function parseLabelColor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const c = raw.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(c)) throw new Error(`'${raw}' is not a label color. Use 6 hex digits, e.g. 'd73a4a' or '#d73a4a'. Nothing was changed.`);
  return c;
}

export function formatLabel(l: Label): string {
  return `${l.name} (#${l.color})${l.description ? ` — ${l.description}` : ""}`;
}

export const LABEL_USAGE_QUERY = `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    label(name: $label) {
      openIssues: issues(states: [OPEN]) { totalCount }
      closedIssues: issues(states: [CLOSED]) { totalCount }
      openPrs: pullRequests(states: [OPEN]) { totalCount }
      closedPrs: pullRequests(states: [CLOSED, MERGED]) { totalCount }
    }
  }
}`;

export type LabelUsage = {
  openIssues: { totalCount: number };
  closedIssues: { totalCount: number };
  openPrs: { totalCount: number };
  closedPrs: { totalCount: number };
};

export function labelUsageText(u: LabelUsage | null): string {
  if (!u) return "usage unknown";
  const issues = u.openIssues.totalCount + u.closedIssues.totalCount;
  const prs = u.openPrs.totalCount + u.closedPrs.totalCount;
  return `on ${issues} issue(s) (${u.openIssues.totalCount} open) and ${prs} pull request(s) (${u.openPrs.totalCount} open)`;
}

// ---------- Milestones ----------

export type Milestone = {
  number: number;
  title: string;
  state: string; // "open" | "closed"
  description: string | null;
  due_on: string | null;
  open_issues: number;
  closed_issues: number;
  html_url?: string;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// GitHub stores a milestone's due date as a timestamp and shows it as a date.
// Sending midnight UTC can show up as the day before in American time zones,
// so the date is sent at noon UTC and read back as its date part.
export function parseDueOn(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const d = raw.trim();
  if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T12:00:00Z`)) || new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) !== d) {
    throw new Error(`due_on must be a date as YYYY-MM-DD (got '${raw}'). Nothing was changed.`);
  }
  return `${d}T12:00:00Z`;
}

export function formatMilestone(m: Milestone): string {
  const total = m.open_issues + m.closed_issues;
  const pct = total ? Math.round((m.closed_issues / total) * 100) : 0;
  const due = m.due_on ? ` · due ${m.due_on.slice(0, 10)}` : "";
  const desc = m.description ? ` — ${m.description}` : "";
  return `${m.title} [${m.state}]${due} · ${m.closed_issues}/${total} closed (${pct}%)${desc}`;
}

export function milestoneLabel(m: Pick<Milestone, "title" | "state">): string {
  return `${m.title}${m.state === "closed" ? " (closed)" : ""}`;
}

// ---------- Issue types (organizations) ----------

export const ISSUE_TYPE_COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"] as const;
export type IssueTypeColor = (typeof ISSUE_TYPE_COLORS)[number];

export function parseTypeColor(raw: string | undefined): IssueTypeColor | undefined {
  if (raw === undefined) return undefined;
  const c = raw.trim().toUpperCase();
  if ((ISSUE_TYPE_COLORS as readonly string[]).includes(c)) return c as IssueTypeColor;
  throw new Error(`'${raw}' is not an issue type color. Colors: ${ISSUE_TYPE_COLORS.map((x) => x.toLowerCase()).join(", ")}. Nothing was changed.`);
}

export type IssueType = { id: string; name: string; description: string | null; color: string; isEnabled: boolean };

const ISSUE_TYPE_FIELDS = `id name description color isEnabled`;

export const ORG_ISSUE_TYPES_QUERY = `query($login: String!) {
  repositoryOwner(login: $login) {
    __typename id login
    ... on Organization {
      viewerCanAdminister
      issueTypes(first: 100) { nodes { ${ISSUE_TYPE_FIELDS} } }
    }
  }
}`;

export type OrgIssueTypes = {
  repositoryOwner: {
    __typename: string;
    id: string;
    login: string;
    viewerCanAdminister?: boolean;
    issueTypes?: { nodes: IssueType[] } | null;
  } | null;
};

export const CREATE_ISSUE_TYPE_MUTATION = `mutation($input: CreateIssueTypeInput!) {
  createIssueType(input: $input) { issueType { ${ISSUE_TYPE_FIELDS} } }
}`;

export const UPDATE_ISSUE_TYPE_MUTATION = `mutation($input: UpdateIssueTypeInput!) {
  updateIssueType(input: $input) { issueType { ${ISSUE_TYPE_FIELDS} } }
}`;

export const DELETE_ISSUE_TYPE_MUTATION = `mutation($id: ID!) {
  deleteIssueType(input: { issueTypeId: $id }) { deletedIssueTypeId }
}`;

export const ORG_ONLY_TYPES = (login: string) =>
  `'${login}' is a user account. Issue types are only available on organizations. Nothing was changed.`;

export const NEEDS_ORG_OWNER = (login: string, account: string) =>
  `Account '${account}' can't manage issue types in '${login}': only organization owners can. Nothing was changed. If another linked account is an owner, repeat the call with 'account' set to it.`;

export function formatIssueType(t: IssueType): string {
  return `${t.name} (${t.color.toLowerCase()})${t.isEnabled ? "" : " [disabled]"}${t.description ? ` — ${t.description}` : ""}`;
}

// Search query for the issues using a type across an organization (the
// GraphQL `IssueType.issues` connection needs a repository).
export function issueTypeSearch(org: string, name: string): string {
  return `org:${org} is:issue type:"${name.replace(/"/g, "")}"`;
}
