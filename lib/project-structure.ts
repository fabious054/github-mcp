// Board structure — phase 3a (issue #116, ADR 0021): projects, repository
// links, templates, fields, single-select options and iterations.
// GraphQL documents and the pure rules (option / iteration list rebuilding,
// impact counts), testable without GitHub.

import type { Field, Item, Iteration, Project } from "./projects";

// ---------- GraphQL documents ----------

export const OWNER_ID_QUERY = `query($login: String!) {
  repositoryOwner(login: $login) { id login __typename }
}`;

export const REPO_ID_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id nameWithOwner }
}`;

const PROJECT_REF = `id number title url closed public template shortDescription`;

export const CREATE_PROJECT_MUTATION = `mutation($ownerId: ID!, $title: String!, $repositoryId: ID) {
  createProjectV2(input: { ownerId: $ownerId, title: $title, repositoryId: $repositoryId }) { projectV2 { ${PROJECT_REF} } }
}`;

export const UPDATE_PROJECT_MUTATION = `mutation($input: UpdateProjectV2Input!) {
  updateProjectV2(input: $input) { projectV2 { ${PROJECT_REF} readme } }
}`;

export const DELETE_PROJECT_MUTATION = `mutation($projectId: ID!) {
  deleteProjectV2(input: { projectId: $projectId }) { projectV2 { id number title } }
}`;

export const COPY_PROJECT_MUTATION = `mutation($ownerId: ID!, $projectId: ID!, $title: String!, $includeDraftIssues: Boolean) {
  copyProjectV2(input: { ownerId: $ownerId, projectId: $projectId, title: $title, includeDraftIssues: $includeDraftIssues }) { projectV2 { ${PROJECT_REF} } }
}`;

export const MARK_TEMPLATE_MUTATION = `mutation($projectId: ID!) {
  markProjectV2AsTemplate(input: { projectId: $projectId }) { projectV2 { ${PROJECT_REF} } }
}`;

export const UNMARK_TEMPLATE_MUTATION = `mutation($projectId: ID!) {
  unmarkProjectV2AsTemplate(input: { projectId: $projectId }) { projectV2 { ${PROJECT_REF} } }
}`;

export const LINK_REPO_MUTATION = `mutation($projectId: ID!, $repositoryId: ID!) {
  linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) { repository { nameWithOwner } }
}`;

export const UNLINK_REPO_MUTATION = `mutation($projectId: ID!, $repositoryId: ID!) {
  unlinkProjectV2FromRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) { repository { nameWithOwner } }
}`;

const FIELD_OUT = `
  __typename
  ... on ProjectV2FieldCommon { id name dataType }
  ... on ProjectV2SingleSelectField { options { id name color description } }
  ... on ProjectV2IterationField { configuration { duration iterations { id title startDate duration } completedIterations { id title startDate duration } } }`;

export const CREATE_FIELD_MUTATION = `mutation($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) { projectV2Field { ${FIELD_OUT} } }
}`;

export const UPDATE_FIELD_DEF_MUTATION = `mutation($input: UpdateProjectV2FieldInput!) {
  updateProjectV2Field(input: $input) { projectV2Field { ${FIELD_OUT} } }
}`;

export const DELETE_FIELD_MUTATION = `mutation($fieldId: ID!) {
  deleteProjectV2Field(input: { fieldId: $fieldId }) { projectV2Field { ... on ProjectV2FieldCommon { id name } } }
}`;

// ---------- Colors ----------

export const OPTION_COLORS = ["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export function parseColor(raw: string | undefined, fallback: OptionColor = "GRAY"): OptionColor {
  if (raw === undefined) return fallback;
  const c = raw.trim().toUpperCase();
  if ((OPTION_COLORS as readonly string[]).includes(c)) return c as OptionColor;
  throw new Error(`'${raw}' is not an option color. Colors: ${OPTION_COLORS.map((x) => x.toLowerCase()).join(", ")}. Nothing was changed.`);
}

// ---------- Field types ----------

export const FIELD_TYPES = ["text", "number", "date", "single_select", "iteration"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

// Custom fields only: built-in fields (Title, Assignees, Status, Labels…)
// can't be deleted, and the issue-owned ones can't be edited at all.
const CUSTOM_TYPES = new Set(["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"]);

const norm = (s: string) => s.trim().toLowerCase();
const quoted = (xs: string[]) => (xs.length ? xs.map((x) => `'${x}'`).join(", ") : "(none)");

export function findEditableField(project: Project, name: string): Field {
  const fields = project.fields.nodes.filter((f) => f.name);
  const f = fields.find((x) => norm(x.name) === norm(name));
  const editable = fields.filter((x) => CUSTOM_TYPES.has(x.dataType));
  if (!f) throw new Error(`Field '${name}' not found in project '${project.title}'. Fields you can change: ${quoted(editable.map((x) => x.name))}. Nothing was changed.`);
  if (!CUSTOM_TYPES.has(f.dataType)) {
    throw new Error(`'${f.name}' is a built-in field (${f.dataType.toLowerCase()}) and can't be changed here. Fields you can change: ${quoted(editable.map((x) => x.name))}.`);
  }
  return f;
}

