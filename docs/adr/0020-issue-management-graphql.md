# ADR 0020: Issue management via GraphQL — one atomic write, add/remove computed server-side

## Status
Accepted (2026-11-27). Implemented in issue #109 (phase 2 of board management).

## Context

Phase 1 (ADR 0019, issues #104 / #107) gave the connector the Projects v2
board. Doing the live validation showed what was still missing on the issues
themselves: there was no way to reopen #104 or close the test issue #106, and
`create_issue` could not put a new issue on a board.

Phase 2 covers everything done by hand on an issue: edit title and body,
close (with a reason) and reopen, labels, assignees, milestone, issue type,
sub-issues, and editing comments — including PR inline review comments.

The REST API spreads this over several endpoints (`PATCH /issues/{n}`,
`POST/DELETE /issues/{n}/labels`, `/assignees`, `/sub_issues` with database
IDs, `PATCH /issues/comments/{id}`, `PATCH /pulls/comments/{id}`), so one
user change can mean several calls. The GraphQL API has a single
`updateIssue` mutation whose input (`UpdateIssueInput`) carries title, body,
`labelIds`, `assigneeIds`, `milestoneId`, `issueTypeId` and
`stateInput { value, stateReason, duplicateIssueId }` — every change at once,
including closing as a duplicate. `createIssue` likewise takes labels,
assignees, milestone, type, `parentIssueId` and `projectV2Ids`.

## Decisions (maintainer, 2026-11-27)

1. **Labels and assignees are changed by add / remove only** — never by
   replacing the whole list, so an incomplete call can't wipe what is there.
2. **Close reasons are completed, not planned and duplicate**, like GitHub's
   button. `duplicate` requires `duplicate_of`. A reason (or `duplicate_of`)
   on its own implies closing; a reason while reopening is refused.
3. **Labels, milestones, assignees and types must already exist.** Every name
   is resolved (case-insensitively) before anything is written; all unknown
   names are reported at once with the valid ones. Creating labels and
   milestones is phase 3 (structure).
4. **`create_issue` accepts everything optionally**, including a parent issue
   and a project with initial field values (Phase 1 field resolution).
5. **PR inline review comments are in scope.** They have their own mutation
   and ID space (`PRRC_…`) next to conversation comments (`IC_…`), so
   `edit_comment` takes a required `kind`, and `list_pr_comments` exposes both
   kinds with their IDs.
6. **One atomic write per `update_issue` call (GraphQL `updateIssue`).** It is
   all or nothing: a call never leaves an issue half changed. Because the
   mutation takes the *final* label and assignee lists, add/remove is computed
   on the server: read the issue, apply the additions and removals to the
   current lists, write once.

## Alternatives considered for decision 6

- **One REST/GraphQL call per kind of change** (`addLabelsToLabelable`,
  `removeLabelsFromLabelable`, `closeIssue`, …). Each add/remove is exact on
  GitHub's side, but several writes per user call mean a failure midway leaves
  part of the change written (the same gap noted for `update_project_item`).
- **Single mutation with server-side add/remove (chosen).** No partial state.
  Accepted trade-off: if someone else edits the same issue's labels or
  assignees in the milliseconds between our read and our write, that edit can
  be overwritten. It needs two people editing the same issue at the same
  instant; the read and the write are one request apart.

## Consequences

- `get_issue` and every write tool show the issue after the change: state with
  close reason, duplicate-of, labels, assignees, milestone, type, parent and
  sub-issues with progress; `get_issue` also shows each comment's node ID.
- Comment IDs are GraphQL node IDs (`IC_…`, `PRRC_…`), so `edit_comment`
  doesn't need the issue or PR number, and a wrong `kind` is caught from the
  ID prefix before anything is sent. `owner`/`repo` are still used to pick the
  account when several are linked (ADR 0006/0007).
- Sub-issues are linked by node ID, resolved from `#n`, `owner/repo#n` or the
  issue URL, so cross-repository sub-issues work without REST database IDs.
- Issue types only exist on organization repositories; on a user repository
  the tools say so instead of doing nothing.
- `create_issue` validates project fields before creating anything. The issue
  and the board link are created in one mutation; if setting the project fields
  afterwards fails, the response says exactly what was created.
- Several of these inputs (`stateInput`, `issueTypeId`, `parentIssueId`) are
  recent and not yet in `@octokit/graphql-schema`, as happened with
  `archivedStates` (#107). Every document and every input shape is checked
  against GitHub's official schema (`github/docs`, `schema.docs.graphql`), and
  each change is confirmed live.
