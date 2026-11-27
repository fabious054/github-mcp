# ADR 0021: Board structure tools — confirmation before deletes, option and iteration lists rebuilt with their IDs

## Status
Accepted (2026-11-27). Piece 3a implemented in issue #116 (phase 3 of board management), piece 3b (labels, milestones, issue types) in issue #121, piece 3c (views, status updates) in issue #125.

## Context

Phases 1 and 2 (ADR 0019, ADR 0020) cover board items and issues. Phase 3
covers the structure: projects, repository links, templates, fields,
single-select options and iterations (3a); labels, milestones and issue types
(3b); views and status updates (3c).

Two properties of GitHub's GraphQL API shape the design:

- Several structure operations destroy data with no undo: deleting a project
  (draft items are lost), a field (its value on every item), a single-select
  option or an iteration (the value on every item that had it).
- `updateProjectV2Field` takes the **whole** option list
  (`singleSelectOptions`) and the **whole** iteration configuration
  (`iterationConfiguration`): "values overwrite existing options, and existing
  options should be fetched for partial updates". An option or iteration left
  out is deleted. Each entry accepts an `id` to keep its identity, so item
  values survive renames and edits only when the ID is sent back.

## Decisions (maintainer, 2026-11-27)

1. **Deletes are offered, behind explicit confirmation.** Every destructive
   tool takes `confirm` (default `false`). Without it the tool computes and
   reports the impact — items on the board and drafts that would be lost;
   items with a value in the field; items holding the option or iteration —
   and changes nothing. With `confirm: true` it applies the change. Closing a
   project (`update_project closed: true`) stays the non-destructive way to
   retire a board.
2. **Options and iterations are changed by add / rename / edit / remove, never
   by sending a list.** The connector reads the current options (with their
   color and description, which GitHub requires on every entry) or the current
   iterations (completed ones included — leaving them out would delete them),
   applies the requested changes, and sends back the full list **with every
   existing ID**. Removing follows decision 1.
3. **Iteration fields are fully editable** (maintainer's choice): duration for
   new iterations, append iterations (continuing GitHub's "Iteration N"
   numbering), rename, reschedule (start date / length), remove.
4. As in phases 1–2: names are matched case-insensitively, every unknown name
   is reported at once with the valid ones, and nothing is written.

## Consequences

- Impact counts read every item on the board, archived included (100 per
  page, up to 50 pages). On very large boards a confirmation-less call costs
  a few requests; it never writes.
- Built-in fields (Title, Assignees, Labels, Milestone, Repository, …) are
  refused by the field tools; Status is a built-in single-select whose options
  can be edited but which can't be deleted.
- `copy_project` copies fields, views and workflows; issues and PRs are never
  copied and drafts only with `include_drafts` — the output states this.
- `create_project` picks the account like the other tools: explicit `account`,
  then the linked account whose login is the owner, then the only account;
  otherwise it asks for `account`.
- Validating every document against GitHub's official schema caught a real
  mistake before release: an iteration configuration has `startDay` (weekday),
  not `startDate`; the configuration's start date is taken from the first
  iteration.

## Piece 3b — labels, milestones, issue types (issue #121)

- **Labels and milestones use the REST API.** Milestones have no GraphQL
  mutations at all; labels do (`createLabel`, `updateLabel`, `deleteLabel`),
  but REST keeps both on the same path, matches them by name, and its
  responses carry what the output needs (color, description, issue counts).
  The delete impact for a label comes from GraphQL (`label(name)` → issues and
  pull requests, open and closed), which REST doesn't count.
- **Issue types use GraphQL** (`createIssueType`, `updateIssueType`,
  `deleteIssueType`) and live on the organization, not the repository: the
  tools take `org`. User accounts are refused with a clear message (as in
  phase 2), and writes check `viewerCanAdminister` first so a non-owner gets
  a clear refusal before anything is attempted. Writes also need the
  `admin:org` scope, found missing in the live run: see ADR 0022.
- **Delete impact for an issue type comes from search**
  (`org:<org> is:issue type:"<name>"`): `IssueType.issues` needs a repository,
  so there is no exact org-wide count. The output says the number comes from
  search and can lag. Disabling (`update_issue_type enabled: false`) is offered
  as the non-destructive alternative, like closing a milestone or a project.
- **Names are unique per repository / organization, case-insensitively.**
  Creating or renaming onto an existing name is refused before writing, with
  the existing entry named.
- **Milestone due dates are sent at noon UTC.** GitHub stores a timestamp and
  shows a date; midnight UTC can show as the previous day in American time
  zones.

## Piece 3c — views and status updates (issue #125)

- **Views are limited to what GitHub's API sets:** name, layout (table, board,
  roadmap), filter and visible fields. Grouping, sorting, column widths and
  field sums can only be set in the web UI; every view tool says so, so a
  request for them isn't silently ignored.
- **`createProjectV2View` has no filter argument.** A filter given to
  `create_project_view` is applied with `updateProjectV2View` right after; if
  that second call fails, the output says the view was created without the
  filter (the same honesty rule as multi-call writes in phases 1–2).
- **Visible fields are the full list, in order**, by name; unknown names are
  refused with the valid ones. A project's last view can't be deleted.
- **Status updates are identified by `latest` or by ID.** They have no name
  or number, so `list_project_status_updates` shows each ID. Deleting the
  newest update reports which update becomes the current status.
- **`list_projects`** now says how many open projects are shown next to the
  total, so hidden closed projects don't look missing.
