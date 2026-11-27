import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { Octokit } from "@octokit/rest";
import { applyPatch } from "diff";
import { z } from "zod";
import { oauthEnabled, encryptJson, nowSeconds } from "../../lib/oauth";
import { getServerOrigin } from "../../lib/mongo";
import { getLinkedAccounts, unlinkAccount } from "../../lib/accounts";
import { revokeOAuthToken, unlinkLinkedAccount } from "../../lib/account-unlink";
import { accessFromError, accessFromPermissions, pickAccount, type RepoAccess } from "../../lib/account-pick";
import { pickRef } from "../../lib/ref-pick";
import { deleteBranchRefusal, type OpenPr } from "../../lib/branch-delete";
import {
  createErrorMessage,
  createdMessage,
  findOwnAccount,
  membershipFromError,
  membershipFromState,
  pickOrgCreator,
  VISIBILITY_REQUIRED_MESSAGE,
  type MembershipResult,
} from "../../lib/repo-create";
import {
  COMMIT_FILES_MAX,
  COMMIT_FILES_PER_PAGE,
  STATS_CONCURRENCY,
  STATS_MAX_PER_PAGE,
  commitFilesNote,
  compareLimitNotes,
  fileTotals,
  formatCommit,
  formatFile,
  historyErrorMessage,
  listFilesNote,
  mapLimit,
  nextPageFromLink,
  resolvePerPage,
  type GhCommit,
  type GhFile,
} from "../../lib/commit-history";
import {
  ALL_ROLES,
  CONTRIBUTIONS_QUERY,
  SEARCH_COMMITS_DEFAULT_PER_PAGE,
  SEARCH_ISSUES_DEFAULT_PER_PAGE,
  SEARCH_MAX_PER_PAGE,
  commitSearchQuery,
  formatContributionStats,
  formatIssueItem,
  isAuthError,
  issueSearchQueries,
  mergeCollections,
  rateLimitMessage,
  repoFromUrl,
  resolvePeriod,
  searchLimitNote,
  searchPeriod,
  windowsWithActivity,
  yearlyWindows,
  type Collection,
  type Period,
  type SearchIssue,
} from "../../lib/activity-stats";
import {
  DETAIL_CONCURRENCY,
  DETAIL_TIME_BUDGET_MS,
  PR_STATS_MAX_PER_PAGE,
  SEARCHES_PER_CALL,
  SEARCH_PAGE_SIZE,
  SEARCH_RESULT_CAP,
  aggregate,
  discoveryTtlSeconds,
  formatBreakdown,
  monthSlices,
  pagesFor,
  splitSlice,
  type CommitItem,
  type PrItem,
  type Slice,
} from "../../lib/activity-breakdown";
import { StatsCache, commitStatsKey, discoveryKey, prStatsKey, type Stats } from "../../lib/stats-cache";
import {
  ADD_DRAFT_MUTATION,
  ADD_ITEM_MUTATION,
  ARCHIVE_ITEM_MUTATION,
  CLEAR_FIELD_MUTATION,
  CONTENT_ID_QUERY,
  DELETE_ITEM_MUTATION,
  GET_PROJECT_QUERY,
  ITEM_BY_ID_QUERY,
  LIST_ITEMS_QUERY,
  LIST_PROJECTS_QUERY,
  MISSING_SCOPE_MESSAGE,
  MOVE_ITEM_MUTATION,
  UNARCHIVE_ITEM_MUTATION,
  UPDATE_FIELD_MUTATION,
  archivedStatesFor,
  formatItem,
  formatProject,
  isMissingProjectScope,
  isNotFound,
  matchesFilter,
  parseFilter,
  parseItemRef,
  resolveValue,
  type Item,
  type Project,
} from "../../lib/projects";
import {
  ADD_SUB_ISSUE_MUTATION,
  ASSIGNABLE_USERS_QUERY,
  CREATE_ISSUE_MUTATION,
  ISSUE_REF_QUERY,
  ISSUE_VIEW_QUERY,
  REMOVE_SUB_ISSUE_MUTATION,
  REPO_CONTEXT_QUERY,
  UPDATE_ISSUE_COMMENT_MUTATION,
  UPDATE_ISSUE_MUTATION,
  UPDATE_REVIEW_COMMENT_MUTATION,
  applyAddRemove,
  checkCommentKind,
  diffIssue,
  formatIssue,
  overlap,
  parseIssueRef,
  planState,
  resolveLabels,
  resolveMilestone,
  resolveType,
  type IssueView,
  type RepoContext,
} from "../../lib/issues";
import { rateLimitMcp, recordFailedTokenVerification } from "../../lib/mcp-ratelimit";
import { getClientIp } from "../../lib/ratelimit";
import { audit, tokenFingerprint } from "../../lib/audit";
import {
  serviceUnavailable,
  verifyGithubTokenWithGithub,
  type GithubVerification,
} from "../../lib/github-auth";

export const runtime = "nodejs";
// Route segment config: mcp-handler 2 no longer takes maxDuration as an option.
export const maxDuration = 60;

// ---------- MODE 1: GitHub OAuth (multi-user) ----------
//
// If GITHUB_OAUTH_CLIENT_ID/SECRET are set, everyone who connects this MCP
// in Claude goes through a real GitHub login (see /authorize, /callback,
// /token) and the tools use THEIR access token — never a fixed shared
// token. This is what lets "anyone connect their own account".
//
// ---------- MODE 2: fixed account(s) via environment variable (legacy) ----------
//
// If OAuth isn't configured, falls back to the old mode: GITHUB_TOKEN (one
// account) or GITHUB_ACCOUNTS (JSON with several pre-configured accounts).
// Useful for fully personal use, without setting up the OAuth flow.

type AccountConfig = {
  token: string;
  defaultOwner?: string;
  defaultRepo?: string;
  owners?: string[];
};

function loadStaticAccounts(): Record<string, AccountConfig> {
  const raw = process.env.GITHUB_ACCOUNTS;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("GITHUB_ACCOUNTS is not valid JSON. Check the environment variable on Vercel.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("GITHUB_ACCOUNTS must be a JSON object (a map of account name → config).");
    }
    return parsed as Record<string, AccountConfig>;
  }

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return {
      default: {
        token,
        defaultOwner: process.env.DEFAULT_OWNER,
        defaultRepo: process.env.DEFAULT_REPO,
      },
    };
  }

  return {};
}

let _staticAccountsCache: Record<string, AccountConfig> | null = null;
function getStaticAccounts(): Record<string, AccountConfig> {
  if (!_staticAccountsCache) _staticAccountsCache = loadStaticAccounts();
  return _staticAccountsCache;
}

const DEFAULT_ACCOUNT = process.env.DEFAULT_ACCOUNT;

function resolveStaticAccount(accountName?: string, owner?: string): { name: string; config: AccountConfig } {
  const accounts = getStaticAccounts();
  const keys = Object.keys(accounts);

  if (keys.length === 0) {
    throw new Error(
      "No GitHub account configured. Set GITHUB_OAUTH_CLIENT_ID/SECRET (per-user login) or GITHUB_ACCOUNTS/GITHUB_TOKEN (fixed account) in the environment variables."
    );
  }

  if (accountName) {
    const config = accounts[accountName];
    if (!config) throw new Error(`Account '${accountName}' not found. Configured accounts: ${keys.join(", ")}.`);
    return { name: accountName, config };
  }

  if (owner) {
    const match = keys.find((k) => {
      const acc = accounts[k];
      const owners = acc.owners ?? (acc.defaultOwner ? [acc.defaultOwner] : []);
      return owners.some((o) => o.toLowerCase() === owner.toLowerCase());
    });
    if (match) return { name: match, config: accounts[match] };
  }

  if (DEFAULT_ACCOUNT) {
    const config = accounts[DEFAULT_ACCOUNT];
    if (!config) throw new Error(`DEFAULT_ACCOUNT='${DEFAULT_ACCOUNT}' doesn't match any account in GITHUB_ACCOUNTS.`);
    return { name: DEFAULT_ACCOUNT, config };
  }

  if (keys.length === 1) return { name: keys[0], config: accounts[keys[0]] };

  throw new Error(
    `Multiple accounts configured (${keys.join(", ")}) and none was specified nor inferred from 'owner'. Provide 'account', or set DEFAULT_ACCOUNT.`
  );
}

type ResolvedRepo = { owner: string; repo: string; octokit: Octokit; accountName: string };

type OAuthCandidate = { login: string; token: string };

// Builds the list of candidate accounts for the current OAuth session: the
// primary (authenticated) account + any additional account linked via
// 'link_account'. Shared by 'resolveRepo' and 'list_repos_by_account'.
async function getOAuthCandidates(
  authInfo: { token: string; extra?: Record<string, unknown> }
): Promise<{ primaryLogin: string | undefined; candidates: OAuthCandidate[] }> {
  const primaryLogin =
    typeof authInfo.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
  const candidates: OAuthCandidate[] = [{ login: primaryLogin ?? "primary", token: authInfo.token }];
  if (primaryLogin) {
    const linked = await getLinkedAccounts(primaryLogin);
    candidates.push(...linked.map((a) => ({ login: a.login, token: a.token })));
  }
  return { primaryLogin, candidates };
}

// Asks GitHub what a token can do on a specific repository: write, read
// only, nothing — or whether the token was revoked, or GitHub could not
// answer. Used for automatic account detection when more than one account is
// linked to the session (ADR 0006, ADR 0007).
async function candidateAccess(token: string, owner: string, repo: string): Promise<RepoAccess> {
  try {
    const { data } = await new Octokit({ auth: token }).repos.get({ owner, repo });
    return accessFromPermissions(data.permissions);
  } catch (err) {
    return accessFromError(err);
  }
}

// Message shown whenever a linked account's GitHub authorization is no longer
// valid (ADR 0007). The server never falls back to another account in that
// case: the caller decides.
function revokedAccountsMessage(logins: string[]): string {
  const list = logins.map((l) => `'${l}'`).join(", ");
  return `${logins.length === 1 ? "Account" : "Accounts"} ${list} ${
    logins.length === 1 ? "is" : "are"
  } linked to your session, but GitHub no longer accepts ${
    logins.length === 1 ? "its" : "their"
  } authorization (revoked or expired). Run 'link_account' and re-authorize with ${
    logins.length === 1 ? "that account" : "each of them"
  }, or repeat the call with 'account' set to the account you want to use.`;
}

function auditRevoked(
  primaryLogin: string | undefined,
  candidates: OAuthCandidate[],
  logins: string[],
  where: string
): void {
  for (const login of logins) {
    const c = candidates.find((x) => x.login === login);
    audit("oauth.link.token_revoked", {
      primaryLogin,
      linkedLogin: login,
      tokenFingerprint: tokenFingerprint(c?.token),
      where,
    });
  }
}

async function resolveRepo(
  authInfo: { token: string; extra?: Record<string, unknown> } | undefined,
  accountName: string | undefined,
  owner: string | undefined,
  repo: string | undefined
): Promise<ResolvedRepo> {
  if (authInfo) {
    const { primaryLogin, candidates } = await getOAuthCandidates(authInfo);
    const o = owner || process.env.DEFAULT_OWNER || primaryLogin;
    const r = repo || process.env.DEFAULT_REPO;
    if (!o || !r) {
      throw new Error(
        `Missing owner/repo.${primaryLogin ? ` Your GitHub user is '${primaryLogin}' — you still need to provide the repo.` : " Provide 'owner' and 'repo'."}`
      );
    }

    // Explicit account: use it directly (the caller already chose), without
    // checking access via the API.
    if (accountName) {
      const match = candidates.find((c) => c.login.toLowerCase() === accountName.toLowerCase());
      if (!match) {
        throw new Error(
          `Account '${accountName}' is not linked to your session. Available accounts: ${candidates
            .map((c) => c.login)
            .join(", ")}. Use 'link_account' to link a new one.`
        );
      }
      return { owner: o, repo: r, octokit: new Octokit({ auth: match.token }), accountName: match.login };
    }

    // Only one account in the session (the default flow, no extra accounts
    // linked): use it directly, no extra call to the GitHub API.
    if (candidates.length === 1) {
      return {
        owner: o,
        repo: r,
        octokit: new Octokit({ auth: candidates[0].token }),
        accountName: candidates[0].login,
      };
    }

    // Multiple linked accounts and none specified: auto-detect by the access
    // level each one has on the target repository (ADR 0006).
    const results = await Promise.all(
      candidates.map(async (c) => ({ candidate: c, login: c.login, access: await candidateAccess(c.token, o, r) }))
    );
    const pick = pickAccount(results, primaryLogin);

    if (pick.kind === "revoked") {
      auditRevoked(primaryLogin, candidates, pick.logins, "resolveRepo");
      throw new Error(revokedAccountsMessage(pick.logins));
    }
    if (pick.kind === "unavailable") {
      throw new Error(
        `GitHub could not be reached for ${pick.logins
          .map((l) => `'${l}'`)
          .join(", ")} right now, so the account for '${o}/${r}' can't be chosen safely. Try again in a few seconds, or repeat the call with 'account' set.`
      );
    }
    if (pick.kind === "picked") {
      return { owner: o, repo: r, octokit: new Octokit({ auth: pick.candidate.token }), accountName: pick.login };
    }
    if (pick.kind === "no-access") {
      throw new Error(
        `None of your linked accounts have access to '${o}/${r}'. Available accounts: ${candidates
          .map((c) => c.login)
          .join(", ")}. Link the right account with 'link_account', or double-check the repository name.`
      );
    }
    throw new Error(
      `More than one linked account can be used for '${o}/${r}' (${pick.options
        .map((a) => `${a.login}: ${a.access}`)
        .join(", ")}). Repeat the call with 'account' set to the one you want.`
    );
  }

  const { name, config } = resolveStaticAccount(accountName, owner);
  const o = owner || config.defaultOwner;
  const r = repo || config.defaultRepo;
  if (!o || !r) {
    throw new Error(`Missing owner/repo, and account '${name}' has no defaultOwner/defaultRepo configured.`);
  }
  return { owner: o, repo: r, octokit: new Octokit({ auth: config.token }), accountName: name };
}

type SelfAccount = { login: string; octokit: Octokit };

// The accounts of the caller themselves — the primary account and every
// account linked with 'link_account' (or the configured accounts in non-OAuth
// mode) — for the person-level stats tools (ADR 0017). Never another
// person's account. 'account' limits it to one.
async function listSelfAccounts(
  authInfo: { token: string; extra?: Record<string, unknown> } | undefined,
  accountName: string | undefined
): Promise<SelfAccount[]> {
  let raw: { login?: string; label: string; token: string }[];
  if (authInfo) {
    const { primaryLogin, candidates } = await getOAuthCandidates(authInfo);
    raw = candidates.map((c, i) => ({
      login: i === 0 ? primaryLogin : c.login,
      label: i === 0 ? primaryLogin ?? "primary" : c.login,
      token: c.token,
    }));
  } else {
    raw = Object.entries(getStaticAccounts()).map(([name, cfg]) => ({ label: name, token: cfg.token }));
    if (raw.length === 0) resolveStaticAccount(); // throws the standard "no account configured" message
  }

  if (accountName) {
    const match = raw.find((a) => a.label.toLowerCase() === accountName.toLowerCase());
    if (!match) {
      throw new Error(
        `Account '${accountName}' is not linked to your session. Available accounts: ${raw.map((a) => a.label).join(", ")}.`
      );
    }
    raw = [match];
  }

  return Promise.all(
    raw.map(async (a) => {
      const octokit = new Octokit({ auth: a.token });
      if (a.login) return { login: a.login, octokit };
      try {
        const me = await octokit.users.getAuthenticated();
        return { login: me.data.login, octokit };
      } catch {
        return { login: a.label, octokit };
      }
    })
  );
}