export function fieldNameTaken(project: Project, name: string): boolean {
  return project.fields.nodes.some((f) => f.name && norm(f.name) === norm(name));
}

// ---------- Single-select options ----------

export type OptionIn = { name: string; color?: string; description?: string };
export type OptionOut = { id?: string; name: string; color: OptionColor; description: string };

export type OptionChanges = {
  add?: OptionIn[];
  rename?: Record<string, string>;
  remove?: string[];
  edit?: Record<string, { color?: string; description?: string }>;
};

type CurrentOption = { id: string; name: string; color?: string | null; description?: string | null };

// Rebuilds the full option list from the current one, keeping every ID (so
// item values survive renames and edits). Validates every name first; returns
// the list and the names being removed.
export function buildOptions(field: Pick<Field, "name" | "options">, ch: OptionChanges): { options: OptionOut[]; removed: string[] } {
  const current = (field.options ?? []) as CurrentOption[];
  const find = (n: string) => current.find((o) => norm(o.name) === norm(n));
  const unknown = [...Object.keys(ch.rename ?? {}), ...(ch.remove ?? []), ...Object.keys(ch.edit ?? {})].filter((n) => !find(n));
  if (unknown.length) {
    throw new Error(`Option${unknown.length > 1 ? "s" : ""} ${quoted(unknown)} not found in '${field.name}'. Options: ${quoted(current.map((o) => o.name))}. Nothing was changed.`);
  }
  const removeIds = new Set((ch.remove ?? []).map((n) => find(n)!.id));
  const renames = new Map(Object.entries(ch.rename ?? {}).map(([from, to]) => [find(from)!.id, to.trim()]));
  const edits = new Map(Object.entries(ch.edit ?? {}).map(([n, e]) => [find(n)!.id, e]));
  for (const id of renames.keys()) if (removeIds.has(id)) throw new Error("An option can't be renamed and removed in the same call. Nothing was changed.");

  const out: OptionOut[] = current
    .filter((o) => !removeIds.has(o.id))
    .map((o) => {
      const e = edits.get(o.id);
      return {
        id: o.id,
        name: renames.get(o.id) ?? o.name,
        color: e?.color !== undefined ? parseColor(e.color) : parseColor(o.color ?? undefined),
        description: e?.description ?? o.description ?? "",
      };
    });
  for (const a of ch.add ?? []) out.push({ name: a.name.trim(), color: parseColor(a.color), description: a.description ?? "" });

  const seen = new Set<string>();
  for (const o of out) {
    if (!o.name) throw new Error("An option name can't be empty. Nothing was changed.");
    const k = norm(o.name);
    if (seen.has(k)) throw new Error(`Option '${o.name}' would appear twice in '${field.name}'. Nothing was changed.`);
    seen.add(k);
  }
  if (!out.length) throw new Error(`'${field.name}' needs at least one option. Nothing was changed.`);
  return { options: out, removed: current.filter((o) => removeIds.has(o.id)).map((o) => o.name) };
}

// ---------- Iterations ----------

export type IterationChanges = {
  duration_days?: number; // used for iterations added from now on
  add?: number; // how many iterations to append after the last one
  rename?: Record<string, string>;
  reschedule?: Record<string, { start_date?: string; duration_days?: number }>;
  remove?: string[];
};

