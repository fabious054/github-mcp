// GitHub Projects (v2) board management — issue #104, ADR 0019.
// GraphQL documents, field/option/iteration resolution by name, value
// coercion and formatting. Pure, so the rules can be tested without GitHub.

// ---------- GraphQL documents ----------

export const PROJECT_FIELDS_FRAGMENT = `
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color description } }
      ... on ProjectV2IterationField {
        configuration {
          duration
          iterations { id title startDate duration }
          completedIterations { id title startDate duration }
        }
      }
    }
  }`;

export const LIST_PROJECTS_QUERY = `query($login: String!, $first: Int!, $after: String) {
  repositoryOwner(login: $login) {
    login
    ... on ProjectV2Owner {
      projectsV2(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { number title url closed updatedAt shortDescription items { totalCount } }
      }
    }
  }
}`;

export const GET_PROJECT_QUERY = `query($login: String!, $number: Int!) {
  repositoryOwner(login: $login) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        id number title url closed shortDescription viewerCanUpdate
        items { totalCount }
        ${PROJECT_FIELDS_FRAGMENT}
        repositories(first: 20) { nodes { nameWithOwner } }
        views(first: 20) { nodes { number name layout } }
      }
    }
  }
}`;

export const ITEM_FIELDS_FRAGMENT = `
  id type isArchived
  content {
    __typename
    ... on Issue { number title state url repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
    ... on PullRequest { number title state url repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
    ... on DraftIssue { title }
  }
  fieldValues(first: 30) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldIterationValue { title startDate field { ... on ProjectV2FieldCommon { name } } }
    }
  }`;

// `ProjectV2.items` returns only non-archived items unless `archivedStates`
// asks for archived ones too (GitHub default: [NOT_ARCHIVED]) — issue #107.
export const LIST_ITEMS_QUERY = `query($id: ID!, $first: Int!, $after: String, $archivedStates: [ProjectV2ItemArchivedState!]) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: $first, after: $after, archivedStates: $archivedStates) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { ${ITEM_FIELDS_FRAGMENT} }
      }
    }
  }
}`;

export type ArchivedState = "ARCHIVED" | "NOT_ARCHIVED";

// Value of `archivedStates` for LIST_ITEMS_QUERY.
export function archivedStatesFor(includeArchived: boolean): ArchivedState[] {
  return includeArchived ? ["NOT_ARCHIVED", "ARCHIVED"] : ["NOT_ARCHIVED"];
}

export const CONTENT_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { id projectItems(first: 50, includeArchived: true) { nodes { id project { id } } } }
      ... on PullRequest { id projectItems(first: 50, includeArchived: true) { nodes { id project { id } } } }
    }
  }
}`;

export const ITEM_BY_ID_QUERY = `query($id: ID!) {
  node(id: $id) { ... on ProjectV2Item { ${ITEM_FIELDS_FRAGMENT} project { id } } }
}`;

export const ADD_ITEM_MUTATION = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;

export const ADD_DRAFT_MUTATION = `mutation($projectId: ID!, $title: String!, $body: String) {
  addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) { projectItem { id } }
}`;

export const UPDATE_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } }
}`;

export const CLEAR_FIELD_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
}`;

export const MOVE_ITEM_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $afterId: ID) {
  updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId, afterId: $afterId }) { clientMutationId }
}`;

export const ARCHIVE_ITEM_MUTATION = `mutation($projectId: ID!, $itemId: ID!) {
  archiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
}`;

export const UNARCHIVE_ITEM_MUTATION = `mutation($projectId: ID!, $itemId: ID!) {
  unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { item { id } }
}`;

export const DELETE_ITEM_MUTATION = `mutation($projectId: ID!, $itemId: ID!) {
  deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
}`;

// ---------- Shapes ----------

export type Iteration = { id: string; title: string; startDate: string; duration: number };

export type Field = {
  __typename: string;
  id: string;
  name: string;
  dataType: string;
  options?: { id: string; name: string; color?: string | null; description?: string | null }[];
  configuration?: { duration: number; iterations: Iteration[]; completedIterations: Iteration[] };
};

export type Project = {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  shortDescription?: string | null;
  viewerCanUpdate?: boolean;
  items: { totalCount: number };
  fields: { nodes: Field[] };
  repositories?: { nodes: { nameWithOwner: string }[] };
  views?: { nodes: { number: number; name: string; layout: string }[] };
};

export type FieldValueNode = {
  __typename: string;
  name?: string;
  text?: string;
  number?: number;
  date?: string;
  title?: string;
  startDate?: string;
  field?: { name?: string };
};

export type Item = {
  id: string;
  type: string;
  isArchived: boolean;
  content: {
    __typename: string;
    number?: number;
    title?: string;
    state?: string;
    url?: string;
    repository?: { nameWithOwner: string };
    assignees?: { nodes: { login: string }[] };
  } | null;
  fieldValues: { nodes: FieldValueNode[] };
};

// ---------- Field values ----------

