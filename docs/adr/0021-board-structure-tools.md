# ADR 0021: Board structure tools — confirmation before deletes, option and iteration lists rebuilt with their IDs

## Status
Accepted (2026-11-27). Piece 3a implemented in issue #116 (phase 3 of board management). Pieces 3b (labels, milestones, issue types) and 3c (views, status updates) follow the same rules.

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