// Runs one account's section; a revoked token or a rate limit becomes that
// account's own message instead of failing (or hiding) the other accounts.
async function perAccountSection(
  acc: SelfAccount,
  primaryLogin: string | undefined,
  run: () => Promise<string>
): Promise<string> {
  try {
    return await run();
  } catch (err) {
    if (isAuthError(err)) {
      audit("oauth.link.token_revoked", { primaryLogin, linkedLogin: acc.login, where: "activity-stats" });
      return `## ${acc.login}\n${revokedAccountsMessage([acc.login])}`;
    }
    const rl = rateLimitMessage(err);
    if (rl) return `## ${acc.login}\n${rl}`;
    throw err;
  }
}

// ---------- Projects (v2) helpers (ADR 0019) ----------

type ProjectAccess = RepoAccess | "no-scope";

async function fetchProject(octokit: Octokit, login: string, number: number): Promise<Project | null> {
  const res = await octokit.graphql<{ repositoryOwner: { projectV2?: Project | null } | null }>(GET_PROJECT_QUERY, {
    login,
    number,
  });
  return res.repositoryOwner?.projectV2 ?? null;
}

async function projectAccess(token: string, login: string, number: number): Promise<{ access: ProjectAccess; project?: Project }> {
  try {
    const project = await fetchProject(new Octokit({ auth: token }), login, number);
    if (!project) return { access: "none" };
    return { access: project.viewerCanUpdate ? "write" : "read", project };
  } catch (err) {
    if (isMissingProjectScope(err)) return { access: "no-scope" };
    if (isNotFound(err)) return { access: "none" };
    return { access: accessFromError(err) };
  }
}

type ResolvedProject = { octokit: Octokit; accountName: string; owner: string; project: Project };

// Same account rules as repositories (ADR 0006/0007): explicit 'account' wins;
// with several linked accounts, the one that can edit the project; never a
// silent pick on incomplete information — including an account whose token
// still lacks the `project` scope.
async function resolveProject(
  authInfo: { token: string; extra?: Record<string, unknown> } | undefined,
  accountName: string | undefined,
  owner: string | undefined,
  number: number
): Promise<ResolvedProject> {
  type Cand = { login: string; token: string };
  let candidates: Cand[];
  let primaryLogin: string | undefined;
  if (authInfo) {
    const oc = await getOAuthCandidates(authInfo);
    primaryLogin = oc.primaryLogin;
    candidates = oc.candidates.map((c) => ({ login: c.login, token: c.token }));
  } else {
    const { name, config } = resolveStaticAccount(accountName, owner);
    candidates = [{ login: name, token: config.token }];
    owner = owner || config.defaultOwner;
  }
  const o = owner || primaryLogin;
  if (!o) throw new Error("Missing 'owner': the user or organization that owns the project.");

  if (accountName && authInfo) {
    const match = candidates.find((c) => c.login.toLowerCase() === accountName.toLowerCase());
    if (!match) {
      throw new Error(
        `Account '${accountName}' is not linked to your session. Available accounts: ${candidates.map((c) => c.login).join(", ")}.`
      );
    }
    candidates = [match];
  }

  const results = await Promise.all(candidates.map(async (c) => ({ c, ...(await projectAccess(c.token, o, number)) })));
  const noScope = results.filter((r) => r.access === "no-scope");
  if (noScope.length === results.length) throw new Error(MISSING_SCOPE_MESSAGE);
  if (noScope.length > 0) {
    throw new Error(
      `${noScope.map((r) => `'${r.c.login}'`).join(", ")} can't be checked for project ${o}#${number} yet: ${MISSING_SCOPE_MESSAGE} Or repeat the call with 'account' set to another account.`
    );
  }

  const pick = pickAccount(
    results.map((r) => ({ candidate: r, login: r.c.login, access: r.access as RepoAccess })),
    primaryLogin
  );
  if (pick.kind === "picked" && pick.candidate.project) {
    return { octokit: new Octokit({ auth: pick.candidate.c.token }), accountName: pick.login, owner: o, project: pick.candidate.project };
  }
  if (pick.kind === "revoked") throw new Error(revokedAccountsMessage(pick.logins));
  if (pick.kind === "unavailable") {
    throw new Error(`GitHub could not be reached for ${pick.logins.map((l) => `'${l}'`).join(", ")} right now. Try again in a few seconds, or set 'account'.`);
  }
  if (pick.kind === "ambiguous") {
    throw new Error(
      `More than one linked account can use project ${o}#${number} (${pick.options.map((a) => `${a.login}: ${a.access}`).join(", ")}). Repeat the call with 'account' set.`
    );
  }
  throw new Error(`Project ${o}#${number} was not found, or none of your linked accounts can see it. Use list_projects to see the projects of '${o}'.`);
}

function requireWrite(rp: ResolvedProject) {
  if (rp.project.viewerCanUpdate === false) {
    throw new Error(`Account '${rp.accountName}' can read project ${rp.owner}#${rp.project.number} but not edit it.`);
  }
}

type Content = { id: string; projectItems: { nodes: { id: string; project: { id: string } }[] } };

async function contentOf(octokit: Octokit, parts: { owner: string; repo: string; number: number }): Promise<Content> {
  const res = await octokit.graphql<{ repository: { issueOrPullRequest: Content | null } | null }>(CONTENT_ID_QUERY, {
    owner: parts.owner,
    name: parts.repo,
    number: parts.number,
  });
  const c = res.repository?.issueOrPullRequest;
  if (!c) throw new Error(`${parts.owner}/${parts.repo}#${parts.number} was not found, or this account can't see it.`);
  return c;
}

// An item given as an item ID (PVTI_…), 'owner/repo#123' or an issue/PR URL.
async function resolveItemId(rp: ResolvedProject, ref: string): Promise<string> {
  const r = ref.trim();
  if (/^PVTI_/.test(r)) {
    const res = await rp.octokit.graphql<{ node: { id: string; project?: { id: string } } | null }>(ITEM_BY_ID_QUERY, { id: r });
    if (!res.node?.project || res.node.project.id !== rp.project.id) {
      throw new Error(`Item '${r}' is not on project ${rp.owner}#${rp.project.number}.`);
    }
    return r;
  }
  const parts = parseItemRef(r);
  if (!parts) throw new Error(`'${ref}' is not an item reference. Use 'owner/repo#123', an issue/PR URL, or an item ID (PVTI_…).`);
  const content = await contentOf(rp.octokit, parts);
  const item = content.projectItems.nodes.find((n) => n.project.id === rp.project.id);
  if (!item) {
    throw new Error(`${parts.owner}/${parts.repo}#${parts.number} is not on project ${rp.owner}#${rp.project.number}. Add it first with add_project_item.`);
  }
  return item.id;
}

async function setFields(rp: ResolvedProject, itemId: string, fields: Record<string, string | number | null>): Promise<string[]> {
  // Resolve every value before writing anything, so a bad name changes nothing.
  const resolved = Object.entries(fields).map(([name, raw]) => resolveValue(rp.project, name, raw));
  const done: string[] = [];
  for (const r of resolved) {
    if (r.value === null) {
      await rp.octokit.graphql(CLEAR_FIELD_MUTATION, { projectId: rp.project.id, itemId, fieldId: r.field.id });
    } else {
      await rp.octokit.graphql(UPDATE_FIELD_MUTATION, { projectId: rp.project.id, itemId, fieldId: r.field.id, value: r.value });
    }
    done.push(`${r.field.name} → ${r.display}`);
  }
  return done;
}

async function readItem(rp: ResolvedProject, itemId: string): Promise<string> {
  const res = await rp.octokit.graphql<{ node: Item | null }>(ITEM_BY_ID_QUERY, { id: itemId });
  return res.node ? formatItem(res.node) : `  item ${itemId}`;
}

// A missing `project` scope always gives the same actionable message,
// whichever call hit it.
async function withProjectScope<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingProjectScope(err)) throw new Error(MISSING_SCOPE_MESSAGE);
    throw err;
  }
}

// ---------- Issue helpers (issue #109, ADR 0020) ----------

async function repoContext(octokit: Octokit, owner: string, repo: string, number: number | null): Promise<RepoContext> {
  const res = await octokit.graphql<{ repository: RepoContext | null }>(REPO_CONTEXT_QUERY, {
    owner,
    name: repo,
    number: number ?? 0,
    withIssue: number !== null,
  });
  const ctx = res.repository;
  if (!ctx) throw new Error(`Repository ${owner}/${repo} was not found, or this account can't see it.`);
  if (number !== null && !ctx.issue) throw new Error(`Issue ${owner}/${repo}#${number} was not found (or it is a pull request).`);
  return ctx;
}

// Every login must be assignable in the repository; all unknown ones are
// reported at once and nothing is written.
async function resolveAssignees(octokit: Octokit, owner: string, repo: string, logins: string[]): Promise<{ id: string; login: string }[]> {
  const out: { id: string; login: string }[] = [];
  const missing: string[] = [];
  for (const login of logins) {
    const res = await octokit.graphql<{ repository: { assignableUsers: { nodes: { id: string; login: string }[] } } | null }>(
      ASSIGNABLE_USERS_QUERY,
      { owner, name: repo, q: login.replace(/^@/, "") }
    );
    const hit = res.repository?.assignableUsers.nodes.find((u) => u.login.toLowerCase() === login.replace(/^@/, "").toLowerCase());
    if (hit) out.push(hit);
    else missing.push(login);
  }
  if (missing.length) {
    throw new Error(
      `${missing.map((m) => `'${m}'`).join(", ")} can't be assigned in ${owner}/${repo} (not a collaborator, or no such user). Nothing was changed.`
    );
  }
  return out;
}

async function issueRefId(octokit: Octokit, ref: string, owner: string, repo: string, what: string): Promise<{ id: string; label: string }> {
  const parts = parseIssueRef(ref, owner, repo);
  if (!parts) throw new Error(`'${ref}' is not an issue reference for ${what}. Use '#12', 'owner/repo#12' or the issue URL.`);
  const res = await octokit.graphql<{ repository: { issue: { id: string; number: number; repository: { nameWithOwner: string } } | null } | null }>(
    ISSUE_REF_QUERY,
    { owner: parts.owner, name: parts.repo, number: parts.number }
  );
  const issue = res.repository?.issue;
  if (!issue) throw new Error(`${what}: issue ${parts.owner}/${parts.repo}#${parts.number} was not found (or it is a pull request, or this account can't see it).`);
  return { id: issue.id, label: `${issue.repository.nameWithOwner}#${issue.number}` };
}

const nonEmpty = (xs: string[] | undefined) => (xs && xs.length ? xs : undefined);

// ---------- Activity breakdown helpers (ADR 0018) ----------

type PrRef = { repo: string; number: number; closed: boolean };

// Lines added/removed and files changed for each PR, from the cache when the
// PR is closed (sizes can still change while it's open), otherwise from
// GitHub. Stops starting new calls after `deadline`.
async function fetchPrStats(octokit: Octokit, cache: StatsCache, prs: PrRef[], deadline: number) {
  const out = new Map<string, Stats>();
  const closed = prs.filter((p) => p.closed);
  const cached = await cache.getStats(closed.map((p) => prStatsKey(p.repo, p.number)));
  closed.forEach((p, i) => {
    const s = cached[i];
    if (s) out.set(`${p.repo}#${p.number}`, s);
  });
  const missing = prs.filter((p) => !out.has(`${p.repo}#${p.number}`));
  const toWrite: [string, Stats][] = [];
  let fetched = 0;
  await mapLimit(missing, DETAIL_CONCURRENCY, async (p) => {
    if (Date.now() > deadline) return;
    const [o, r] = p.repo.split("/");
    const { data } = await octokit.pulls.get({ owner: o, repo: r, pull_number: p.number });
    const s = { additions: data.additions, deletions: data.deletions, files: data.changed_files };
    out.set(`${p.repo}#${p.number}`, s);
    fetched += 1;
    if (data.state === "closed") toWrite.push([prStatsKey(p.repo, p.number), s]);
  });
  await cache.setStats(toWrite);
  return Object.assign(out, { fetched });
}

async function fetchCommitStats(octokit: Octokit, cache: StatsCache, commits: CommitItem[], deadline: number) {
  const out = new Map<string, Stats>();
  for (let i = 0; i < commits.length; i += 500) {
    const chunk = commits.slice(i, i + 500);
    const cached = await cache.getStats(chunk.map((c) => commitStatsKey(c.repo, c.sha)));
    chunk.forEach((c, j) => {
      const s = cached[j];
      if (s) out.set(`${c.repo}@${c.sha}`, s);
    });
  }
  const missing = commits.filter((c) => !out.has(`${c.repo}@${c.sha}`));
  const toWrite: [string, Stats][] = [];
  let fetched = 0;
  await mapLimit(missing, DETAIL_CONCURRENCY, async (c) => {
    if (Date.now() > deadline) return;
    const [o, r] = c.repo.split("/");
    const { data } = await octokit.repos.getCommit({ owner: o, repo: r, ref: c.sha });
    const s = { additions: data.stats?.additions ?? 0, deletions: data.stats?.deletions ?? 0, files: data.files?.length ?? 0 };
    out.set(`${c.repo}@${c.sha}`, s);
    fetched += 1;
    toWrite.push([commitStatsKey(c.repo, c.sha), s]);
  });
  await cache.setStats(toWrite);
  return Object.assign(out, { fetched });
}

type Discovery<T> = { items: T[]; pending: number; truncated: string[]; rateLimited: string | null };

// Finds every item in the given day slices with GitHub search, splitting a
// slice in two whenever it holds more than GitHub's 1,000-result cap.
// Completed slices are cached (encrypted, per login). Spends at most
// `budget.left` searches; slices not reached are reported as pending.
async function discover<T>(
  cache: StatsCache,
  login: string,
  kind: string,
  owner: string,
  slices: Slice[],
  budget: { left: number },
  search: (s: Slice, page: number) => Promise<{ total: number; items: T[] }>
): Promise<Discovery<T>> {
  const queue = [...slices];
  const items: T[] = [];
  const truncated: string[] = [];
  while (queue.length) {
    const s = queue[0];
    const key = discoveryKey(login, kind, owner, s.from, s.to);
    const hit = await cache.getDiscovery<T[]>(key);
    if (hit) {
      items.push(...hit);
      queue.shift();
      continue;
    }
    if (budget.left <= 0) break;
    try {
      budget.left -= 1;
      const first = await search(s, 1);
      if (first.total > SEARCH_RESULT_CAP) {
        const halves = splitSlice(s);
        if (halves) {
          queue.splice(0, 1, ...halves);
          continue;
        }
        truncated.push(s.from);
      }
      const pages = pagesFor(first.total);
      if (pages - 1 > budget.left) break; // finish this slice in the next call
      const sliceItems = [...first.items];
      for (let p = 2; p <= pages; p++) {
        budget.left -= 1;
        sliceItems.push(...(await search(s, p)).items);
      }
      items.push(...sliceItems);
      await cache.setDiscovery(key, sliceItems, discoveryTtlSeconds(s));
      queue.shift();
    } catch (err) {
      const rl = rateLimitMessage(err);
      if (!rl) throw err;
      return { items, pending: queue.length, truncated, rateLimited: rl };
    }
  }
  return { items, pending: queue.length, truncated, rateLimited: null };
}