// Field values of an item as `{ fieldName: displayValue }`. The built-in
// Title field is left out (it is the item's title).
export function itemValues(item: Item): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of item.fieldValues.nodes) {
    const name = v.field?.name;
    if (!name || name === "Title") continue;
    if (v.name !== undefined) out[name] = v.name;
    else if (v.text !== undefined) out[name] = v.text;
    else if (v.number !== undefined) out[name] = String(v.number);
    else if (v.date !== undefined) out[name] = v.date.slice(0, 10);
    else if (v.title !== undefined) out[name] = `${v.title}${v.startDate ? ` (from ${v.startDate})` : ""}`;
  }
  return out;
}

export function itemRef(item: Item): string {
  const c = item.content;
  if (!c) return "(item without content — no access, or deleted)";
  if (c.__typename === "DraftIssue") return `draft: ${c.title ?? ""}`;
  return `${c.repository?.nameWithOwner ?? "?"}#${c.number} ${c.title ?? ""}`;
}

export function formatItem(item: Item): string {
  const c = item.content;
  const kind = c?.__typename === "PullRequest" ? "PR" : c?.__typename === "Issue" ? "issue" : c?.__typename === "DraftIssue" ? "draft" : "?";
  const state = c?.state ? `, ${c.state.toLowerCase()}` : "";
  const assignees = c?.assignees?.nodes.length ? ` · assignees: ${c.assignees.nodes.map((a) => a.login).join(", ")}` : "";
  const values = Object.entries(itemValues(item))
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  return `  [${kind}${state}${item.isArchived ? ", archived" : ""}] ${itemRef(item)}${assignees}${values ? ` · ${values}` : ""} · item ${item.id}`;
}

// "Status=In progress" → match on the item's value, case-insensitive.
export function parseFilter(filter: string | undefined): { field: string; value: string } | null {
  if (!filter) return null;
  const i = filter.indexOf("=");
  if (i <= 0) throw new Error(`Filter must look like 'Field=Value', e.g. 'Status=In progress'. Got '${filter}'.`);
  return { field: filter.slice(0, i).trim(), value: filter.slice(i + 1).trim() };
}

export function matchesFilter(item: Item, f: { field: string; value: string } | null): boolean {
  if (!f) return true;
  const values = itemValues(item);
  const key = Object.keys(values).find((k) => k.toLowerCase() === f.field.toLowerCase());
  const v = key ? values[key] : "";
  if (f.value === "" || f.value.toLowerCase() === "(empty)") return !v;
  return v.toLowerCase() === f.value.toLowerCase();
}

// ---------- Field resolution by name ----------

// Built-in fields that belong to the issue/PR itself, not to the project.
const READ_ONLY_BUILTINS = new Set([
  "TITLE",
  "ASSIGNEES",
  "LABELS",
  "LINKED_PULL_REQUESTS",
  "MILESTONE",
  "REPOSITORY",
  "REVIEWERS",
  "TRACKED_BY",
  "TRACKS",
  "PARENT_ISSUE",
  "SUB_ISSUES_PROGRESS",
]);

const names = (xs: { name: string }[]) => xs.map((x) => `'${x.name}'`).join(", ");

export function findField(project: Project, name: string): Field {
  const fields = project.fields.nodes.filter((f) => f.name);
  const f = fields.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!f) {
    const editable = fields.filter((x) => !READ_ONLY_BUILTINS.has(x.dataType));
    throw new Error(`Field '${name}' not found in project '${project.title}'. Fields you can set: ${names(editable)}.`);
  }
  if (READ_ONLY_BUILTINS.has(f.dataType)) {
    throw new Error(
      `'${f.name}' belongs to the issue/PR itself, not to the project, so it can't be set here (issue fields like labels, assignees and milestone come in the issue tools).`
    );
  }
  return f;
}

export type FieldValue =
  | { singleSelectOptionId: string }
  | { text: string }
  | { number: number }
  | { date: string }
  | { iterationId: string };

export type ResolvedValue = { field: Field; value: FieldValue | null; display: string };

function currentIteration(its: Iteration[], today: string): Iteration | undefined {
  return its.find((it) => {
    const start = Date.parse(`${it.startDate}T00:00:00Z`);
    const end = start + it.duration * 86_400_000;
    const t = Date.parse(`${today}T00:00:00Z`);
    return t >= start && t < end;
  });
}

