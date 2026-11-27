# ADR 0019: GitHub Projects (v2) board tools — `project` scope for everyone, fields by name

## Status
Accepted (2026-11-27). Implemented in issue #104 (phase 1 of board management).

## Context

The maintainer wants full board management through the connector: what is
done today by hand on GitHub Projects. It is planned in three phases, one at a
time: (1) Projects v2 items, (2) full issue management (labels, assignees,
milestone, type, sub-issues, comment edits), (3) project structure (projects,
fields, options).

Projects v2 only exist in GraphQL. Items, fields, options and iterations are
addressed by node IDs (`PVT_…`, `PVTI_…`, field and option IDs), not by
repository and number. And the OAuth scopes the connector requested
(`repo read:org`) do not include Projects v2: GitHub answers
`INSUFFICIENT_SCOPES` without `read:project` / `project`.

## Decisions (maintainer, 2026-11-27)

1. **`project` is added to the default scope, for everyone.** The default
   moves to `repo read:org project`, defined once in `lib/scopes.ts` (used by
   `/authorize`, `/link-account` and the authorization-server metadata).
   `GITHUB_OAUTH_SCOPES` still overrides it for self-hosted deployments; on
   the shared instance the variable is removed so the versioned default
   applies (its value was `repo read:org`, confirmed on GitHub's authorized
   app page before removal).
   - Each user reconnects once to accept. Token reuse (ADR 0015) already
     handles it: when the stored token does not cover the requested scopes,
     the new token is kept and stored (`scopes-changed`).
   - Until a user reconnects, only the board tools fail, with one clear
     message (reconnect; `link_account` again for linked accounts). Every
     other tool keeps working.
   - With several linked accounts, an account that still lacks the scope is
     never skipped silently (ADR 0007): the call names it and asks to
     reconnect or to set `account`.
2. **Fields are changed by name.** One `update_project_item` takes
   `{ field name: value }` for several fields at once. The server resolves
   field, option and iteration IDs; names are case-insensitive; a wrong name
   returns the valid ones. Every value is resolved before anything is
   written, so a bad name changes nothing. `null` clears a field.
   Iterations accept a title, `@current` or `@next`. Fields that belong to the
   issue or PR (title, assignees, labels, milestone…) are refused here; they
   come with the issue tools (phase 2).
3. **Account choice like repositories** (ADR 0006): an explicit `account`
   wins; otherwise the account that can edit the project (`viewerCanUpdate`),
   or the primary one among readers; ambiguity asks.

## Tools (phase 1)

`list_projects`, `get_project`, `list_project_items` (filter by one field
value, archived items optional), `add_project_item` (existing issue/PR or a
draft, with optional initial fields; adding an item already on the board
returns it), `update_project_item`, `move_project_item` (after another item or
to the top), `archive_project_item` / `unarchive_project_item`,
`remove_project_item` (says what is lost: the item's field values; a draft is
deleted). Items are referenced as `owner/repo#123`, an issue/PR URL or an item
ID.

## Consequences

- One reconnect per user on the shared instance; nothing else breaks.
- No new dependency (`octokit.graphql`), no state on the server.
- Views (filters, grouping, layout) are read-only in GitHub's API, so the
  tools list their names but cannot change them.
- Phase 3 will add project-level writes (create projects, fields, options),
  covered by the same `project` scope.
