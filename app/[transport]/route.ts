import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { Octokit } from "@octokit/rest";
import { applyPatch } from "diff";
import { z } from "zod";
import { oauthEnabled, encryptJson, nowSeconds } from "../../lib/oauth";
import { getServerOrigin } from "../../lib/mongo";
import { getLinkedAccounts } from "../../lib/accounts";

export const runtime = "nodejs";

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

// Checks whether a GitHub token has read access to a specific repository —
// used for automatic account detection when more than one is linked to the
// session.
async function candidateHasAccess(token: string, owner: string, repo: string): Promise<boolean> {
  try {
    await new Octokit({ auth: token }).repos.get({ owner, repo });
    return true;
  } catch {
    return false;
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

    // Multiple linked accounts and none specified: auto-detect by checking
    // which one(s) have access to the target repository.
    const checked = await Promise.all(
      candidates.map(async (c) => ((await candidateHasAccess(c.token, o, r)) ? c : null))
    );
    const withAccess = checked.filter((c): c is OAuthCandidate => c !== null);

    if (withAccess.length === 1) {
      return {
        owner: o,
        repo: r,
        octokit: new Octokit({ auth: withAccess[0].token }),
        accountName: withAccess[0].login,
      };
    }
    if (withAccess.length === 0) {
      throw new Error(
        `None of your linked accounts have access to '${o}/${r}'. Available accounts: ${candidates
          .map((c) => c.login)
          .join(", ")}. Link the right account with 'link_account', or double-check the repository name.`
      );
    }
    throw new Error(
      `More than one linked account has access to '${o}/${r}' (${withAccess
        .map((c) => c.login)
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

const ownerRepoShape = {
  account: z
    .string()
    .optional()
    .describe(
      "GitHub account login to use for this call. In non-OAuth mode, it's the name of the pre-configured account. In OAuth mode, it's optional: by default the server figures out on its own, among the primary account and any linked with 'link_account', which one has access to the given repository — you only need to pass 'account' when more than one has access to the same repository (the call returns an error asking for it in that case)."
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

    server.tool(
      "create_branch",
      "Creates a new branch from an existing one (default: main).",
      {
        ...ownerRepoShape,
        branch_name: z.string().describe("New branch name, e.g. fix/146-description"),
        from_branch: z.string().default("main").describe("Base branch to create the new one from"),
      },
      async ({ account, owner, repo, branch_name, from_branch }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
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

    server.tool(
      "get_branch_head",
      "Reads the full (40-character) SHA of the commit a branch currently points to. Use this to get the input SHA for 'parents' in 'create_commit', since other tools (commit_file, patch_file, commit_tree) only print an abbreviated SHA in their response text.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch name, e.g. main"),
      },
      async ({ account, owner, repo, branch }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const ref = await octokit.git.getRef({ owner: o, repo: r, ref: `heads/${branch}` });
        return {
          content: [{ type: "text", text: `Branch '${branch}' points to commit ${ref.data.object.sha}` }],
        };
      }
    );

    server.tool(
      "commit_file",
      "Creates or updates a file directly on a branch, with a commit message (conventional commits).",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch where the commit will be made"),
        path: z.string().describe("File path in the repository, e.g. src/handlers/foo.js"),
        content: z.string().describe("Full file content (plain text, will be base64-encoded)"),
        message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
      },
      async ({ account, owner, repo, branch, path, content, message }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);

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

    server.tool(
      "patch_file",
      "Applies a unified diff ('diff -u' or 'git diff' format) to an existing file on a branch, without needing to resend the whole content — ideal for editing a small chunk inside a large file. Fetches the file's current content on the branch, applies the patch, and commits only the result.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch where the commit will be made"),
        path: z.string().describe("Path of the file to patch, e.g. src/handlers/foo.js"),
        patch: z
          .string()
          .describe("Unified diff ('diff -u' or 'git diff' format) to apply over this file's current content"),
        message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
      },
      async ({ account, owner, repo, branch, path, patch, message }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);

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

    server.tool(
      "create_blob",
      "Creates a blob (a raw Git content object) and returns its SHA. Use this to create a file's content before referencing it in a tree (via 'create_tree' or 'commit_tree'), or to get the SHA of specific content.",
      {
        ...ownerRepoShape,
        content: z.string().describe("Blob content"),
        encoding: z
          .enum(["utf-8", "base64"])
          .default("utf-8")
          .describe("Encoding of 'content' — use 'base64' for binary files"),
      },
      async ({ account, owner, repo, content, encoding }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const blob = await octokit.git.createBlob({ owner: o, repo: r, content, encoding });
        return { content: [{ type: "text", text: `Blob created: ${blob.data.sha}` }] };
      }
    );

    server.tool(
      "get_tree",
      "Reads a tree (file tree) from Git — lists paths and blob SHAs of a commit/branch/tree. Use this to find the SHA of an already-existing blob (and thus reuse it without resending content) before building a new tree.",
      {
        ...ownerRepoShape,
        tree_sha: z
          .string()
          .default("main")
          .describe("Tree SHA, or a branch/tag/commit — the associated tree is resolved automatically"),
        recursive: z.boolean().default(false).describe("If true, recursively lists all subfolders"),
      },
      async ({ account, owner, repo, tree_sha, recursive }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const tree = await octokit.git.getTree({
          owner: o,
          repo: r,
          tree_sha,
          recursive: recursive ? "true" : undefined,
        });
        const lines = tree.data.tree.map(
          (e) => `${e.type} ${e.path} — ${e.sha}${e.type === "blob" ? ` (${e.size ?? "?"} bytes)` : ""}`
        );
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Empty tree." }] };
      }
    );

    const treeEntryShape = z.object({
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

    server.tool(
      "create_tree",
      "Builds a new tree from a base tree, applying the given entries. Each entry can bring 'content' (creates a new blob), 'patch' (applies a unified diff over the path's current content in the base tree — to edit a small chunk without resending the whole file), or 'sha' (reuses an already-existing blob, without resending content). 'sha: null' removes the path from the tree.",
      {
        ...ownerRepoShape,
        base_tree: z
          .string()
          .optional()
          .describe(
            "Base tree SHA (normally the branch's current commit tree). If omitted, builds a tree from scratch — in that case, entries with 'patch' aren't possible."
          ),
        entries: z.array(treeEntryShape).min(1).describe("List of files to create/update/remove in this tree"),
      },
      async ({ account, owner, repo, base_tree, entries }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const resolvedEntries = await resolveTreeEntries(octokit, o, r, entries, base_tree);
        const tree = await octokit.git.createTree({ owner: o, repo: r, base_tree, tree: resolvedEntries as any });
        return {
          content: [{ type: "text", text: `Tree created: ${tree.data.sha} (${resolvedEntries.length} entrie(s))` }],
        };
      }
    );

    server.tool(
      "create_commit",
      "Creates a commit object pointing to a tree and one or more parent commits. Doesn't move any branch on its own — use 'update_ref' afterwards to point a branch to the new commit. 'parents' requires the full (40-character) SHA — use 'get_branch_head' to get a branch's current full commit SHA.",
      {
        ...ownerRepoShape,
        tree: z.string().describe("SHA of this commit's tree (from 'create_tree')"),
        parents: z.array(z.string()).min(1).describe("Full SHA(s) of the parent commit(s) — normally the branch's current commit, obtained via 'get_branch_head'"),
        message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
      },
      async ({ account, owner, repo, tree, parents, message }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const commit = await octokit.git.createCommit({ owner: o, repo: r, tree, parents, message });
        return { content: [{ type: "text", text: `Commit created: ${commit.data.sha} — ${message}` }] };
      }
    );

    server.tool(
      "update_ref",
      "Points a branch to a specific commit. By default refuses to move the branch if it's not a fast-forward (avoids overwriting concurrent work) — use 'force: true' only when you're sure.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch to move, e.g. feat/146-description"),
        sha: z.string().describe("SHA of the commit the branch should point to"),
        force: z.boolean().default(false).describe("If true, forces the update even if it isn't a fast-forward"),
      },
      async ({ account, owner, repo, branch, sha, force }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        await octokit.git.updateRef({ owner: o, repo: r, ref: `heads/${branch}`, sha, force });
        return { content: [{ type: "text", text: `Branch '${branch}' now points to ${sha}.` }] };
      }
    );

    server.tool(
      "commit_tree",
      "Creates a single atomic commit with several files at once, orchestrating blob → tree → commit → update_ref in one call. Each file can bring 'content' (creates a new blob), 'patch' (applies a unified diff over the file's current content on the branch — to edit a small chunk without resending the whole file), 'sha' (reuses an already-existing blob — for a file that didn't change between commits, without resending any content), or 'sha: null' (removes the file). Ideal for large or multi-file changes, where 'commit_file' would require one call per file with the full content every time.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch where the commit will be made"),
        message: z.string().describe("Commit message following conventional commits (feat:, fix:, chore:, etc.)"),
        files: z.array(treeEntryShape).min(1).describe("Files to create/update/remove in this commit"),
      },
      async ({ account, owner, repo, branch, message, files }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);

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

    server.tool(
      "open_pr",
      "Opens a Pull Request from one branch into another.",
      {
        ...ownerRepoShape,
        head: z.string().describe("Source branch (with the changes)"),
        base: z.string().default("main").describe("Target branch"),
        title: z.string().describe("PR title"),
        body: z.string().optional().describe("PR description"),
      },
      async ({ account, owner, repo, head, base, title, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const pr = await octokit.pulls.create({ owner: o, repo: r, head, base, title, body });
        return { content: [{ type: "text", text: `PR #${pr.data.number} opened: ${pr.data.html_url}` }] };
      }
    );

    server.tool(
      "list_prs",
      "Lists the repository's Pull Requests.",
      {
        ...ownerRepoShape,
        state: z.enum(["open", "closed", "all"]).default("open"),
      },
      async ({ account, owner, repo, state }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const prs = await octokit.pulls.list({ owner: o, repo: r, state, per_page: 30 });
        const lines = prs.data.map((p) => `#${p.number} [${p.state}] ${p.title} (${p.head.ref} → ${p.base.ref})`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No PRs found." }] };
      }
    );

    server.tool(
      "comment_pr",
      "Comments on an existing Pull Request.",
      {
        ...ownerRepoShape,
        pr_number: z.number().int().describe("PR number"),
        body: z.string().describe("Comment text"),
      },
      async ({ account, owner, repo, pr_number, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const comment = await octokit.issues.createComment({ owner: o, repo: r, issue_number: pr_number, body });
        return { content: [{ type: "text", text: `Comment posted on PR #${pr_number}: ${comment.data.html_url}` }] };
      }
    );

    // ---------- ISSUES / BOARD ----------

    server.tool(
      "list_issues",
      "Lists the repository's issues (can represent the board's tasks).",
      {
        ...ownerRepoShape,
        state: z.enum(["open", "closed", "all"]).default("open"),
      },
      async ({ account, owner, repo, state }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const issues = await octokit.issues.listForRepo({ owner: o, repo: r, state, per_page: 30 });
        const lines = issues.data
          .filter((i) => !i.pull_request)
          .map((i) => `#${i.number} [${i.state}] ${i.title}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "No issues found." }] };
      }
    );

    server.tool(
      "get_issue",
      "Brings back an issue's full content: description and every comment, in the order they were posted — to understand the history and reasoning behind it, not just the title.",
      {
        ...ownerRepoShape,
        issue_number: z.number().int().describe("Issue/task number"),
      },
      async ({ account, owner, repo, issue_number }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const issue = await octokit.issues.get({ owner: o, repo: r, issue_number });

        const comments: { user?: { login?: string | null } | null; created_at: string; body?: string | null }[] = [];
        let page = 1;
        while (true) {
          const res = await octokit.issues.listComments({ owner: o, repo: r, issue_number, per_page: 100, page });
          comments.push(...res.data);
          if (res.data.length < 100) break;
          page += 1;
        }

        const header = `#${issue.data.number} [${issue.data.state}] ${issue.data.title}\nAuthor: ${
          issue.data.user?.login ?? "unknown"
        } · Created at: ${issue.data.created_at}`;
        const body = issue.data.body?.trim() ? issue.data.body : "(no description)";
        const commentLines = comments.length
          ? comments
              .map((c) => `— ${c.user?.login ?? "unknown"} (${c.created_at}):\n${c.body ?? ""}`)
              .join("\n\n")
          : "(no comments)";

        const text = `${header}\n\nDescription:\n${body}\n\nComments (${comments.length}):\n${commentLines}`;
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "create_issue",
      "Creates a new issue in the repository.",
      {
        ...ownerRepoShape,
        title: z.string(),
        body: z.string().optional(),
      },
      async ({ account, owner, repo, title, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const issue = await octokit.issues.create({ owner: o, repo: r, title, body });
        return { content: [{ type: "text", text: `Issue #${issue.data.number} created: ${issue.data.html_url}` }] };
      }
    );

    server.tool(
      "comment_issue",
      "Comments on an existing issue — use it to post the final QA report on the original board task.",
      {
        ...ownerRepoShape,
        issue_number: z.number().int().describe("Issue/task number"),
        body: z.string().describe("Comment text (e.g. QA report)"),
      },
      async ({ account, owner, repo, issue_number, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const comment = await octokit.issues.createComment({ owner: o, repo: r, issue_number, body });
        return {
          content: [{ type: "text", text: `Comment posted on issue #${issue_number}: ${comment.data.html_url}` }],
        };
      }
    );

    // ---------- CODE READING ----------

    server.tool(
      "read_file",
      "Reads a repository file's content on a specific branch/ref.",
      {
        ...ownerRepoShape,
        path: z.string(),
        ref: z.string().default("main").describe("Branch, tag or commit SHA"),
      },
      async ({ account, owner, repo, path, ref }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const res = await octokit.repos.getContent({ owner: o, repo: r, path, ref });
        if (Array.isArray(res.data) || !("content" in res.data)) {
          return { content: [{ type: "text", text: `'${path}' is a directory, not a file.` }] };
        }
        const text = Buffer.from(res.data.content, "base64").toString("utf-8");
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "search_code",
      "Searches for code inside the repository.",
      {
        ...ownerRepoShape,
        query: z.string().describe("Search term (GitHub code search syntax)"),
      },
      async ({ account, owner, repo, query }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const res = await octokit.search.code({ q: `${query} repo:${o}/${r}` });
        const lines = res.data.items.map((i) => `${i.path} — ${i.html_url}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Nothing found." }] };
      }
    );

    // ---------- UTILITY ----------

    server.tool(
      "whoami",
      "Shows which GitHub identity/account is being used in this session.",
      {},
      async (_args, extra) => {
        if (extra?.authInfo) {
          const login = extra.authInfo.extra?.githubLogin as string | undefined;
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

    server.tool(
      "link_account",
      "Generates a one-time authorization link to link an ADDITIONAL GitHub account to your current session (multi-account support). Open the returned URL in a browser and approve — once linked, that account's repositories are picked up automatically (by per-repo detection), with no need to call this tool for it again. Only works in OAuth mode (authenticated with a primary account).",
      {},
      async (_args, extra) => {
        if (!extra?.authInfo) {
          throw new Error("link_account only works in OAuth mode, authenticated with a primary account.");
        }
        const primaryLogin = extra.authInfo.extra?.githubLogin as string | undefined;
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

    server.tool(
      "list_accounts",
      "Lists the GitHub accounts linked to your current session: the primary account (authenticated via OAuth) and any additional account linked with 'link_account'. Use it to check which accounts are available for automatic repository detection.",
      {},
      async (_args, extra) => {
        if (!extra?.authInfo) {
          throw new Error("list_accounts only works in OAuth mode, authenticated with a primary account.");
        }
        const primaryLogin = extra.authInfo.extra?.githubLogin as string | undefined;
        if (!primaryLogin) {
          throw new Error("Could not identify your primary account (GitHub login missing from the session).");
        }
        const linked = await getLinkedAccounts(primaryLogin);
        const lines = [
          `${primaryLogin} [primary]`,
          ...linked.map((a) => `${a.login} — linked on ${a.linkedAt}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    server.tool(
      "list_repos_by_account",
      "Lists the repositories accessible by an account linked to your session — the primary one, or an additional one linked with 'link_account'. Useful for checking what each account can see before a call, or for picking the right 'account' when 'resolveRepo' asks because of ambiguity.",
      {
        account: z
          .string()
          .optional()
          .describe(
            "Login of the linked account whose repositories you want to list. If omitted, uses the session's primary account."
          ),
      },
      async ({ account }, extra) => {
        if (!extra?.authInfo) {
          throw new Error("list_repos_by_account only works in OAuth mode, authenticated with a primary account.");
        }
        const { primaryLogin, candidates } = await getOAuthCandidates(extra.authInfo);
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
        while (true) {
          const res = await octokit.repos.listForAuthenticatedUser({ per_page: 100, page, sort: "full_name" });
          repos.push(...res.data.map((r) => `${r.full_name}${r.private ? " (private)" : ""}`));
          if (res.data.length < 100) break;
          page += 1;
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
  },
  {},
  { verboseLogs: true, maxDuration: 60 }
);

async function verifyGithubToken(_req: Request, bearerToken?: string) {
  if (!bearerToken) return undefined;
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${bearerToken}`, "User-Agent": "github-mcp-oauth" },
  });
  if (!res.ok) {
    throw new Error("Invalid or expired GitHub token.");
  }
  const user = await res.json();
  return {
    token: bearerToken,
    clientId: "github-oauth",
    scopes: [],
    extra: { githubLogin: user.login as string },
  };
}

const handler = oauthEnabled() ? withMcpAuth(rawHandler, verifyGithubToken, { required: true }) : rawHandler;

export { handler as GET, handler as POST, handler as DELETE };