const ownerRepoShape = {
  account: z
    .string()
    .optional()
    .describe(
      "GitHub account login to use for this call. In non-OAuth mode, it's the name of the pre-configured account. In OAuth mode, it's optional: by default the server picks, among the primary account and any linked with 'link_account', the one that can write to the given repository (for a read-only repository, the primary account) — you only need to pass 'account' when more than one account can write to it, or more than one non-primary account can read it (the call returns an error asking for it in that case)."
    ),
  owner: z
    .string()
    .optional()
    .describe("Repository owner (user or organization). Optional if a default is configured."),
  repo: z.string().optional().describe("Repository name. Optional if a default is configured."),
};

// Applies a unified diff ('diff -u' / 'git diff' format) to a text. Used by
// both 'patch_file' and the 'patch' entries in 'create_tree'/'commit_tree'.
function applyUnifiedPatch(original: string, patchText: string): string {
  const result = applyPatch(original, patchText);
  if (result === false) {
    throw new Error(
      "Could not apply the patch — the file's current content has probably changed since the diff was generated. Fetch the current content (read_file or get_tree) and regenerate the patch from it."
    );
  }
  return result;
}

const rawHandler = createMcpHandler(
  (server) => {
    // ---------- BASIC GIT ----------

    server.registerTool(
      "create_branch",
      {
        description: "Creates a new branch from an existing one (default: main).",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch_name: z.string().describe("New branch name, e.g. fix/146-description"),
          from_branch: z.string().default("main").describe("Base branch to create the new one from"),
        }),
      },
      async ({ account, owner, repo, branch_name, from_branch }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const base = await octokit.git.getRef({ owner: o, repo: r, ref: `heads/${from_branch}` });
        await octokit.git.createRef({
          owner: o,
          repo: r,
          ref: `refs/heads/${branch_name}`,
          sha: base.data.object.sha,
        });
        return {
          content: [
            {
              type: "text",
              text: `Branch '${branch_name}' created from '${from_branch}' in ${o}/${r} (full SHA: ${base.data.object.sha}).`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "delete_branch",
      {
        description: "Deletes a branch. Refuses — without deleting anything — if it is the repository's default branch, a protected branch, or the head or base of an open pull request (close or merge the PR first). Unmerged commits do not block deletion; the response gives the branch's last commit SHA so it can be recreated if needed.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().describe("Branch to delete, e.g. feat/146-description"),
        }),
      },
      async ({ account, owner, repo, branch }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const repoInfo = await octokit.repos.get({ owner: o, repo: r });

        let info;
        try {
          info = await octokit.repos.getBranch({ owner: o, repo: r, branch });
        } catch (err) {
          if ((err as { status?: number }).status === 404) {
            throw new Error(`Branch '${branch}' does not exist in ${o}/${r}.`);
          }
          throw err;
        }

        const [asHead, asBase] = await Promise.all([
          octokit.pulls.list({ owner: o, repo: r, state: "open", head: `${o}:${branch}`, per_page: 100 }),
          octokit.pulls.list({ owner: o, repo: r, state: "open", base: branch, per_page: 100 }),
        ]);
        const seen = new Set<number>();
        const openPrs: OpenPr[] = [];
        for (const pr of [...asHead.data, ...asBase.data]) {
          if (seen.has(pr.number)) continue;
          seen.add(pr.number);
          openPrs.push({ number: pr.number, head: pr.head.ref, base: pr.base.ref });
        }

        const refusal = deleteBranchRefusal({
          branch,
          defaultBranch: repoInfo.data.default_branch,
          isProtected: info.data.protected,
          openPrs,
        });
        if (refusal) throw new Error(refusal);

        const lastSha = info.data.commit.sha;
        await octokit.git.deleteRef({ owner: o, repo: r, ref: `heads/${branch}` });
        return {
          content: [
            {
              type: "text",
              text: `Branch '${branch}' deleted from ${o}/${r}. Its last commit was ${lastSha} — create a branch from that commit to restore it if needed.`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "get_branch_head",
      {
        description: "Reads the full (40-character) SHA of the commit a branch currently points to. Use this to get the input SHA for 'parents' in 'create_commit', since other tools (commit_file, patch_file, commit_tree) only print an abbreviated SHA in their response text.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().describe("Branch name, e.g. main"),
        }),
      },
      async ({ account, owner, repo, branch }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const ref = await octokit.git.getRef({ owner: o, repo: r, ref: `heads/${branch}` });
        return {
          content: [{ type: "text", text: `Branch '${branch}' points to commit ${ref.data.object.sha}` }],
        };
      }
    );

    server.registerTool(
      "commit_file",
      {
        description: "Creates or updates a file directly on a branch, with a commit message (conventional commits).",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().describe("Branch where the commit will be made"),
          path: z.string().describe("File path in the repository, e.g. src/handlers/foo.js"),
          content: z.string().describe("Full file content (plain text, will be base64-encoded)"),
          message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
        }),
      },
      async ({ account, owner, repo, branch, path, content, message }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);

        let sha: string | undefined;
        try {
          const existing = await octokit.repos.getContent({ owner: o, repo: r, path, ref: branch });
          if (!Array.isArray(existing.data) && "sha" in existing.data) {
            sha = existing.data.sha;
          }
        } catch (err: any) {
          if (err.status !== 404) throw err;
        }

        const result = await octokit.repos.createOrUpdateFileContents({
          owner: o,
          repo: r,
          path,
          message,
          content: Buffer.from(content, "utf-8").toString("base64"),
          branch,
          sha,
        });

        const commitSha = result.data.commit.sha;
        return {
          content: [
            {
              type: "text",
              text: `Commit '${commitSha?.slice(0, 7)}' (full SHA: ${commitSha}) created on '${branch}': ${message}`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "patch_file",
      {
        description: "Applies a unified diff ('diff -u' or 'git diff' format) to an existing file on a branch, without needing to resend the whole content — ideal for editing a small chunk inside a large file. Fetches the file's current content on the branch, applies the patch, and commits only the result.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().describe("Branch where the commit will be made"),
          path: z.string().describe("Path of the file to patch, e.g. src/handlers/foo.js"),
          patch: z
            .string()
            .describe("Unified diff ('diff -u' or 'git diff' format) to apply over this file's current content"),
          message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
        }),
      },
      async ({ account, owner, repo, branch, path, patch, message }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);

        const existing = await octokit.repos.getContent({ owner: o, repo: r, path, ref: branch });
        if (Array.isArray(existing.data) || !("content" in existing.data)) {
          throw new Error(`'${path}' is not a file (or doesn't exist) on '${branch}'.`);
        }
        const currentContent = Buffer.from(existing.data.content, "base64").toString("utf-8");
        const patchedContent = applyUnifiedPatch(currentContent, patch);

        const result = await octokit.repos.createOrUpdateFileContents({
          owner: o,
          repo: r,
          path,
          message,
          content: Buffer.from(patchedContent, "utf-8").toString("base64"),
          branch,
          sha: existing.data.sha,
        });

        const commitSha = result.data.commit.sha;
        return {
          content: [
            {
              type: "text",
              text: `Commit '${commitSha?.slice(0, 7)}' (full SHA: ${commitSha}) created on '${branch}' (patch applied to '${path}'): ${message}`,
            },
          ],
        };
      }
    );

    // ---------- GIT DATA API (blobs/trees/commits) ----------
    //
    // Designed for large or multi-file commits: instead of resending each
    // file's full content in `commit_file`, a blob can be created once and
    // reused by SHA (a file that hasn't changed between commits never needs
    // to be resent), and a tree with several entries becomes a single
    // atomic commit. All of these operations are stateless — each call is
    // an isolated request to the GitHub API, which fits well with the
    // serverless deploy on Vercel (no filesystem or shared state between
    // invocations).
    //
    // Each tree entry also accepts 'patch' (a unified diff applied over
    // the current content of that path in the base tree) — for editing a
    // small chunk of a large file inside a multi-file commit, without
    // resending its full content or handling it separately.

    server.registerTool(
      "create_blob",
      {
        description: "Creates a blob (a raw Git content object) and returns its SHA. Use this to create a file's content before referencing it in a tree (via 'create_tree' or 'commit_tree'), or to get the SHA of specific content.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          content: z.string().describe("Blob content"),
          encoding: z
            .enum(["utf-8", "base64"])
            .default("utf-8")
            .describe("Encoding of 'content' — use 'base64' for binary files"),
        }),
      },
      async ({ account, owner, repo, content, encoding }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const blob = await octokit.git.createBlob({ owner: o, repo: r, content, encoding });
        return { content: [{ type: "text", text: `Blob created: ${blob.data.sha}` }] };
      }
    );

    server.registerTool(
      "get_tree",
      {
        description: "Reads a tree (file tree) from Git — lists paths and blob SHAs of a commit/branch/tree. Use this to find the SHA of an already-existing blob (and thus reuse it without resending content) before building a new tree. Select what to read with 'branch' (same name as the write tools) or 'tree_sha' (a tree SHA or any branch/tag/commit); default: main.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().optional().describe("Branch to read the tree from, e.g. feat/146-description. Same as passing it in 'tree_sha'."),
          tree_sha: z
            .string()
            .optional()
            .describe("Tree SHA, or a branch/tag/commit — the associated tree is resolved automatically. Default: main."),
          recursive: z.boolean().default(false).describe("If true, recursively lists all subfolders"),
        }),
      },
      async ({ account, owner, repo, branch, tree_sha, recursive }, ctx) => {
        const target = pickRef("get_tree", "tree_sha", tree_sha, branch);
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const tree = await octokit.git.getTree({
          owner: o,
          repo: r,
          tree_sha: target,
          recursive: recursive ? "true" : undefined,
        });
        const lines = tree.data.tree.map(
          (e) => `${e.type} ${e.path} — ${e.sha}${e.type === "blob" ? ` (${e.size ?? "?"} bytes)` : ""}`
        );
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Empty tree." }] };
      }
    );

    const treeEntryShape = z.strictObject({
      path: z.string().describe("File path, e.g. src/handlers/foo.js"),
      mode: z
        .enum(["100644", "100755", "040000", "160000", "120000"])
        .default("100644")
        .describe(
          "File mode: 100644 (regular), 100755 (executable), 040000 (subdirectory), 160000 (submodule), 120000 (symlink)"
        ),
      content: z.string().optional().describe("Full file content (creates a new blob). Use for a new file or a full rewrite."),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8").describe("Encoding of 'content', when provided"),
      patch: z
        .string()
        .optional()
        .describe(
          "Unified diff to apply over this path's current content in the base tree — to edit a small chunk without resending the whole file. Requires the path to already exist in the base tree."
        ),
      sha: z
        .union([z.string(), z.null()])
        .optional()
        .describe(
          "SHA of an already-existing blob to reuse without resending content, or null to remove this path"
        ),
    });

    async function buildPathShaMap(octokit: Octokit, o: string, r: string, baseTreeSha: string) {
      const tree = await octokit.git.getTree({ owner: o, repo: r, tree_sha: baseTreeSha, recursive: "true" });
      const map = new Map<string, string>();
      for (const e of tree.data.tree) {
        if (e.type === "blob" && e.path && e.sha) map.set(e.path, e.sha);
      }
      return map;
    }

    async function resolveTreeEntries(
      octokit: Octokit,
      o: string,
      r: string,
      entries: z.infer<typeof treeEntryShape>[],
      baseTreeSha?: string
    ) {
      let pathShaMap: Map<string, string> | null = null;
      const getPathShaMap = async () => {
        if (!pathShaMap) {
          if (!baseTreeSha) {
            throw new Error("Entries with 'patch' require 'base_tree' (in 'create_tree') — 'commit_tree' already resolves this on its own from the branch.");
          }
          pathShaMap = await buildPathShaMap(octokit, o, r, baseTreeSha);
        }
        return pathShaMap;
      };

      return Promise.all(
        entries.map(async (e) => {
          const provided = [e.content !== undefined, e.sha !== undefined, e.patch !== undefined].filter(
            Boolean
          ).length;
          if (provided > 1) {
            throw new Error(`Entry '${e.path}': provide only one of 'content', 'sha' or 'patch'.`);
          }

          let sha = e.sha;

          if (e.content !== undefined) {
            const blob = await octokit.git.createBlob({ owner: o, repo: r, content: e.content, encoding: e.encoding });
            sha = blob.data.sha;
          } else if (e.patch !== undefined) {
            const map = await getPathShaMap();
            const currentSha = map.get(e.path);
            if (!currentSha) {
              throw new Error(
                `Entry '${e.path}': path not found in the base tree to apply the patch to (new file? use 'content' instead of 'patch').`
              );
            }
            const currentBlob = await octokit.git.getBlob({ owner: o, repo: r, file_sha: currentSha });
            const currentContent = Buffer.from(currentBlob.data.content, "base64").toString("utf-8");
            const patchedContent = applyUnifiedPatch(currentContent, e.patch);
            const blob = await octokit.git.createBlob({ owner: o, repo: r, content: patchedContent, encoding: "utf-8" });
            sha = blob.data.sha;
          }

          return { path: e.path, mode: e.mode, type: "blob" as const, sha: sha ?? null };
        })
      );
    }

    server.registerTool(
      "create_tree",
      {
        description: "Builds a new tree from a base tree, applying the given entries. Each entry can bring 'content' (creates a new blob), 'patch' (applies a unified diff over the path's current content in the base tree — to edit a small chunk without resending the whole file), or 'sha' (reuses an already-existing blob, without resending content). 'sha: null' removes the path from the tree.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          base_tree: z
            .string()
            .optional()
            .describe(
              "Base tree SHA (normally the branch's current commit tree). If omitted, builds a tree from scratch — in that case, entries with 'patch' aren't possible."
            ),
          entries: z.array(treeEntryShape).min(1).describe("List of files to create/update/remove in this tree"),
        }),
      },
      async ({ account, owner, repo, base_tree, entries }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const resolvedEntries = await resolveTreeEntries(octokit, o, r, entries, base_tree);
        const tree = await octokit.git.createTree({ owner: o, repo: r, base_tree, tree: resolvedEntries as any });
        return {
          content: [{ type: "text", text: `Tree created: ${tree.data.sha} (${resolvedEntries.length} entrie(s))` }],
        };
      }
    );

    server.registerTool(
      "create_commit",
      {
        description: "Creates a commit object pointing to a tree and one or more parent commits. Doesn't move any branch on its own — use 'update_ref' afterwards to point a branch to the new commit. 'parents' requires the full (40-character) SHA — use 'get_branch_head' to get a branch's current full commit SHA.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          tree: z.string().describe("SHA of this commit's tree (from 'create_tree')"),
          parents: z.array(z.string()).min(1).describe("Full SHA(s) of the parent commit(s) — normally the branch's current commit, obtained via 'get_branch_head'"),
          message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
        }),
      },
      async ({ account, owner, repo, tree, parents, message }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const commit = await octokit.git.createCommit({ owner: o, repo: r, tree, parents, message });
        return { content: [{ type: "text", text: `Commit created: ${commit.data.sha} — ${message}` }] };
      }
    );

    server.registerTool(
      "update_ref",
      {
        description: "Points a branch to a specific commit. By default refuses to move the branch if it's not a fast-forward (avoids overwriting concurrent work) — use 'force: true' only when you're sure.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().describe("Branch to move, e.g. feat/146-description"),
          sha: z.string().describe("SHA of the commit the branch should point to"),
          force: z.boolean().default(false).describe("If true, forces the update even if it isn't a fast-forward"),
        }),
      },
      async ({ account, owner, repo, branch, sha, force }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        await octokit.git.updateRef({ owner: o, repo: r, ref: `heads/${branch}`, sha, force });
        return { content: [{ type: "text", text: `Branch '${branch}' now points to ${sha}.` }] };
      }
    );

    server.registerTool(
      "commit_tree",
      {
        description: "Creates a single atomic commit with several files at once, orchestrating blob → tree → commit → update_ref in one call. Each file can bring 'content' (creates a new blob), 'patch' (applies a unified diff over the file's current content on the branch — to edit a small chunk without resending the whole file), 'sha' (reuses an already-existing blob — for a file that didn't change between commits, without resending any content), or 'sha: null' (removes the file). Ideal for large or multi-file changes, where 'commit_file' would require one call per file with the full content every time.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().describe("Branch where the commit will be made"),
          message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
          files: z.array(treeEntryShape).min(1).describe("Files to create/update/remove in this commit"),
        }),
      },
      async ({ account, owner, repo, branch, message, files }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);

        const ref = await octokit.git.getRef({ owner: o, repo: r, ref: `heads/${branch}` });
        const parentSha = ref.data.object.sha;
        const parentCommit = await octokit.git.getCommit({ owner: o, repo: r, commit_sha: parentSha });
        const baseTree = parentCommit.data.tree.sha;

        const resolvedEntries = await resolveTreeEntries(octokit, o, r, files, baseTree);
        const tree = await octokit.git.createTree({ owner: o, repo: r, base_tree: baseTree, tree: resolvedEntries as any });
        const commit = await octokit.git.createCommit({
          owner: o,
          repo: r,
          tree: tree.data.sha,
          parents: [parentSha],
          message,
        });
        await octokit.git.updateRef({ owner: o, repo: r, ref: `heads/${branch}`, sha: commit.data.sha });

        return {
          content: [
            {
              type: "text",
              text: `Commit '${commit.data.sha.slice(0, 7)}' (full SHA: ${commit.data.sha}) created on '${branch}' with ${resolvedEntries.length} file(s): ${message}`,
            },
          ],
        };
      }
    );

    // ---------- PULL REQUESTS ----------

    server.registerTool(
      "open_pr",
      {
        description: "Opens a Pull Request from one branch into another.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          head: z.string().describe("Source branch (with the changes)"),
          base: z.string().default("main").describe("Target branch"),
          title: z.string().describe("PR title"),
          body: z.string().optional().describe("PR description"),
        }),
      },
      async ({ account, owner, repo, head, base, title, body }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const pr = await octokit.pulls.create({ owner: o, repo: r, head, base, title, body });
        return { content: [{ type: "text", text: `PR #${pr.data.number} opened: ${pr.data.html_url}` }] };
      }
    );

    server.registerTool(
      "list_prs",
      {
        description: "Lists the repository's Pull Requests.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          state: z.enum(["open", "closed", "all"]).default("open"),
        }),
      },
      async ({ account, owner, repo, state }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const prs = await octokit.pulls.list({ owner: o, repo: r, state, per_page: 30 });
        const lines = prs.data.map((p) => `#${p.number} [${p.state}] ${p.title} (${p.head.ref} → ${p.base.ref})`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No PRs found." }] };
      }
    );

    server.registerTool(
      "update_pr",
      {
        description: "Updates an existing Pull Request: its title, its description (replaced as a whole), its target branch, and/or its state (close or reopen). Pass only the fields to change; at least one is required. Does not merge.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          pr_number: z.number().int().describe("PR number"),
          title: z.string().optional().describe("New PR title"),
          body: z.string().optional().describe("New PR description — replaces the current one entirely"),
          base: z.string().optional().describe("New target branch, e.g. main"),
          state: z.enum(["open", "closed"]).optional().describe("'closed' closes the PR without merging; 'open' reopens it"),
        }),
      },
      async ({ account, owner, repo, pr_number, title, body, base, state }, ctx) => {
        const changes = { title, body, base, state };
        const changed = Object.entries(changes)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k);
        if (changed.length === 0) {
          throw new Error("update_pr needs at least one field to change: 'title', 'body', 'base' or 'state'.");
        }
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const pr = await octokit.pulls.update({ owner: o, repo: r, pull_number: pr_number, ...changes });
        return {
          content: [
            {
              type: "text",
              text: `PR #${pr.data.number} updated (${changed.join(", ")}) — now ${pr.data.state}, ${pr.data.head.ref} → ${pr.data.base.ref}: ${pr.data.html_url}`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "comment_pr",
      {
        description: "Comments on an existing Pull Request.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          pr_number: z.number().int().describe("PR number"),
          body: z.string().describe("Comment text"),
        }),
      },
      async ({ account, owner, repo, pr_number, body }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const comment = await octokit.issues.createComment({ owner: o, repo: r, issue_number: pr_number, body });
        return { content: [{ type: "text", text: `Comment posted on PR #${pr_number}: ${comment.data.html_url}` }] };
      }
    );

    server.registerTool(
      "list_pr_comments",
      {
        description:
          "Lists a Pull Request's comments with their IDs: conversation comments (IC_…) and inline review comments on the code (PRRC_…, with file and line). Use the IDs with edit_comment.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          pr_number: z.number().int().describe("PR number"),
        }),
      },
      async ({ account, owner, repo, pr_number }, ctx) => {
        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const conv = await octokit.paginate(octokit.issues.listComments, { owner: o, repo: r, issue_number: pr_number, per_page: 100 });
        const review = await octokit.paginate(octokit.pulls.listReviewComments, { owner: o, repo: r, pull_number: pr_number, per_page: 100 });
        const lines = [`PR ${o}/${r}#${pr_number} · account: ${accountName}`, "", `Conversation comments (${conv.length}) — kind 'conversation':`];
        if (!conv.length) lines.push("  (none)");
        for (const c of conv) lines.push(`— ${c.user?.login ?? "unknown"} (${c.created_at}) · id ${c.node_id}:\n${c.body ?? ""}`);
        lines.push("", `Inline review comments (${review.length}) — kind 'review':`);
        if (!review.length) lines.push("  (none)");
        for (const c of review) {
          const where = `${c.path}${c.line ?? c.original_line ? `:${c.line ?? c.original_line}` : ""}${c.line == null ? " (outdated)" : ""}`;
          lines.push(`— ${c.user?.login ?? "unknown"} (${c.created_at}) on ${where} · id ${c.node_id}${c.in_reply_to_id ? " · reply" : ""}:\n${c.body ?? ""}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    server.registerTool(
      "edit_comment",
      {
        description:
          "Replaces the text of an existing comment in the repository owner/repo (used to pick the account). kind 'conversation': issue comments and PR conversation comments (IDs IC_… from get_issue / list_pr_comments); kind 'review': PR inline review comments on the code (IDs PRRC_… from list_pr_comments).",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          comment_id: z.string().describe("The comment's ID (IC_… or PRRC_…), as shown by get_issue or list_pr_comments"),
          kind: z.enum(["conversation", "review"]).describe("'conversation' for IC_… IDs, 'review' for PRRC_… IDs"),
          body: z.string().min(1).describe("New comment text — replaces the current one entirely"),
        }),
      },
      async ({ account, owner, repo, comment_id, kind, body }, ctx) => {
        checkCommentKind(comment_id, kind);
        const { octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        if (kind === "conversation") {
          const res = await octokit.graphql<{ updateIssueComment: { issueComment: { url: string } } }>(UPDATE_ISSUE_COMMENT_MUTATION, {
            id: comment_id.trim(),
            body,
          });
          return { content: [{ type: "text", text: `Comment edited · account: ${accountName}: ${res.updateIssueComment.issueComment.url}` }] };
        }
        const res = await octokit.graphql<{ updatePullRequestReviewComment: { pullRequestReviewComment: { url: string } } }>(
          UPDATE_REVIEW_COMMENT_MUTATION,
          { id: comment_id.trim(), body }
        );
        return {
          content: [{ type: "text", text: `Review comment edited · account: ${accountName}: ${res.updatePullRequestReviewComment.pullRequestReviewComment.url}` }],
        };
      }
    );

    // ---------- ISSUES / BOARD ----------

    server.registerTool(
      "list_issues",
      {
        description: "Lists the repository's issues (can represent the board's tasks).",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          state: z.enum(["open", "closed", "all"]).default("open"),
        }),
      },
      async ({ account, owner, repo, state }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const issues = await octokit.issues.listForRepo({ owner: o, repo: r, state, per_page: 30 });
        const lines = issues.data
          .filter((i) => !i.pull_request)
          .map((i) => `#${i.number} [${i.state}] ${i.title}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No issues found." }] };
      }
    );

    server.registerTool(
      "get_issue",
      {
        description:
          "Brings back an issue's full content: state (with close reason), labels, assignees, milestone, type, parent issue and sub-issues, the description, and every comment in the order they were posted, each with its ID (IC_…) for edit_comment — to understand the history and reasoning behind it, not just the title.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          issue_number: z.number().int().describe("Issue/task number"),
        }),
      },
      async ({ account, owner, repo, issue_number }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const view = await octokit.graphql<{ repository: { issue: IssueView | null } | null }>(ISSUE_VIEW_QUERY, {
          owner: o,
          name: r,
          number: issue_number,
        });
        const issue = view.repository?.issue;
        if (!issue) throw new Error(`Issue ${o}/${r}#${issue_number} was not found (or it is a pull request).`);
        const meta = await octokit.issues.get({ owner: o, repo: r, issue_number });

        const comments: { node_id: string; user?: { login?: string | null } | null; created_at: string; body?: string | null }[] = [];
        let page = 1;
        while (true) {
          const res = await octokit.issues.listComments({ owner: o, repo: r, issue_number, per_page: 100, page });
          comments.push(...res.data);
          if (res.data.length < 100) break;
          page += 1;
        }

        const header = `${formatIssue(issue)}\nAuthor: ${meta.data.user?.login ?? "unknown"} · Created at: ${meta.data.created_at}`;
        const body = issue.body?.trim() ? issue.body : "(no description)";
        const commentLines = comments.length
          ? comments.map((c) => `— ${c.user?.login ?? "unknown"} (${c.created_at}) · id ${c.node_id}:\n${c.body ?? ""}`).join("\n\n")
          : "(no comments)";

        const text = `${header}\n\nDescription:\n${body}\n\nComments (${comments.length}):\n${commentLines}`;
        return { content: [{ type: "text", text }] };
      }
    );

    server.registerTool(
      "create_issue",
      {
        description:
          "Creates a new issue in the repository. Optionally, in the same call: labels, assignees, milestone, type (organization repositories only), parent issue, and a GitHub Project to add it to with initial field values. Every name is checked before anything is created; a wrong one lists the valid names.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          title: z.string(),
          body: z.string().optional(),
          labels: z.array(z.string()).optional().describe("Existing label names, e.g. [\"bug\", \"priority: high\"]"),
          assignees: z.array(z.string()).optional().describe("GitHub logins that can be assigned in the repository"),
          milestone: z.string().optional().describe("Existing milestone title"),
          type: z.string().optional().describe("Issue type name, e.g. 'Bug' (organization repositories only)"),
          parent: z.string().optional().describe("Parent issue: '#12', 'owner/repo#12' or its URL — the new issue becomes its sub-issue"),
          project: z
            .strictObject({
              owner: z.string().optional().describe("User or organization that owns the project. Default: your own GitHub user."),
              number: z.number().int().min(1).describe("Project number"),
              fields: z
                .record(z.string(), z.union([z.string(), z.number(), z.null()]))
                .optional()
                .describe("Initial field values, same format as update_project_item, e.g. {\"Status\": \"Ready\"}"),
            })
            .optional()
            .describe("GitHub Project (board) to add the new issue to"),
        }),
      },
      async ({ account, owner, repo, title, body, labels, assignees, milestone, type, parent, project }, ctx) => {
        const rr = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const { owner: o, repo: r, octokit } = rr;
        const rctx = await repoContext(octokit, o, r, null);

        // Resolve everything first: a wrong name creates nothing.
        const labelIds = nonEmpty(labels) ? resolveLabels(rctx, labels!).map((l) => l.id) : undefined;
        const assigneeIds = nonEmpty(assignees) ? (await resolveAssignees(octokit, o, r, assignees!)).map((a) => a.id) : undefined;
        const milestoneId = milestone ? resolveMilestone(rctx, milestone).id : undefined;
        const issueTypeId = type ? resolveType(rctx, type).id : undefined;
        const parentRef = parent ? await issueRefId(octokit, parent, o, r, "parent") : undefined;
        const rp = project
          ? await withProjectScope(async () => {
              const p = await resolveProject(ctx.http?.authInfo, account ?? rr.accountName, project.owner, project.number);
              requireWrite(p);
              for (const [k, v] of Object.entries(project.fields ?? {})) resolveValue(p.project, k, v);
              return p;
            })
          : undefined;

        const res = await octokit.graphql<{ createIssue: { issue: IssueView } }>(CREATE_ISSUE_MUTATION, {
          input: {
            repositoryId: rctx.id,
            title,
            body: body ?? null,
            labelIds,
            assigneeIds,
            milestoneId,
            issueTypeId,
            parentIssueId: parentRef?.id,
          },
        });
        const issue = res.createIssue.issue;
        const lines = [`Issue #${issue.number} created: ${issue.url} · account: ${rr.accountName}`];

        // Added with addProjectV2ItemById, which returns the item ID: reading
        // the issue's project items right after creating it can miss the new
        // link (read-after-write lag, #113).
        if (rp) {
          const board = `project ${rp.owner}#${rp.project.number} (${rp.project.title})`;
          let itemId: string | undefined;
          try {
            const added = await withProjectScope(() =>
              rp.octokit.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_ITEM_MUTATION, {
                projectId: rp.project.id,
                contentId: issue.id,
              })
            );
            itemId = added.addProjectV2ItemById.item.id;
            lines.push(`Added to ${board}.`);
          } catch (err) {
            lines.push(`⚠ The issue was created, but adding it to ${board} failed: ${(err as Error).message} Add it with add_project_item.`);
          }
          if (itemId && project?.fields && Object.keys(project.fields).length) {
            try {
              const set = await withProjectScope(() => setFields(rp, itemId!, project.fields!));
              lines.push(`Project fields: ${set.join(" · ")}`);
            } catch (err) {
              lines.push(
                `⚠ The issue was created and added to the board, but setting its project fields failed: ${(err as Error).message} Set them with update_project_item.`
              );
            }
          }
        }
        lines.push("", formatIssue(issue));
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    server.registerTool(
      "update_issue",
      {
        description:
          "Changes an issue in one atomic write: title, body (replaced as a whole), close (reason: completed, not_planned, or duplicate with 'duplicate_of') or reopen, add/remove labels, add/remove assignees, set or clear the milestone and the type. Pass only what changes. Labels, milestone, assignees and type must already exist — a wrong name lists the valid ones and nothing is written.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          issue_number: z.number().int().describe("Issue number"),
          title: z.string().optional().describe("New title"),
          body: z.string().optional().describe("New description — replaces the current one entirely"),
          state: z.enum(["open", "closed"]).optional().describe("'closed' closes it (default reason: completed); 'open' reopens it"),
          state_reason: z
            .enum(["completed", "not_planned", "duplicate"])
            .optional()
            .describe("Why it is closed. Implies closing. 'duplicate' needs 'duplicate_of'."),
          duplicate_of: z.string().optional().describe("The original issue, when closing as duplicate: '#12', 'owner/repo#12' or its URL"),
          add_labels: z.array(z.string()).optional().describe("Existing label names to add; labels already on the issue stay"),
          remove_labels: z.array(z.string()).optional().describe("Label names to remove; the others stay"),
          add_assignees: z.array(z.string()).optional().describe("Logins to assign; current assignees stay"),
          remove_assignees: z.array(z.string()).optional().describe("Logins to unassign; the others stay"),
          milestone: z.string().nullable().optional().describe("Existing milestone title, or null to clear"),
          type: z.string().nullable().optional().describe("Issue type name (organization repositories only), or null to clear"),
        }),
      },
      async (args, ctx) => {
        const { account, owner, repo, issue_number, title, body, add_labels, remove_labels, add_assignees, remove_assignees, milestone, type } = args;
        const changes = [title, body, args.state, args.state_reason, args.duplicate_of, add_labels, remove_labels, add_assignees, remove_assignees, milestone, type];
        if (changes.every((v) => v === undefined || (Array.isArray(v) && v.length === 0))) {
          throw new Error(
            "update_issue needs at least one change: title, body, state / state_reason / duplicate_of, add_labels, remove_labels, add_assignees, remove_assignees, milestone or type."
          );
        }
        const both = [...overlap(add_labels, remove_labels), ...overlap(add_assignees, remove_assignees)];
        if (both.length) throw new Error(`${both.map((x) => `'${x}'`).join(", ")} is both added and removed in the same call. Nothing was changed.`);
        const target = planState(args);

        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const rctx = await repoContext(octokit, o, r, issue_number);
        const before = rctx.issue!;

        // Resolve every name before writing anything.
        const input: Record<string, unknown> = { id: before.id };
        if (title !== undefined) input.title = title;
        if (body !== undefined) input.body = body;
        if (nonEmpty(add_labels) || nonEmpty(remove_labels)) {
          const add = nonEmpty(add_labels) ? resolveLabels(rctx, add_labels!) : [];
          const remove = nonEmpty(remove_labels) ? resolveLabels(rctx, remove_labels!) : [];
          input.labelIds = applyAddRemove(before.labels.nodes, add, remove).map((l) => l.id);
        }
        if (nonEmpty(add_assignees) || nonEmpty(remove_assignees)) {
          const add = nonEmpty(add_assignees) ? await resolveAssignees(octokit, o, r, add_assignees!) : [];
          const remove = (remove_assignees ?? []).map((login) => {
            const hit = before.assignees.nodes.find((a) => a.login.toLowerCase() === login.replace(/^@/, "").toLowerCase());
            return hit ?? { id: `missing:${login}`, login };
          });
          input.assigneeIds = applyAddRemove(before.assignees.nodes, add, remove).map((a) => a.id);
        }
        if (milestone !== undefined) input.milestoneId = milestone === null ? null : resolveMilestone(rctx, milestone).id;
        if (type !== undefined) input.issueTypeId = type === null ? null : resolveType(rctx, type).id;
        if (target) {
          const stateInput: Record<string, unknown> = { value: target.value };
          if (target.reason) stateInput.stateReason = target.reason;
          if (target.reason === "DUPLICATE") {
            const dup = await issueRefId(octokit, args.duplicate_of!, o, r, "duplicate_of");
            if (dup.id === before.id) throw new Error("An issue can't be a duplicate of itself. Nothing was changed.");
            stateInput.duplicateIssueId = dup.id;
          }
          input.stateInput = stateInput;
        }

        const res = await octokit.graphql<{ updateIssue: { issue: IssueView } }>(UPDATE_ISSUE_MUTATION, { input });
        const after = res.updateIssue.issue;
        const changed = diffIssue(before, after);
        const head = `Updated ${o}/${r}#${issue_number} · account: ${accountName}${changed.length ? ` · ${changed.join(" · ")}` : " · (nothing was different)"}`;
        return { content: [{ type: "text", text: `${head}\n\n${formatIssue(after)}` }] };
      }
    );

    server.registerTool(
      "add_sub_issue",
      {
        description:
          "Makes an issue a sub-issue of another. The parent is owner/repo/issue_number; the sub-issue can be in another repository ('owner/repo#12' or URL). An issue has at most one parent: set 'replace_parent' to move it from its current parent.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          issue_number: z.number().int().describe("Parent issue number"),
          sub_issue: z.string().describe("The issue to attach: '#12' (same repository), 'owner/repo#12' or its URL"),
          replace_parent: z.boolean().default(false).describe("If the sub-issue already has another parent, move it here"),
        }),
      },
      async ({ account, owner, repo, issue_number, sub_issue, replace_parent }, ctx) => {
        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const parent = await issueRefId(octokit, `#${issue_number}`, o, r, "parent");
        const child = await issueRefId(octokit, sub_issue, o, r, "sub_issue");
        if (child.id === parent.id) throw new Error("An issue can't be its own sub-issue.");
        const res = await octokit.graphql<{ addSubIssue: { issue: IssueView } }>(ADD_SUB_ISSUE_MUTATION, {
          issueId: parent.id,
          subIssueId: child.id,
          replaceParent: replace_parent,
        });
        return {
          content: [{ type: "text", text: `${child.label} is now a sub-issue of ${parent.label} · account: ${accountName}\n\n${formatIssue(res.addSubIssue.issue)}` }],
        };
      }
    );

    server.registerTool(
      "remove_sub_issue",
      {
        description: "Detaches a sub-issue from its parent. Both issues stay as they are; only the link is removed.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          issue_number: z.number().int().describe("Parent issue number"),
          sub_issue: z.string().describe("The sub-issue: '#12' (same repository), 'owner/repo#12' or its URL"),
        }),
      },
      async ({ account, owner, repo, issue_number, sub_issue }, ctx) => {
        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const parent = await issueRefId(octokit, `#${issue_number}`, o, r, "parent");
        const child = await issueRefId(octokit, sub_issue, o, r, "sub_issue");
        const res = await octokit.graphql<{ removeSubIssue: { issue: IssueView } }>(REMOVE_SUB_ISSUE_MUTATION, {
          issueId: parent.id,
          subIssueId: child.id,
        });
        return {
          content: [{ type: "text", text: `${child.label} is no longer a sub-issue of ${parent.label} · account: ${accountName}\n\n${formatIssue(res.removeSubIssue.issue)}` }],
        };
      }
    );

    server.registerTool(
      "comment_issue",
      {
        description: "Comments on an existing issue — use it to post the final QA report on the original board task.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          issue_number: z.number().int().describe("Issue/task number"),
          body: z.string().describe("Comment text (e.g. QA report)"),
        }),
      },
      async ({ account, owner, repo, issue_number, body }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const comment = await octokit.issues.createComment({ owner: o, repo: r, issue_number, body });
        return {
          content: [{ type: "text", text: `Comment posted on issue #${issue_number}: ${comment.data.html_url}` }],
        };
      }
    );

    // ---------- CODE READING ----------

    server.registerTool(
      "read_file",
      {
        description: "Reads a repository file's content on a specific branch or ref. Select it with 'branch' (same name as the write tools) or 'ref' (a branch, tag or commit SHA); default: main.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          path: z.string(),
          branch: z.string().optional().describe("Branch to read from, e.g. feat/146-description. Same as passing it in 'ref'."),
          ref: z.string().optional().describe("Branch, tag or commit SHA. Default: main."),
        }),
      },
      async ({ account, owner, repo, path, branch, ref }, ctx) => {
        const target = pickRef("read_file", "ref", ref, branch);
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const res = await octokit.repos.getContent({ owner: o, repo: r, path, ref: target });
        if (Array.isArray(res.data) || !("content" in res.data)) {
          return { content: [{ type: "text", text: `'${path}' is a directory, not a file.` }] };
        }
        const text = Buffer.from(res.data.content, "base64").toString("utf-8");
        return { content: [{ type: "text", text }] };
      }
    );

    server.registerTool(
      "search_code",
      {
        description: "Searches for code inside the repository.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          query: z.string().describe("Search term (GitHub code search syntax)"),
        }),
      },
      async ({ account, owner, repo, query }, ctx) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const res = await octokit.search.code({ q: `${query} repo:${o}/${r}` });
        const lines = res.data.items.map((i) => `${i.path} — ${i.html_url}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Nothing found." }] };
      }
    );

    // ---------- COMMIT HISTORY (issue #96, ADR 0016) ----------

    server.registerTool(
      "list_commits",
      {
        description:
          "Lists a repository's commits, newest first, with full SHA, author and committer (login, name, email), dates, full message, parents and signature status. Filter by branch/tag/SHA, file or folder path, author, and date range — for activity statistics. With 'include_stats: true' each commit also brings lines added/removed and the files it changed (one extra GitHub call per commit on your own token; page size capped at 30).",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          branch: z.string().optional().describe("Branch to list from. Same as 'sha'. Default: the repository's default branch."),
          sha: z.string().optional().describe("Branch, tag or commit SHA to start listing from. Same as 'branch'."),
          path: z.string().optional().describe("Only commits that touched this file or folder, e.g. app/ or README.md"),
          author: z.string().optional().describe("Only commits by this GitHub login or commit email"),
          since: z.string().optional().describe("Only commits on or after this date (ISO 8601, e.g. 2026-11-01T00:00:00Z)"),
          until: z.string().optional().describe("Only commits on or before this date (ISO 8601)"),
          per_page: z.number().int().optional().describe("Commits per page: up to 100, or up to 30 with include_stats. Default: the maximum."),
          page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
          include_stats: z.boolean().default(false).describe("Add lines added/removed and changed files to each commit"),
        }),
      },
      async ({ account, owner, repo, branch, sha, path, author, since, until, per_page, page, include_stats }, ctx) => {
        if (branch !== undefined && sha !== undefined && branch !== sha) {
          throw new Error(`list_commits received both 'sha' ('${sha}') and 'branch' ('${branch}') with different values. Pass only one of them.`);
        }
        const start = sha ?? branch;
        const size = resolvePerPage(per_page, include_stats);
        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const where = `${o}/${r}${start ? ` (${start})` : ""}`;

        let res;
        try {
          res = await octokit.repos.listCommits({
            owner: o,
            repo: r,
            sha: start,
            path,
            author,
            since,
            until,
            per_page: size.perPage,
            page,
          });
        } catch (err) {
          const msg = historyErrorMessage(err, where);
          if (msg) throw new Error(msg);
          throw err;
        }

        let commits: GhCommit[] = res.data as GhCommit[];
        if (include_stats && commits.length) {
          commits = await mapLimit(commits, STATS_CONCURRENCY, async (c) => {
            const detail = await octokit.repos.getCommit({ owner: o, repo: r, ref: c.sha });
            return detail.data as GhCommit;
          });
        }

        const next = nextPageFromLink(res.headers.link);
        const header = [
          `${commits.length} commit(s) in ${where}, page ${page}${next ? ` — more on page ${next}` : " — last page"} · account: ${accountName}`,
        ];
        const filters = [
          path && `path=${path}`,
          author && `author=${author}`,
          since && `since=${since}`,
          until && `until=${until}`,
        ].filter(Boolean);
        if (filters.length) header.push(`Filters: ${filters.join(", ")}`);
        if (size.capped) {
          header.push(
            `Note: per_page ${size.requested} was capped at ${size.perPage}${include_stats ? " because include_stats fetches each commit's detail" : ""}.`
          );
        }
        if (include_stats && commits.length) {
          const add = commits.reduce((s, c) => s + (c.stats?.additions ?? 0), 0);
          const del = commits.reduce((s, c) => s + (c.stats?.deletions ?? 0), 0);
          header.push(`Page totals: +${add} -${del} across ${commits.length} commit(s)`);
        }

        const body = commits.length
          ? commits
              .map((c) => {
                const block = formatCommit(c, { includeFiles: include_stats });
                const note = include_stats ? listFilesNote(c) : null;
                return note ? `${block}\n${note}` : block;
              })
              .join("\n\n")
          : "No commits found for these filters.";
        return { content: [{ type: "text", text: `${header.join("\n")}\n\n${body}` }] };
      }
    );

    server.registerTool(
      "get_commit",
      {
        description:
          "Reads one commit in full: author and committer, dates, message, parents, signature status, total lines added/removed, and every file it changed (status, lines added/removed, previous name on renames). 'include_patch: true' also returns each file's diff, truncated per file.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          ref: z.string().describe("Commit SHA (full or abbreviated), branch or tag. A branch or tag reads its latest commit."),
          include_patch: z.boolean().default(false).describe("Also return each file's diff (truncated per file)"),
        }),
      },
      async ({ account, owner, repo, ref, include_patch }, ctx) => {
        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const where = `${o}/${r} (${ref})`;

        let commit: GhCommit | undefined;
        const files: GhFile[] = [];
        try {
          for (let page = 1; files.length < COMMIT_FILES_MAX; page++) {
            const res = await octokit.repos.getCommit({
              owner: o,
              repo: r,
              ref,
              per_page: COMMIT_FILES_PER_PAGE,
              page,
            });
            const data = res.data as GhCommit;
            if (!commit) commit = data;
            const pageFiles = data.files ?? [];
            files.push(...pageFiles);
            if (pageFiles.length < COMMIT_FILES_PER_PAGE) break;
          }
        } catch (err) {
          const msg = historyErrorMessage(err, where);
          if (msg) throw new Error(msg);
          throw err;
        }

        const full = { ...commit!, files };
        const parts = [`Account: ${accountName}`, formatCommit(full, { includeFiles: true, includePatch: include_patch })];
        const note = commitFilesNote(files.length);
        if (note) parts.push(note);
        return { content: [{ type: "text", text: parts.join("\n") }] };
      }
    );

    server.registerTool(
      "compare_commits",
      {
        description:
          "Compares two branches, tags or SHAs: whether 'head' is ahead, behind, identical or diverged from 'base', the commits in head that are not in base, every file changed between them with lines added/removed, and the totals. 'head' can be 'user:branch' for a fork. GitHub returns at most 250 commits and 300 files per comparison; the response says when a limit was hit.",
        inputSchema: z.strictObject({
          ...ownerRepoShape,
          base: z.string().describe("Starting point: branch, tag or SHA, e.g. v1.2.0 or main"),
          head: z.string().describe("End point: branch, tag or SHA (or 'user:branch' for a fork), e.g. v1.3.0"),
          include_files: z.boolean().default(true).describe("List the changed files (the totals are always returned)"),
        }),
      },
      async ({ account, owner, repo, base, head, include_files }, ctx) => {
        const { owner: o, repo: r, octokit, accountName } = await resolveRepo(ctx.http?.authInfo, account, owner, repo);
        const where = `${o}/${r} (${base}...${head})`;

        let data;
        try {
          ({ data } = await octokit.repos.compareCommitsWithBasehead({ owner: o, repo: r, basehead: `${base}...${head}` }));
        } catch (err) {
          const msg = historyErrorMessage(err, where);
          if (msg) throw new Error(msg);
          throw err;
        }

        const commits = data.commits as GhCommit[];
        const files = (data.files ?? []) as GhFile[];
        const totals = fileTotals(files);
        const lines = [
          `Comparison ${where} · account: ${accountName}`,
          `Status: ${data.status} · ahead by ${data.ahead_by} · behind by ${data.behind_by}`,
          `Commits in head not in base: ${data.total_commits}`,
          `Totals: +${totals.additions} -${totals.deletions} (${totals.changes} lines changed) across ${totals.files} file(s)`,
          `URL: ${data.html_url}`,
          ...compareLimitNotes(head, data.total_commits, commits.length, files.length),
        ];
        if (include_files && files.length) {
          lines.push("", "Files:", ...files.map(formatFile));
        }
        lines.push(
          "",
          commits.length ? `Commits (${commits.length}, oldest first):` : "No commits in head that are not in base.",
          ...commits.map((c) => formatCommit(c)).join("\n\n").split("\n")
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    // ---------- PERSON-LEVEL ACTIVITY STATS (issue #98, ADR 0017) ----------

    const selfAccountShape = {
      account: z
        .string()
        .optional()
        .describe(
          "Limit the call to one of YOUR accounts (the primary one or one linked with 'link_account'). Default: every account linked to your session, each reported in its own section. Another person's login is not accepted."
        ),
    };

    server.registerTool(
      "get_contribution_stats",
      {
        description:
          "Statistics of everything YOU did on GitHub in a period, across every repository your token can reach, for each of your linked accounts separately: total commits, pull requests opened, pull request reviews, issues opened and repositories created; the breakdown by repository; and a monthly or daily contribution calendar. Default period: the last 12 months. Longer periods are split by year (GitHub's limit per query) and summed, with per-year subtotals. Only your own accounts — never another person's.",
        inputSchema: z.strictObject({
          ...selfAccountShape,
          from: z.string().optional().describe("Start of the period (ISO 8601, e.g. 2025-01-01). Default: 12 months before 'to'."),
          to: z.string().optional().describe("End of the period (ISO 8601). Default: now."),
          calendar: z.enum(["none", "monthly", "daily"]).default("monthly").describe("Contribution calendar granularity"),
        }),
      },
      async ({ account, from, to, calendar }, ctx) => {
        const period = resolvePeriod(from, to);
        const windows = yearlyWindows(period);
        const authInfo = ctx.http?.authInfo;
        const primaryLogin = typeof authInfo?.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
        const accounts = await listSelfAccounts(authInfo, account);

        const sections = await Promise.all(
          accounts.map((acc) =>
            perAccountSection(acc, primaryLogin, async () => {
              const fetchWindow = async (w: Period) => {
                const res = await acc.octokit.graphql<{ viewer: { login: string; contributionsCollection: Collection } }>(
                  CONTRIBUTIONS_QUERY,
                  { from: w.from.toISOString(), to: w.to.toISOString() }
                );
                return { window: w, collection: res.viewer.contributionsCollection, login: res.viewer.login };
              };
              const newest = await fetchWindow(windows[0]);
              const older = windowsWithActivity(windows, newest.collection.contributionYears).filter((w) => w !== windows[0]);
              const rest = await mapLimit(older, 4, fetchWindow);
              const merged = mergeCollections([newest, ...rest]);
              return formatContributionStats(newest.login, period, merged, calendar);
            })
          )
        );

        const header = `Contribution stats for ${accounts.length} account(s): ${accounts.map((a) => a.login).join(", ")}`;
        return { content: [{ type: "text", text: [header, ...sections].join("\n\n") }] };
      }
    );

    server.registerTool(
      "search_commits",
      {
        description:
          "Finds the commits YOU authored across every repository your token can reach, for each of your linked accounts separately, newest first: repository, full SHA, date, message and URL. Filter by period, owner (user or organization) or one repository. With 'include_stats: true' each commit also brings lines added/removed and changed files (page size capped at 30). GitHub's commit search only covers each repository's default branch and returns at most 1,000 results; search allows 30 requests per minute per user.",
        inputSchema: z.strictObject({
          ...selfAccountShape,
          since: z.string().optional().describe("Only commits authored on or after this date (ISO 8601)"),
          until: z.string().optional().describe("Only commits authored on or before this date (ISO 8601)"),
          owner: z.string().optional().describe("Only repositories of this user or organization"),
          repo: z.string().optional().describe("Only this repository (requires 'owner')"),
          per_page: z.number().int().optional().describe("Results per page per account: default 30, up to 100 (up to 30 with include_stats)"),
          page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
          include_stats: z.boolean().default(false).describe("Add lines added/removed and changed files to each commit"),
        }),
      },
      async ({ account, since, until, owner, repo, per_page, page, include_stats }, ctx) => {
        if (repo && !owner) throw new Error("search_commits: 'repo' needs 'owner' too.");
        const period = searchPeriod(since, until);
        const max = include_stats ? STATS_MAX_PER_PAGE : SEARCH_MAX_PER_PAGE;
        const asked = per_page ?? SEARCH_COMMITS_DEFAULT_PER_PAGE;
        const size = Math.max(1, Math.min(asked, max));
        const authInfo = ctx.http?.authInfo;
        const primaryLogin = typeof authInfo?.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
        const accounts = await listSelfAccounts(authInfo, account);

        const sections: string[] = [];
        for (const acc of accounts) {
          sections.push(
            await perAccountSection(acc, primaryLogin, async () => {
              const q = commitSearchQuery(acc.login, period, owner, repo);
              const res = await acc.octokit.search.commits({ q, sort: "author-date", order: "desc", per_page: size, page });
              const lines = [`## ${acc.login}`, `Query: ${q}`, `${res.data.total_count} commit(s) found · page ${page} · ${res.data.items.length} shown`];
              const limit = searchLimitNote(res.data.total_count);
              if (limit) lines.push(limit);
              if (asked > max) lines.push(`  Note: per_page ${asked} was capped at ${max}.`);
              if (res.data.incomplete_results) lines.push("  Note: GitHub reported incomplete results for this search (timeout); retry for the full count.");

              if (include_stats && res.data.items.length) {
                const detailed = await mapLimit(res.data.items, STATS_CONCURRENCY, async (it) => {
                  const [o, r] = it.repository.full_name.split("/");
                  const d = await acc.octokit.repos.getCommit({ owner: o, repo: r, ref: it.sha });
                  return { repo: it.repository.full_name, commit: d.data as GhCommit };
                });
                const add = detailed.reduce((s, x) => s + (x.commit.stats?.additions ?? 0), 0);
                const del = detailed.reduce((s, x) => s + (x.commit.stats?.deletions ?? 0), 0);
                lines.push(`Page totals: +${add} -${del}`, "");
                for (const x of detailed) lines.push(`Repository: ${x.repo}`, formatCommit(x.commit, { includeFiles: true }), "");
              } else {
                lines.push("");
                for (const it of res.data.items) {
                  const first = it.commit.message.split("\n")[0];
                  lines.push(`  ${it.repository.full_name} · ${it.sha} · ${it.commit.author?.date ?? "unknown date"} · ${first} · ${it.html_url}`);
                }
              }
              return lines.join("\n").trimEnd();
            })
          );
        }

        const header = `Commit search for ${accounts.length} account(s): ${accounts.map((a) => a.login).join(", ")} (default branches only)`;
        return { content: [{ type: "text", text: [header, ...sections].join("\n\n") }] };
      }
    );

    server.registerTool(
      "search_issues_prs",
      {
        description:
          "Finds the pull requests and issues YOU were involved in across every repository your token can reach, for each of your linked accounts separately, by role: authored, reviewed (PRs), merged (your PRs that were merged), assigned, commented. For each role: GitHub's total count plus the items with repository, number, title, state and created/closed/merged dates. Period filter uses the creation date (authored, assigned), the last update (reviewed, commented) or the merge date (merged). Search allows 30 requests per minute per user; each role and type is one request.",
        inputSchema: z.strictObject({
          ...selfAccountShape,
          role: z
            .array(z.enum(["authored", "reviewed", "merged", "assigned", "commented"]))
            .min(1)
            .optional()
            .describe("Roles to search. Default: all five."),
          type: z.enum(["pr", "issue", "both"]).default("both").describe("Pull requests, issues, or both"),
          state: z.enum(["open", "closed", "all"]).default("all").describe("Ignored for 'merged'"),
          since: z.string().optional().describe("Start of the period (ISO 8601)"),
          until: z.string().optional().describe("End of the period (ISO 8601)"),
          owner: z.string().optional().describe("Only repositories of this user or organization"),
          per_page: z.number().int().optional().describe("Items listed per role and type: default 10, up to 100 (up to 30 with include_stats). The total count is always returned."),
          page: z.number().int().min(1).default(1).describe("Page number, starting at 1"),
          include_stats: z.boolean().default(false).describe("Add each listed PR's size: lines added/removed and files changed (one extra GitHub call per PR, cached for closed PRs)"),
        }),
      },
      async ({ account, role, type, state, since, until, owner, per_page, page, include_stats }, ctx) => {
        const period = searchPeriod(since, until);
        const roles = role ?? ALL_ROLES;
        const maxSize = include_stats ? PR_STATS_MAX_PER_PAGE : SEARCH_MAX_PER_PAGE;
        const askedSize = per_page ?? SEARCH_ISSUES_DEFAULT_PER_PAGE;
        const size = Math.max(1, Math.min(askedSize, maxSize));
        const cache = new StatsCache();
        const authInfo = ctx.http?.authInfo;
        const primaryLogin = typeof authInfo?.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
        const accounts = await listSelfAccounts(authInfo, account);

        const sections: string[] = [];
        for (const acc of accounts) {
          sections.push(
            await perAccountSection(acc, primaryLogin, async () => {
              const { queries, skipped } = issueSearchQueries(acc.login, roles, type, state, period, owner);
              const lines = [`## ${acc.login}`];
              const summary: string[] = [];
              const blocks: string[] = [];
              for (const [i, query] of queries.entries()) {
                let res;
                try {
                  res = await acc.octokit.search.issuesAndPullRequests({ q: query.q, sort: "created", order: "desc", per_page: size, page });
                } catch (err) {
                  const rl = rateLimitMessage(err);
                  if (!rl) throw err;
                  // Keep what was already fetched; say exactly which roles are missing.
                  const missing = queries.slice(i).map((x) => `${x.role} · ${x.type === "pr" ? "pull requests" : "issues"}`);
                  summary.push(`  Not fetched (rate limit): ${missing.join(", ")}`);
                  blocks.push(rl);
                  break;
                }
                const label = `${query.role} · ${query.type === "pr" ? "pull requests" : "issues"}`;
                const items = res.data.items as SearchIssue[];
                const block = [`### ${label} — ${res.data.total_count} total (period by ${query.dateField} date)`, `Query: ${query.q}`];
                const limit = searchLimitNote(res.data.total_count);
                if (limit) block.push(limit);
                if (include_stats && query.type === "pr" && items.length) {
                  const prs = items.map((it) => ({ repo: repoFromUrl(it.repository_url), number: it.number, closed: it.state === "closed" }));
                  const stats = await fetchPrStats(acc.octokit, cache, prs, Date.now() + DETAIL_TIME_BUDGET_MS);
                  let add = 0;
                  let del = 0;
                  for (const it of items) {
                    const s = stats.get(`${repoFromUrl(it.repository_url)}#${it.number}`);
                    if (s) {
                      add += s.additions;
                      del += s.deletions;
                    }
                    block.push(`${formatIssueItem(it)}${s ? ` · +${s.additions} −${s.deletions}, ${s.files} files` : " · (size not fetched)"}`);
                  }
                  summary.push(`  ${label}: ${res.data.total_count} (listed ${items.length}: +${add} −${del})`);
                } else {
                  summary.push(`  ${label}: ${res.data.total_count}`);
                  block.push(...items.map(formatIssueItem));
                }
                if (!items.length) block.push("  (none)");
                blocks.push(block.join("\n"));
              }
              if (include_stats && askedSize > maxSize) lines.push(`Note: per_page ${askedSize} was capped at ${maxSize} because include_stats fetches each PR.`);
              lines.push("Totals:", ...summary);
              if (skipped.length) lines.push(...skipped.map((s) => `  Note: ${s}`));
              lines.push("", ...blocks.flatMap((b) => [b, ""]));
              return lines.join("\n").trimEnd();
            })
          );
        }

        const header = `Pull request / issue search for ${accounts.length} account(s): ${accounts.map((a) => a.login).join(", ")}`;
        return { content: [{ type: "text", text: [header, ...sections].join("\n\n") }] };
      }
    );

    server.registerTool(
      "get_activity_breakdown",
      {
        description:
          "How much YOU changed in a period, across every repository your token can reach — private ones included — for each of your linked accounts separately: commits, lines added/removed and files changed, plus the PRs you opened (and how many were merged) with their size; totals, by repository and by month. Commits are counted on each repository's default branch. Large periods are measured in batches: the response says what share was measured ('Coverage'); call again with the same arguments to continue — measured items are cached, so it resumes where it stopped. Default period: the last 12 months. Only your own accounts.",
        inputSchema: z.strictObject({
          ...selfAccountShape,
          since: z.string().optional().describe("Start of the period (ISO 8601, e.g. 2026-01-01). Default: 12 months before 'until'."),
          until: z.string().optional().describe("End of the period (ISO 8601). Default: now."),
          owner: z.string().optional().describe("Only repositories of this user or organization, e.g. robozz-br"),
        }),
      },
      async ({ account, since, until, owner }, ctx) => {
        const period = resolvePeriod(since, until);
        const slices = monthSlices(period.from, period.to);
        const deadline = Date.now() + DETAIL_TIME_BUDGET_MS;
        const authInfo = ctx.http?.authInfo;
        const primaryLogin = typeof authInfo?.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
        const accounts = await listSelfAccounts(authInfo, account);
        const cache = new StatsCache();
        const ownerQ = owner ? ` user:${owner}` : "";

        const sections: string[] = [];
        for (const acc of accounts) {
          sections.push(
            await perAccountSection(acc, primaryLogin, async () => {
              const budget = { left: SEARCHES_PER_CALL };
              const hitsBefore = cache.hits;
              // "commits-v2": lists cached before merges were flagged (issue #102) are ignored.
              const commits = await discover<CommitItem>(cache, acc.login, "commits-v2", owner ?? "", slices, budget, async (s, page) => {
                const res = await acc.octokit.search.commits({
                  q: `author:${acc.login} author-date:${s.from}..${s.to}${ownerQ}`,
                  sort: "author-date",
                  order: "desc",
                  per_page: SEARCH_PAGE_SIZE,
                  page,
                });
                return {
                  total: res.data.total_count,
                  items: res.data.items.map((it) => ({
                    repo: it.repository.full_name,
                    sha: it.sha,
                    date: it.commit.author?.date ?? `${s.from}T00:00:00Z`,
                    private: Boolean(it.repository.private),
                    merge: (it.parents?.length ?? 0) > 1,
                  })),
                };
              });
              const prs = await discover<PrItem>(cache, acc.login, "prs", owner ?? "", slices, budget, async (s, page) => {
                const res = await acc.octokit.search.issuesAndPullRequests({
                  q: `is:pr author:${acc.login} created:${s.from}..${s.to}${ownerQ}`,
                  sort: "created",
                  order: "desc",
                  per_page: SEARCH_PAGE_SIZE,
                  page,
                });
                return {
                  total: res.data.total_count,
                  items: (res.data.items as SearchIssue[]).map((it) => ({
                    repo: repoFromUrl(it.repository_url),
                    number: it.number,
                    created: it.created_at,
                    merged: it.pull_request?.merged_at ?? null,
                    state: it.state,
                    private: false,
                  })),
                };
              });

              // Same commit can surface twice (e.g. a fork); count it once.
              const seen = new Set<string>();
              const commitItems = commits.items.filter((c) => {
                const k = `${c.repo}@${c.sha}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              });
              const privateRepos = new Set(commitItems.filter((c) => c.private).map((c) => c.repo));
              const prItems = prs.items.map((p) => ({ ...p, private: privateRepos.has(p.repo) }));

              // Merge commits are not summed, so their lines are never fetched.
              const commitStats = await fetchCommitStats(acc.octokit, cache, commitItems.filter((c) => !c.merge), deadline);
              const prStats = await fetchPrStats(
                acc.octokit,
                cache,
                prItems.map((p) => ({ repo: p.repo, number: p.number, closed: p.state === "closed" })),
                deadline
              );

              const breakdown = aggregate(commitItems, commitStats, prItems, prStats);
              const text = formatBreakdown(acc.login, slices[0].from, slices[slices.length - 1].to, breakdown, {
                discoveryComplete: commits.pending === 0 && prs.pending === 0,
                pendingSlices: commits.pending + prs.pending,
                truncatedSlices: [...commits.truncated, ...prs.truncated],
                cache: cache.available ? "on" : "off",
                cacheHits: cache.hits - hitsBefore,
                fetchedNow: commitStats.fetched + prStats.fetched,
              });
              const rl = commits.rateLimited ?? prs.rateLimited;
              return rl ? `${text}\n\n${rl}` : text;
            })
          );
        }

        const header = `Activity breakdown for ${accounts.length} account(s): ${accounts.map((a) => a.login).join(", ")}`;
        return { content: [{ type: "text", text: [header, ...sections].join("\n\n") }] };
      }
    );

    // ---------- PROJECTS (v2) BOARD (issue #104, ADR 0019) ----------

    const projectShape = {
      account: ownerRepoShape.account,
      owner: z.string().optional().describe("User or organization that owns the project, e.g. robozz-br. Default: your own GitHub user."),
      number: z.number().int().min(1).describe("Project number, as in github.com/orgs/<owner>/projects/<number>"),
    };
    const itemRefSchema = z.string().describe("The item: 'owner/repo#123', an issue/PR URL, or an item ID (PVTI_…) from list_project_items");
    const fieldsSchema = z
      .record(z.string(), z.union([z.string(), z.number(), z.null()]))
      .describe(
        "Field name → value, e.g. {\"Status\": \"In progress\", \"Priority\": \"High\", \"Target date\": \"2026-12-15\", \"Iteration\": \"@current\"}. Single select: option name. Date: YYYY-MM-DD. Iteration: its title, '@current' or '@next'. null clears the field."
      );

    server.registerTool(
      "list_projects",
      {
        description: "Lists the GitHub Projects (boards) of a user or organization, most recently updated first: number, title, URL, item count, open/closed.",
        inputSchema: z.strictObject({
          account: ownerRepoShape.account,
          owner: z.string().optional().describe("User or organization. Default: your own GitHub user."),
          include_closed: z.boolean().default(false).describe("Also list closed projects"),
          after: z.string().optional().describe("Pagination cursor from a previous call"),
        }),
      },
      async ({ account, owner, include_closed, after }, ctx) =>
        withProjectScope(async () => {
          const authInfo = ctx.http?.authInfo;
          const accounts = await listSelfAccounts(authInfo, account);
          const acc = accounts[0];
          const o = owner || acc.login;
          const res = await acc.octokit.graphql<{
            repositoryOwner: {
              login: string;
              projectsV2?: {
                totalCount: number;
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: { number: number; title: string; url: string; closed: boolean; updatedAt: string; shortDescription?: string | null; items: { totalCount: number } }[];
              };
            } | null;
          }>(LIST_PROJECTS_QUERY, { login: o, first: 50, after: after ?? null });
          const conn = res.repositoryOwner?.projectsV2;
          if (!res.repositoryOwner) throw new Error(`'${o}' is not a GitHub user or organization this account can see.`);
          const nodes = (conn?.nodes ?? []).filter((p) => include_closed || !p.closed);
          const lines = [`Projects of ${res.repositoryOwner.login} · account: ${acc.login} · ${conn?.totalCount ?? 0} total${include_closed ? "" : " (closed hidden)"}`];
          for (const p of nodes) {
            lines.push(`  #${p.number} ${p.title}${p.closed ? " (closed)" : ""} · ${p.items.totalCount} items · updated ${p.updatedAt.slice(0, 10)} · ${p.url}`);
          }
          if (!nodes.length) lines.push("  (none)");
          if (conn?.pageInfo.hasNextPage) lines.push(`More: call again with after="${conn.pageInfo.endCursor}"`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        })
    );

    server.registerTool(
      "get_project",
      {
        description:
          "Reads a GitHub Project's structure: every field with its type, the options of single-select fields (e.g. Status), iterations with dates (current one marked), linked repositories and view names. Use it to know which field names and values update_project_item accepts.",
        inputSchema: z.strictObject(projectShape),
      },
      async ({ account, owner, number }, ctx) =>
        withProjectScope(async () => {
          const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
          return { content: [{ type: "text", text: `Account: ${rp.accountName}\n${formatProject(rp.project, rp.owner)}` }] };
        })
    );

    server.registerTool(
      "list_project_items",
      {
        description:
          "Lists the items on a GitHub Project board with every field value: type (issue, PR, draft), repository and number, title, state, assignees, Status/Priority/dates/iteration and custom fields. Optional filter by one field value, e.g. 'Status=In progress' ('Status=' for items with no value).",
        inputSchema: z.strictObject({
          ...projectShape,
          filter: z.string().optional().describe("Only items whose field has this value, e.g. 'Status=Done' or 'Priority=High'"),
          include_archived: z.boolean().default(false).describe("Also list archived items"),
          after: z.string().optional().describe("Pagination cursor from a previous call"),
        }),
      },
      async ({ account, owner, number, filter, include_archived, after }, ctx) =>
        withProjectScope(async () => {
          const f = parseFilter(filter);
          const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
          const res = await rp.octokit.graphql<{
            node: { items: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Item[] } } | null;
          }>(LIST_ITEMS_QUERY, {
            id: rp.project.id,
            first: 100,
            after: after ?? null,
            archivedStates: archivedStatesFor(include_archived),
          });
          const conn = res.node?.items;
          const nodes = (conn?.nodes ?? []).filter((i) => (include_archived || !i.isArchived) && matchesFilter(i, f));
          const lines = [
            `Project ${rp.owner}#${rp.project.number} ${rp.project.title} · account: ${rp.accountName} · ${conn?.totalCount ?? 0} items in total${f ? ` · filter ${f.field}=${f.value || "(empty)"}` : ""}`,
            `Showing ${nodes.length}${conn?.pageInfo.hasNextPage ? " from this page" : ""}:`,
            ...nodes.map(formatItem),
          ];
          if (!nodes.length) lines.push("  (none)");
          if (conn?.pageInfo.hasNextPage) lines.push(`More: call again with after="${conn.pageInfo.endCursor}"`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        })
    );

    server.registerTool(
      "add_project_item",
      {
        description:
          "Adds an item to a GitHub Project board: an existing issue or PR ('item'), or a new draft ('draft_title', optional 'draft_body'). Optionally sets field values right away ('fields', same format as update_project_item). Adding an issue that is already on the board returns the existing item.",
        inputSchema: z.strictObject({
          ...projectShape,
          item: z.string().optional().describe("Existing issue/PR: 'owner/repo#123' or its URL"),
          draft_title: z.string().optional().describe("Create a draft item with this title instead"),
          draft_body: z.string().optional().describe("Body of the draft item"),
          fields: fieldsSchema.optional(),
        }),
      },
      async ({ account, owner, number, item, draft_title, draft_body, fields }, ctx) =>
        withProjectScope(async () => {
          if (Boolean(item) === Boolean(draft_title)) throw new Error("Pass either 'item' (an existing issue/PR) or 'draft_title' (a new draft) — exactly one.");
          if (draft_body && !draft_title) throw new Error("'draft_body' needs 'draft_title'.");
          const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
          requireWrite(rp);
          if (fields) for (const [k, v] of Object.entries(fields)) resolveValue(rp.project, k, v); // validate before adding
          let itemId: string;
          let what: string;
          if (item) {
            const parts = parseItemRef(item);
            if (!parts) throw new Error(`'${item}' is not an issue/PR reference. Use 'owner/repo#123' or its URL.`);
            const content = await contentOf(rp.octokit, parts);
            const res = await rp.octokit.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(ADD_ITEM_MUTATION, {
              projectId: rp.project.id,
              contentId: content.id,
            });
            itemId = res.addProjectV2ItemById.item.id;
            what = `${parts.owner}/${parts.repo}#${parts.number}`;
          } else {
            const res = await rp.octokit.graphql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(ADD_DRAFT_MUTATION, {
              projectId: rp.project.id,
              title: draft_title,
              body: draft_body ?? null,
            });
            itemId = res.addProjectV2DraftIssue.projectItem.id;
            what = `draft "${draft_title}"`;
          }
          const set = fields ? await setFields(rp, itemId, fields) : [];
          const lines = [`Added ${what} to project ${rp.owner}#${rp.project.number} (${rp.project.title}) · account: ${rp.accountName}`];
          if (set.length) lines.push(`Set: ${set.join(" · ")}`);
          lines.push("Now:", await readItem(rp, itemId));
          return { content: [{ type: "text", text: lines.join("\n") }] };
        })
    );

    server.registerTool(
      "update_project_item",
      {
        description:
          "Changes field values of an item on a GitHub Project board, by field name: Status, Priority, dates, iteration, number, text and custom fields — several at once. Names and options are matched case-insensitively; a wrong name returns the valid ones and changes nothing. null clears a field. Issue fields (labels, assignees, milestone) are not project fields and can't be set here.",
        inputSchema: z.strictObject({ ...projectShape, item: itemRefSchema, fields: fieldsSchema }),
      },
      async ({ account, owner, number, item, fields }, ctx) =>
        withProjectScope(async () => {
          if (!Object.keys(fields).length) throw new Error("'fields' is empty — pass at least one field to change.");
          const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
          requireWrite(rp);
          const itemId = await resolveItemId(rp, item);
          const set = await setFields(rp, itemId, fields);
          return {
            content: [{ type: "text", text: [`Updated on project ${rp.owner}#${rp.project.number} · account: ${rp.accountName}`, `Set: ${set.join(" · ")}`, "Now:", await readItem(rp, itemId)].join("\n") }],
          };
        })
    );

    server.registerTool(
      "move_project_item",
      {
        description:
          "Moves an item on a GitHub Project board: right after another item ('after'), or to the top when 'after' is omitted. Affects views sorted manually (no sort field).",
        inputSchema: z.strictObject({
          ...projectShape,
          item: itemRefSchema,
          after: z.string().optional().describe("Place the item right after this one (same formats as 'item'). Omit to move it to the top."),
        }),
      },
      async ({ account, owner, number, item, after }, ctx) =>
        withProjectScope(async () => {
          const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
          requireWrite(rp);
          const itemId = await resolveItemId(rp, item);
          const afterId = after ? await resolveItemId(rp, after) : null;
          if (afterId === itemId) throw new Error("'item' and 'after' are the same item.");
          await rp.octokit.graphql(MOVE_ITEM_MUTATION, { projectId: rp.project.id, itemId, afterId });
          return {
            content: [{ type: "text", text: `Moved ${after ? `right after ${after}` : "to the top"} on project ${rp.owner}#${rp.project.number} · account: ${rp.accountName}\n${await readItem(rp, itemId)}` }],
          };
        })
    );

    for (const [name, mutation, verb, description] of [
      ["archive_project_item", ARCHIVE_ITEM_MUTATION, "Archived", "Archives an item on a GitHub Project board: it leaves the views but keeps its field values; unarchive_project_item brings it back."],
      ["unarchive_project_item", UNARCHIVE_ITEM_MUTATION, "Unarchived", "Brings an archived item back to a GitHub Project board, with its field values."],
    ] as const) {
      server.registerTool(
        name,
        { description, inputSchema: z.strictObject({ ...projectShape, item: itemRefSchema }) },
        async ({ account, owner, number, item }, ctx) =>
          withProjectScope(async () => {
            const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
            requireWrite(rp);
            const itemId = await resolveItemId(rp, item);
            await rp.octokit.graphql(mutation, { projectId: rp.project.id, itemId });
            return { content: [{ type: "text", text: `${verb} on project ${rp.owner}#${rp.project.number} · account: ${rp.accountName}\n${await readItem(rp, itemId)}` }] };
          })
      );
    }

    server.registerTool(
      "remove_project_item",
      {
        description:
          "Removes an item from a GitHub Project board. The issue or PR itself is not touched, but the item's field values on this board (Status, dates, etc.) are lost; a draft item is deleted for good. To hide an item without losing anything, use archive_project_item.",
        inputSchema: z.strictObject({ ...projectShape, item: itemRefSchema }),
      },
      async ({ account, owner, number, item }, ctx) =>
        withProjectScope(async () => {
          const rp = await resolveProject(ctx.http?.authInfo, account, owner, number);
          requireWrite(rp);
          const itemId = await resolveItemId(rp, item);
          const before = await readItem(rp, itemId);
          await rp.octokit.graphql(DELETE_ITEM_MUTATION, { projectId: rp.project.id, itemId });
          return {
            content: [{ type: "text", text: `Removed from project ${rp.owner}#${rp.project.number} · account: ${rp.accountName}\nWas:\n${before}\n(The issue/PR itself is unchanged; a draft is deleted.)` }],
          };
        })
    );

    // ---------- UTILITY ----------

    server.registerTool(
      "whoami",
      {
        description: "Shows which GitHub identity/account is being used in this session.",
        inputSchema: z.strictObject({}),
      },
      async (_args, ctx) => {
        const authInfo = ctx.http?.authInfo;
        if (authInfo) {
          const login = authInfo.extra?.githubLogin as string | undefined;
          return {
            content: [
              {
                type: "text",
                text: login
                  ? `Authenticated via OAuth as '${login}'.`
                  : "Authenticated via OAuth (could not read the GitHub login).",
              },
            ],
          };
        }
        const accounts = getStaticAccounts();
        const keys = Object.keys(accounts);
        if (keys.length === 0) return { content: [{ type: "text", text: "No account configured." }] };
        const lines = keys.map((k) => {
          const acc = accounts[k];
          const owners = acc.owners?.length ? acc.owners.join(", ") : acc.defaultOwner ?? "(no default)";
          const repo = acc.defaultRepo ? ` · default repo: ${acc.defaultRepo}` : "";
          const isDefault = k === DEFAULT_ACCOUNT || (keys.length === 1 && !DEFAULT_ACCOUNT) ? " [default]" : "";
          return `${k}${isDefault} — owners: ${owners}${repo}`;
        });
        return { content: [{ type: "text", text: `Fixed-account mode (no OAuth).\n${lines.join("\n")}` }] };
      }
    );

    server.registerTool(
      "link_account",
      {
        description: "Generates a one-time authorization link to link an ADDITIONAL GitHub account to your current session (multi-account support). Open the returned URL in a browser and approve — once linked, that account's repositories are picked up automatically (by per-repo detection), with no need to call this tool for it again. Only works in OAuth mode (authenticated with a primary account).",
        inputSchema: z.strictObject({}),
      },
      async (_args, ctx) => {
        const authInfo = ctx.http?.authInfo;
        if (!authInfo) {
          throw new Error("link_account only works in OAuth mode, authenticated with a primary account.");
        }
        const primaryLogin = authInfo.extra?.githubLogin as string | undefined;
        if (!primaryLogin) {
          throw new Error("Could not identify your primary account (GitHub login missing from the session).");
        }
        const origin = getServerOrigin();
        const state = encryptJson({ primaryLogin, iat: nowSeconds() });
        const url = `${origin}/link-account?state=${state}`;
        return {
          content: [
            {
              type: "text",
              text: `Open this link in a browser and authorize with the GitHub account you want to add (valid for 10 minutes):\n${url}`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "list_accounts",
      {
        description: "Lists the GitHub accounts linked to your current session: the primary account (authenticated via OAuth) and any additional account linked with 'link_account', with the status of each linked account's authorization (ok, revoked — re-link needed, or could not be checked right now). Use it to check which accounts are available for automatic repository detection.",
        inputSchema: z.strictObject({}),
      },
      async (_args, ctx) => {
        const authInfo = ctx.http?.authInfo;
        if (!authInfo) {
          throw new Error("list_accounts only works in OAuth mode, authenticated with a primary account.");
        }
        const primaryLogin = authInfo.extra?.githubLogin as string | undefined;
        if (!primaryLogin) {
          throw new Error("Could not identify your primary account (GitHub login missing from the session).");
        }
        const linked = await getLinkedAccounts(primaryLogin);
        // One GET /user per linked account, only when this tool is called
        // (ADR 0007). The primary token was already verified on this request.
        const checks = await Promise.all(linked.map((a) => verifyGithubTokenWithGithub(a.token)));
        const lines = [`${primaryLogin} [primary]`];
        linked.forEach((a, i) => {
          const check = checks[i];
          let status: string;
          if (check.kind === "ok") {
            status = "authorization ok";
          } else if (check.kind === "rejected") {
            status = "authorization revoked, run link_account again to re-link it, or unlink_account to remove it";
            audit("oauth.link.token_revoked", {
              primaryLogin,
              linkedLogin: a.login,
              tokenFingerprint: tokenFingerprint(a.token),
              where: "list_accounts",
              githubStatus: check.githubStatus,
              githubRequestId: check.githubRequestId,
            });
          } else {
            status = "authorization could not be checked right now (GitHub unavailable)";
          }
          lines.push(`${a.login} — linked on ${a.linkedAt} — ${status}`);
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    server.registerTool(
      "unlink_account",
      {
        description:
          "Unlinks an ADDITIONAL GitHub account from your session (the opposite of 'link_account') and revokes that link's token on GitHub. Only accounts linked to your own primary account can be unlinked; the primary account itself cannot. Use it when you no longer use an account, or when a revoked linked account keeps blocking automatic account detection. Only works in OAuth mode.",
        inputSchema: z.strictObject({
          account: z.string().describe("Login of the linked account to unlink, as shown by 'list_accounts'."),
        }),
      },
      async ({ account }, ctx) => {
        const authInfo = ctx.http?.authInfo;
        if (!authInfo) {
          throw new Error(
            "unlink_account only works in OAuth mode. In this server's mode, accounts are fixed in the GITHUB_ACCOUNTS environment variable — remove it there."
          );
        }
        const primaryLogin = authInfo.extra?.githubLogin as string | undefined;
        const result = await unlinkLinkedAccount(primaryLogin, account, {
          getLinkedLogins: (p) => getLinkedAccounts(p),
          deleteLink: (p, l) => unlinkAccount(p, l),
          revoke: (token) =>
            revokeOAuthToken(token, process.env.GITHUB_OAUTH_CLIENT_ID, process.env.GITHUB_OAUTH_CLIENT_SECRET),
          audit: (fields) => audit("oauth.link.removed", fields),
        });
        if (!result.ok) throw new Error(result.text);
        return { content: [{ type: "text", text: result.text }] };
      }
    );

    server.registerTool(
      "list_repos_by_account",
      {
        description: "Lists the repositories accessible by an account linked to your session — the primary one, or an additional one linked with 'link_account'. Useful for checking what each account can see before a call, or for picking the right 'account' when 'resolveRepo' asks because of ambiguity.",
        inputSchema: z.strictObject({
          account: z
            .string()
            .optional()
            .describe(
              "Login of the linked account whose repositories you want to list. If omitted, uses the session's primary account."
            ),
        }),
      },
      async ({ account }, ctx) => {
        const authInfo = ctx.http?.authInfo;
        if (!authInfo) {
          throw new Error("list_repos_by_account only works in OAuth mode, authenticated with a primary account.");
        }
        const { primaryLogin, candidates } = await getOAuthCandidates(authInfo);
        if (!primaryLogin) {
          throw new Error("Could not identify your primary account (GitHub login missing from the session).");
        }
        const target = account
          ? candidates.find((c) => c.login.toLowerCase() === account.toLowerCase())
          : candidates[0];
        if (!target) {
          throw new Error(
            `Account '${account}' is not linked to your session. Available accounts: ${candidates
              .map((c) => c.login)
              .join(", ")}. Use 'link_account' to link a new one.`
          );
        }

        const octokit = new Octokit({ auth: target.token });
        const repos: string[] = [];
        let page = 1;
        try {
          while (true) {
            const res = await octokit.repos.listForAuthenticatedUser({ per_page: 100, page, sort: "full_name" });
            repos.push(...res.data.map((r) => `${r.full_name}${r.private ? " (private)" : ""}`));
            if (res.data.length < 100) break;
            page += 1;
          }
        } catch (err) {
          if (accessFromError(err) === "revoked") {
            auditRevoked(primaryLogin, candidates, [target.login], "list_repos_by_account");
            throw new Error(revokedAccountsMessage([target.login]));
          }
          throw err;
        }

        return {
          content: [
            {
              type: "text",
              text: `Repositories accessible by '${target.login}' (${repos.length}):\n${
                repos.length ? repos.join("\n") : "(none)"
              }`,
            },
          ],
        };
      }
    );

    // ---------- REPOSITORIES ----------

    server.registerTool(
      "create_repo",
      {
        description:
          "Creates a new, EMPTY repository (no README, license or .gitignore) for a user or an organization. The account is chosen by 'owner': a linked account's own login creates a personal repository; any other owner is treated as an organization, and the linked account that is a member of it is used. 'private' has no default — if the user did not say whether the repository is private or public, ask them before calling. An empty repository only accepts commit_file for its first commit (which creates the default branch); commit_tree, create_tree, create_blob, create_commit and create_branch work after that. There is no tool to delete a repository.",
        inputSchema: z.strictObject({
          owner: z
            .string()
            .describe("Who owns the new repository: your own GitHub login (personal repository) or an organization name."),
          name: z.string().describe("Repository name, e.g. my-new-project"),
          private: z
            .boolean()
            .optional()
            .describe(
              "true for a private repository, false for a public one. Required in practice: if omitted, nothing is created and you must ask the user."
            ),
          description: z.string().optional().describe("Short repository description shown on GitHub."),
          account: z
            .string()
            .optional()
            .describe(
              "Linked account login to create with. Only needed when more than one linked account belongs to the organization (the call asks for it). In non-OAuth mode, the name of the pre-configured account."
            ),
        }),
      },
      async ({ owner, name, private: isPrivate, description, account }, ctx) => {
        if (isPrivate === undefined) {
          return { isError: true, content: [{ type: "text", text: VISIBILITY_REQUIRED_MESSAGE }] };
        }

        // Pick the account and whether the repository goes to a user or an org.
        let octokit: Octokit;
        let accountLogin: string;
        let asUser: boolean;

        const authInfo = ctx.http?.authInfo;
        if (authInfo) {
          const { primaryLogin, candidates } = await getOAuthCandidates(authInfo);

          if (account) {
            const match = findOwnAccount(account, candidates);
            if (!match) {
              throw new Error(
                `Account '${account}' is not linked to your session. Available accounts: ${candidates
                  .map((c) => c.login)
                  .join(", ")}. Use 'link_account' to link a new one.`
              );
            }
            octokit = new Octokit({ auth: match.token });
            accountLogin = match.login;
            asUser = match.login.toLowerCase() === owner.toLowerCase();
          } else {
            const own = findOwnAccount(owner, candidates);
            if (own) {
              octokit = new Octokit({ auth: own.token });
              accountLogin = own.login;
              asUser = true;
            } else if (candidates.length === 1) {
              // A single account: no choice to make; GitHub refuses if it
              // cannot create in that organization.
              octokit = new Octokit({ auth: candidates[0].token });
              accountLogin = candidates[0].login;
              asUser = false;
            } else {
              const results: MembershipResult<(typeof candidates)[number]>[] = await Promise.all(
                candidates.map(async (c) => {
                  try {
                    const { data } = await new Octokit({ auth: c.token }).orgs.getMembershipForAuthenticatedUser({
                      org: owner,
                    });
                    return { candidate: c, login: c.login, membership: membershipFromState(data.state) };
                  } catch (err) {
                    return { candidate: c, login: c.login, membership: membershipFromError(err) };
                  }
                })
              );
              const pick = pickOrgCreator(results);
              if (pick.kind === "revoked") {
                auditRevoked(primaryLogin, candidates, pick.logins, "create_repo");
                throw new Error(revokedAccountsMessage(pick.logins));
              }
              if (pick.kind === "unavailable") {
                throw new Error(
                  `GitHub could not be reached for ${pick.logins
                    .map((l) => `'${l}'`)
                    .join(", ")} right now, so the account to create '${owner}/${name}' can't be chosen safely. Nothing was created. Try again in a few seconds, or repeat the call with 'account' set.`
                );
              }
              if (pick.kind === "ambiguous") {
                throw new Error(
                  `More than one linked account belongs to '${owner}' (${pick.logins.join(
                    ", "
                  )}). Nothing was created. Repeat the call with 'account' set to the one that should create the repository.`
                );
              }
              if (pick.kind === "no-member") {
                throw new Error(
                  `'${owner}' is not one of your linked accounts (${candidates
                    .map((c) => c.login)
                    .join(", ")}), and none of them is a member of an organization called '${owner}'.${
                    pick.restricted
                      ? " At least one account was blocked by the organization's OAuth App access restrictions — an organization owner has to approve this app."
                      : ""
                  } Nothing was created. Check the owner name, or link the right account with 'link_account'.`
                );
              }
              octokit = new Octokit({ auth: pick.candidate.token });
              accountLogin = pick.login;
              asUser = false;
            }
          }
        } else {
          const { name: staticName, config } = resolveStaticAccount(account, owner);
          octokit = new Octokit({ auth: config.token });
          accountLogin = staticName;
          const me = await octokit.users.getAuthenticated();
          asUser = me.data.login.toLowerCase() === owner.toLowerCase();
        }

        let created;
        try {
          created = asUser
            ? await octokit.repos.createForAuthenticatedUser({ name, private: isPrivate, description, auto_init: false })
            : await octokit.repos.createInOrg({ org: owner, name, private: isPrivate, description, auto_init: false });
        } catch (err) {
          throw new Error(createErrorMessage(owner, name, accountLogin, err));
        }

        return {
          content: [
            {
              type: "text",
              text: createdMessage({
                fullName: created.data.full_name,
                url: created.data.html_url,
                isPrivate: created.data.private,
                defaultBranch: created.data.default_branch || "main",
                account: accountLogin,
              }),
            },
          ],
        };
      }
    );
  },
  { verboseLogs: process.env.NODE_ENV !== "production" }
);

// The token is checked against GitHub once per request, in `handler` below,
// BEFORE withMcpAuth runs. withMcpAuth turns any error thrown by its verifier
// into a 401, which the MCP client treats as a lost login — so a transient
// GitHub error must be answered (503) before it ever reaches withMcpAuth.
// The classified result is handed to the verifier through this map, keyed by
// the same Request object, so there is still a single GET /user per request.
const verifiedRequests = new WeakMap<Request, GithubVerification>();

// Same parsing as mcp-handler's withMcpAuth, so both see the same token.
function bearerTokenOf(req: Request): string | undefined {
  const [type, token] = req.headers.get("Authorization")?.split(" ") || [];
  return type?.toLowerCase() === "bearer" ? token : undefined;
}

async function verifyGithubToken(req: Request, bearerToken?: string) {
  if (!bearerToken) return undefined;
  const result = verifiedRequests.get(req) ?? (await verifyGithubTokenWithGithub(bearerToken));
  if (result.kind !== "ok") {
    // Only "rejected" can reach here: "transient" is answered in `handler`.
    throw new Error("Invalid or expired GitHub token.");
  }
  return {
    token: bearerToken,
    clientId: "github-oauth",
    scopes: [],
    extra: { githubLogin: result.login },
  };
}

const authedHandler = oauthEnabled() ? withMcpAuth(rawHandler, verifyGithubToken, { required: true }) : rawHandler;

// Rate limit first: in OAuth mode this runs before the token is verified,
// so requests over the limit never cost a GET /user call to GitHub.
async function handler(req: Request) {
  const limited = await rateLimitMcp(req, oauthEnabled());
  if (limited) return limited;

  const bearerToken = oauthEnabled() ? bearerTokenOf(req) : undefined;
  if (bearerToken) {
    const result = await verifyGithubTokenWithGithub(bearerToken);
    verifiedRequests.set(req, result);

    if (result.kind === "transient") {
      const { kind, ...diagnostics } = result;
      audit("mcp.auth.transient", {
        ...diagnostics,
        tokenFp: tokenFingerprint(bearerToken),
        ip: getClientIp(req),
      });
      return serviceUnavailable(result.retryAfterSeconds);
    }

    if (result.kind === "rejected") {
      const { kind, ...diagnostics } = result;
      audit("mcp.auth.rejected", {
        ...diagnostics,
        tokenFp: tokenFingerprint(bearerToken),
        ip: getClientIp(req),
      });
      // Only a genuine rejection counts toward the per-IP failure window.
      await recordFailedTokenVerification(req);
    }
  }

  return authedHandler(req);
}

export { handler as GET, handler as POST, handler as DELETE };