export type IterationConfigOut = {
  startDate: string;
  duration: number;
  iterations: { id?: string; title: string; startDate: string; duration: number }[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function checkDuration(n: number, what: string) {
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error(`${what} must be a whole number of days between 1 and 365 (got ${n}). Nothing was changed.`);
}

// Rebuilds the full iteration configuration from the current one, keeping
// every iteration ID — completed ones included, or GitHub would drop them.
export function buildIterations(field: Pick<Field, "name" | "configuration">, ch: IterationChanges): { config: IterationConfigOut; removed: string[]; added: string[] } {
  const cfg = field.configuration;
  if (!cfg) throw new Error(`'${field.name}' is not an iteration field.`);
  const all: Iteration[] = [...cfg.completedIterations, ...cfg.iterations].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const find = (t: string) => all.find((i) => norm(i.title) === norm(t));
  const unknown = [...Object.keys(ch.rename ?? {}), ...Object.keys(ch.reschedule ?? {}), ...(ch.remove ?? [])].filter((t) => !find(t));
  if (unknown.length) {
    throw new Error(`Iteration${unknown.length > 1 ? "s" : ""} ${quoted(unknown)} not found in '${field.name}'. Iterations: ${quoted(all.map((i) => i.title))}. Nothing was changed.`);
  }
  if (ch.duration_days !== undefined) checkDuration(ch.duration_days, "duration_days");
  if (ch.add !== undefined && (!Number.isInteger(ch.add) || ch.add < 1 || ch.add > 20)) throw new Error(`'add' must be between 1 and 20 iterations (got ${ch.add}). Nothing was changed.`);
  const removeIds = new Set((ch.remove ?? []).map((t) => find(t)!.id));
  const duration = ch.duration_days ?? cfg.duration;

  type Row = { id?: string; title: string; startDate: string; duration: number };
  const list: Row[] = all
    .filter((i) => !removeIds.has(i.id))
    .map((i) => {
      const r = ch.reschedule?.[Object.keys(ch.reschedule ?? {}).find((k) => norm(k) === norm(i.title)) ?? ""];
      if (r?.start_date !== undefined && !DATE.test(r.start_date)) throw new Error(`start_date for '${i.title}' must be YYYY-MM-DD (got '${r.start_date}'). Nothing was changed.`);
      if (r?.duration_days !== undefined) checkDuration(r.duration_days, `duration_days for '${i.title}'`);
      const newTitle = ch.rename?.[Object.keys(ch.rename ?? {}).find((k) => norm(k) === norm(i.title)) ?? ""];
      return { id: i.id, title: (newTitle ?? i.title).trim(), startDate: r?.start_date ?? i.startDate, duration: r?.duration_days ?? i.duration };
    });

  const added: string[] = [];
  if (ch.add) {
    const sorted = [...list].sort((a, b) => a.startDate.localeCompare(b.startDate));
    const last = sorted[sorted.length - 1];
    let start = last ? addDays(last.startDate, last.duration) : new Date().toISOString().slice(0, 10);
    // Titles continue GitHub's "Iteration N" numbering.
    const nums = [...all.map((i) => i.title), ...list.map((i) => i.title)].map((t) => Number(/^Iteration (\d+)$/.exec(t)?.[1] ?? 0));
    let n = Math.max(0, ...nums);
    for (let k = 0; k < ch.add; k++) {
      n += 1;
      const title = `Iteration ${n}`;
      list.push({ title, startDate: start, duration });
      added.push(`${title} (${start}, ${duration}d)`);
      start = addDays(start, duration);
    }
  }

  const seen = new Set<string>();
  for (const i of list) {
    if (!i.title) throw new Error("An iteration title can't be empty. Nothing was changed.");
    if (seen.has(norm(i.title))) throw new Error(`Iteration '${i.title}' would appear twice in '${field.name}'. Nothing was changed.`);
    seen.add(norm(i.title));
  }
  list.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const iterations = list.map((i) => (i.id ? { id: i.id, title: i.title, startDate: i.startDate, duration: i.duration } : { title: i.title, startDate: i.startDate, duration: i.duration }));
  return {
    config: { startDate: iterations[0]?.startDate ?? new Date().toISOString().slice(0, 10), duration, iterations },
    removed: all.filter((i) => removeIds.has(i.id)).map((i) => i.title),
    added,
  };
}

export function newIterationConfig(startDate: string, durationDays: number): { startDate: string; duration: number; iterations: never[] } {
  if (!DATE.test(startDate)) throw new Error(`iteration.start_date must be YYYY-MM-DD (got '${startDate}'). Nothing was created.`);
  checkDuration(durationDays, "iteration.duration_days");
  return { startDate, duration: durationDays, iterations: [] };
}

// ---------- Impact counts ----------

// How many items have a value in a field — optionally only the given option /
// iteration titles. Values are matched on the field name GitHub returns.
export function countValues(items: Item[], fieldName: string, values?: string[]): number {
  const want = values?.map(norm);
  return items.filter((it) =>
    it.fieldValues.nodes.some((v) => {
      if (!v.field?.name || norm(v.field.name) !== norm(fieldName)) return false;
      if (!want) return true;
      const val = v.name ?? v.title;
      return val !== undefined && want.includes(norm(val));
    })
  ).length;
}

export const CONFIRM_HINT = "Nothing was changed. Repeat the call with confirm: true to apply it.";
