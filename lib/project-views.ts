// Board structure, piece 3c — issue #125, ADR 0021.
// Project views (name, layout, filter, visible fields) and project status
// updates: GraphQL documents, input parsing, name resolution and formatting.
// Pure, so the rules can be tested without GitHub.

import type { Field } from "./projects";

const norm = (s: string) => s.trim().toLowerCase();
const quoted = (xs: string[]) => (xs.length ? xs.map((x) => `'${x}'`).join(", ") : "(none)");

// ---------- Views ----------

export const VIEW_LAYOUTS = ["table", "board", "roadmap"] as const;
export type ViewLayout = (typeof VIEW_LAYOUTS)[number];
export const layoutEnum = (l: ViewLayout) => `${l.toUpperCase()}_LAYOUT`;
const layoutName = (l: string) => l.replace("_LAYOUT", "").toLowerCase();

// GitHub's API sets a view's name, layout, filter and visible fields only.
export const VIEW_API_LIMIT =
  "Grouping, sorting, column width and field sums can't be set through GitHub's API — only in the project's web UI.";

const VIEW_FIELDS = `id number name layout filter fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name } } }`;

export const PROJECT_VIEWS_QUERY = `query($id: ID!) {
  node(id: $id) { ... on ProjectV2 { views(first: 50) { nodes { ${VIEW_FIELDS} } } } }
}`;

export const CREATE_VIEW_MUTATION = `mutation($input: CreateProjectV2ViewInput!) {
  createProjectV2View(input: $input) { projectV2View { ${VIEW_FIELDS} } }
}`;

export const UPDATE_VIEW_MUTATION = `mutation($input: UpdateProjectV2ViewInput!) {
  updateProjectV2View(input: $input) { projectV2View { ${VIEW_FIELDS} } }
}`;

export const DELETE_VIEW_MUTATION = `mutation($id: ID!) {
  deleteProjectV2View(input: { viewId: $id }) { projectV2View { id } }
}`;

export type View = {
  id: string;
  number: number;
  name: string;
  layout: string;
  filter: string | null;
  fields: { nodes: ({ id?: string; name?: string } | null)[] } | null;
};

// A view by name (case-insensitive) or by number ("2" or "#2").
export function findView(views: View[], ref: string, project: string): View {
  const num = /^#?(\d+)$/.exec(ref.trim());
  const hit = num ? views.find((v) => v.number === Number(num[1])) : views.find((v) => norm(v.name) === norm(ref));
  if (!hit) {
    throw new Error(`View '${ref}' not found in project '${project}'. Views: ${quoted(views.map((v) => `${v.name} (#${v.number})`))}. Nothing was changed.`);
  }
  return hit;
}

export function checkViewName(views: View[], name: string, project: string, except?: View): string {
  const n = name.trim();
  if (!n) throw new Error("A view name can't be empty. Nothing was changed.");
  const clash = views.find((v) => v !== except && norm(v.name) === norm(n));
  if (clash) throw new Error(`Project '${project}' already has a view named '${clash.name}' (#${clash.number}). Nothing was changed.`);
  return n;
}

// Visible fields by name → field IDs, in the order given. Every unknown name
// is reported at once with the valid ones.
export function resolveVisibleFields(fields: Field[], names: string[], project: string): { id: string; name: string }[] {
  const all = fields.filter((f) => f.name && f.id);
  const out: { id: string; name: string }[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const f = all.find((x) => norm(x.name) === norm(n));
    if (!f) missing.push(n);
    else if (!out.some((o) => o.id === f.id)) out.push({ id: f.id, name: f.name });
  }
  if (missing.length) {
    throw new Error(`Field${missing.length > 1 ? "s" : ""} ${quoted(missing)} not found in project '${project}'. Fields: ${quoted(all.map((f) => f.name))}. Nothing was changed.`);
  }
  if (!out.length) throw new Error("visible_fields needs at least one field name. Nothing was changed.");
  return out;
}

export function formatView(v: View): string {
  const fields = (v.fields?.nodes ?? []).map((f) => f?.name).filter(Boolean) as string[];
  return `#${v.number} ${v.name} [${layoutName(v.layout)}]${v.filter ? ` · filter: ${v.filter}` : ""}${fields.length ? ` · fields: ${fields.join(", ")}` : ""}`;
}

// ---------- Status updates ----------

export const STATUS_VALUES = ["on_track", "at_risk", "off_track", "inactive", "complete"] as const;
export type StatusValue = (typeof STATUS_VALUES)[number];
export const statusEnum = (s: StatusValue) => s.toUpperCase();

const STATUS_FIELDS = `id status body startDate targetDate createdAt updatedAt creator { login }`;

export const STATUS_UPDATES_QUERY = `query($id: ID!, $first: Int!) {
  node(id: $id) { ... on ProjectV2 { statusUpdates(first: $first) { totalCount nodes { ${STATUS_FIELDS} } } } }
}`;

export const CREATE_STATUS_MUTATION = `mutation($input: CreateProjectV2StatusUpdateInput!) {
  createProjectV2StatusUpdate(input: $input) { statusUpdate { ${STATUS_FIELDS} } }
}`;

export const UPDATE_STATUS_MUTATION = `mutation($input: UpdateProjectV2StatusUpdateInput!) {
  updateProjectV2StatusUpdate(input: $input) { statusUpdate { ${STATUS_FIELDS} } }
}`;

export const DELETE_STATUS_MUTATION = `mutation($id: ID!) {
  deleteProjectV2StatusUpdate(input: { statusUpdateId: $id }) { deletedStatusUpdateId }
}`;

export type StatusUpdate = {
  id: string;
  status: string | null;
  body: string | null;
  startDate: string | null;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
  creator: { login: string } | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(raw: string | null | undefined, what: string): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const d = raw.trim();
  if (!DATE.test(d) || new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) !== d) {
    throw new Error(`${what} must be a date as YYYY-MM-DD (got '${raw}'). Nothing was changed.`);
  }
  return d;
}

// 'latest' (the most recent), or an ID (PVTSU_…) from list_project_status_updates.
export function findStatusUpdate(updates: StatusUpdate[], ref: string, project: string): StatusUpdate {
  const r = ref.trim();
  if (norm(r) === "latest") {
    if (!updates[0]) throw new Error(`Project '${project}' has no status updates. Nothing was changed.`);
    return updates[0];
  }
  const hit = updates.find((u) => u.id === r);
  if (!hit) {
    throw new Error(`Status update '${ref}' not found in project '${project}'. Use 'latest' or an ID from list_project_status_updates. Nothing was changed.`);
  }
  return hit;
}

export function formatStatusUpdate(u: StatusUpdate): string {
  const status = u.status ? u.status.toLowerCase() : "no status";
  const dates = [u.startDate ? `start ${u.startDate}` : "", u.targetDate ? `target ${u.targetDate}` : ""].filter(Boolean).join(", ");
  const body = u.body ? `\n      ${u.body.replace(/\s+/g, " ").slice(0, 300)}${u.body.length > 300 ? "…" : ""}` : "";
  return `${u.id} · ${status}${dates ? ` · ${dates}` : ""} · ${u.createdAt.slice(0, 10)}${u.creator ? ` by ${u.creator.login}` : ""}${body}`;
}