// Turns a user value into the GraphQL `ProjectV2FieldValue` for that field.
// `null` (or an empty string) clears the field.
export function resolveValue(project: Project, fieldName: string, raw: string | number | null, today = new Date().toISOString().slice(0, 10)): ResolvedValue {
  const field = findField(project, fieldName);
  if (raw === null || raw === "") return { field, value: null, display: "(cleared)" };
  const s = String(raw).trim();
  switch (field.dataType) {
    case "SINGLE_SELECT": {
      const opts = field.options ?? [];
      const o = opts.find((x) => x.name.toLowerCase() === s.toLowerCase());
      if (!o) throw new Error(`'${s}' is not an option of '${field.name}'. Options: ${names(opts)}.`);
      return { field, value: { singleSelectOptionId: o.id }, display: o.name };
    }
    case "TEXT":
      return { field, value: { text: s }, display: s };
    case "NUMBER": {
      const n = typeof raw === "number" ? raw : Number(s);
      if (!Number.isFinite(n)) throw new Error(`'${field.name}' is a number field; '${s}' is not a number.`);
      return { field, value: { number: n }, display: String(n) };
    }
    case "DATE": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
        throw new Error(`'${field.name}' is a date field; use YYYY-MM-DD (got '${s}').`);
      }
      return { field, value: { date: s }, display: s };
    }
    case "ITERATION": {
      const cfg = field.configuration ?? { duration: 0, iterations: [], completedIterations: [] };
      const upcoming = [...cfg.iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
      const all = [...cfg.completedIterations, ...upcoming];
      let it: Iteration | undefined;
      if (s.toLowerCase() === "@current") {
        it = currentIteration(all, today);
        if (!it) throw new Error(`No iteration of '${field.name}' covers today (${today}). Iterations: ${all.map((x) => `'${x.title}'`).join(", ")}.`);
      } else if (s.toLowerCase() === "@next") {
        const cur = currentIteration(all, today);
        it = upcoming.find((x) => x.startDate > (cur?.startDate ?? today));
        if (!it) throw new Error(`No iteration of '${field.name}' after the current one.`);
      } else {
        it = all.find((x) => x.title.toLowerCase() === s.toLowerCase());
        if (!it) throw new Error(`'${s}' is not an iteration of '${field.name}'. Iterations: ${all.map((x) => `'${x.title}'`).join(", ")}, or '@current' / '@next'.`);
      }
      return { field, value: { iterationId: it.id }, display: `${it.title} (from ${it.startDate})` };
    }
    default:
      throw new Error(`Field '${field.name}' has type ${field.dataType}, which can't be set through the API.`);
  }
}

// ---------- Formatting ----------

export function formatProject(p: Project, owner: string, today = new Date().toISOString().slice(0, 10)): string {
  const lines = [
    `Project ${owner}#${p.number}: ${p.title}${p.closed ? " (closed)" : ""}`,
    `URL: ${p.url}`,
    `Items: ${p.items.totalCount}${p.viewerCanUpdate === false ? " · you can read but not edit this project" : ""}`,
  ];
  if (p.shortDescription) lines.push(`Description: ${p.shortDescription}`);
  lines.push("", "Fields:");
  for (const f of p.fields.nodes.filter((x) => x.name)) {
    const ro = READ_ONLY_BUILTINS.has(f.dataType) ? " (from the issue/PR — not settable here)" : "";
    let extra = "";
    if (f.dataType === "SINGLE_SELECT") extra = `: ${(f.options ?? []).map((o) => o.name).join(" | ")}`;
    if (f.dataType === "ITERATION" && f.configuration) {
      const all = [...f.configuration.completedIterations, ...f.configuration.iterations];
      const cur = currentIteration(all, today);
      extra = `: ${f.configuration.iterations
        .map((it) => `${it.title} (${it.startDate}, ${it.duration}d)${cur?.id === it.id ? " ← current" : ""}`)
        .join(" | ")}`;
    }
    lines.push(`  ${f.name} [${f.dataType.toLowerCase()}]${ro}${extra}`);
  }
  const repos = p.repositories?.nodes ?? [];
  if (repos.length) lines.push("", `Linked repositories: ${repos.map((r) => r.nameWithOwner).join(", ")}`);
  const views = p.views?.nodes ?? [];
  if (views.length) lines.push(`Views (read-only): ${views.map((v) => `${v.name} [${v.layout.replace("_LAYOUT", "").toLowerCase()}]`).join(", ")}`);
  return lines.join("\n");
}

// ---------- Errors ----------

type GqlError = { type?: string; message?: string };

// GitHub returns INSUFFICIENT_SCOPES when the token lacks `project`.
export function isMissingProjectScope(err: unknown): boolean {
  const e = err as { errors?: GqlError[]; message?: string };
  if (e.errors?.some((x) => x.type === "INSUFFICIENT_SCOPES")) return true;
  return /INSUFFICIENT_SCOPES|required scopes.*project|has not been granted the required scopes/i.test(e.message ?? "");
}

export const MISSING_SCOPE_MESSAGE =
  "This account's GitHub authorization doesn't include project access yet (the 'project' scope, added to the connector on 2026-11-27). Reconnect the connector once to accept it; for an account linked with 'link_account', run 'link_account' again for that account. Everything else keeps working meanwhile.";

export function isNotFound(err: unknown): boolean {
  const e = err as { errors?: GqlError[]; status?: number };
  return e.status === 404 || Boolean(e.errors?.some((x) => x.type === "NOT_FOUND"));
}

// "owner/repo#123" or a GitHub issue/PR URL → parts.
export function parseItemRef(ref: string): { owner: string; repo: string; number: number } | null {
  const url = ref.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
  const short = ref.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
  return null;
}
