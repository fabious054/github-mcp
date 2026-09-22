import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { Octokit } from "@octokit/rest";
import { applyPatch } from "diff";
import { z } from "zod";
import { oauthEnabled, encryptJson, nowSeconds } from "../../lib/oauth";
import { getServerOrigin } from "../../lib/mongo";
import { getLinkedAccounts } from "../../lib/accounts";

export const runtime = "nodejs";

// ---------- MODO 1: OAuth do GitHub (multi-usuário) ----------
//
// Se GITHUB_OAUTH_CLIENT_ID/SECRET estiverem configurados, cada pessoa que
// conecta este MCP no Claude passa por um login real do GitHub (ver
// /authorize, /callback, /token) e as ferramentas usam o token de acesso
// DELA — nunca um token fixo compartilhado. Isso é o que permite "qualquer
// um conectar sua própria conta".
//
// ---------- MODO 2: conta(s) fixa(s) via variável de ambiente (legado) ----------
//
// Se OAuth não estiver configurado, cai no modo antigo: GITHUB_TOKEN (uma
// conta) ou GITHUB_ACCOUNTS (JSON com várias contas pré-configuradas). Útil
// pra uso 100% pessoal, sem precisar montar o fluxo de OAuth.

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
      throw new Error("GITHUB_ACCOUNTS não é um JSON válido. Confira a variável de ambiente na Vercel.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("GITHUB_ACCOUNTS deve ser um objeto JSON (mapa de nome da conta → configuração).");
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
      "Nenhuma conta do GitHub configurada. Defina GITHUB_OAUTH_CLIENT_ID/SECRET (login por usuário) ou GITHUB_ACCOUNTS/GITHUB_TOKEN (conta fixa) nas variáveis de ambiente."
    );
  }

  if (accountName) {
    const config = accounts[accountName];
    if (!config) throw new Error(`Conta '${accountName}' não encontrada. Contas configuradas: ${keys.join(", ")}.`);
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
    if (!config) throw new Error(`DEFAULT_ACCOUNT='${DEFAULT_ACCOUNT}' não corresponde a nenhuma conta em GITHUB_ACCOUNTS.`);
    return { name: DEFAULT_ACCOUNT, config };
  }

  if (keys.length === 1) return { name: keys[0], config: accounts[keys[0]] };

  throw new Error(
    `Múltiplas contas configuradas (${keys.join(", ")}) e nenhuma foi especificada nem inferida pelo 'owner'. Informe 'account', ou defina DEFAULT_ACCOUNT.`
  );
}

type ResolvedRepo = { owner: string; repo: string; octokit: Octokit; accountName: string };

type OAuthCandidate = { login: string; token: string };

// Monta a lista de contas candidatas da sessão OAuth atual: a conta
// primária (autenticada) + qualquer conta adicional vinculada com
// 'link_account'. Reaproveitado por 'resolveRepo' e por 'list_repos_by_account'.
async function getOAuthCandidates(
  authInfo: { token: string; extra?: Record<string, unknown> }
): Promise<{ primaryLogin: string | undefined; candidates: OAuthCandidate[] }> {
  const primaryLogin =
    typeof authInfo.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
  const candidates: OAuthCandidate[] = [{ login: primaryLogin ?? "primária", token: authInfo.token }];
  if (primaryLogin) {
    const linked = await getLinkedAccounts(primaryLogin);
    candidates.push(...linked.map((a) => ({ login: a.login, token: a.token })));
  }
  return { primaryLogin, candidates };
}

// Verifica se um token do GitHub tem acesso de leitura a um repositório
// específico — usado pra detecção automática de conta quando há mais de
// uma vinculada à sessão.
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
        `owner/repo não informados.${primaryLogin ? ` Seu usuário do GitHub é '${primaryLogin}' — informe também o repo.` : " Informe 'owner' e 'repo'."}`
      );
    }

    // Conta informada explicitamente: usa direto (a pessoa já escolheu),
    // sem checar acesso via API.
    if (accountName) {
      const match = candidates.find((c) => c.login.toLowerCase() === accountName.toLowerCase());
      if (!match) {
        throw new Error(
          `Conta '${accountName}' não está vinculada à sua sessão. Contas disponíveis: ${candidates
            .map((c) => c.login)
            .join(", ")}. Use 'link_account' pra vincular uma nova.`
        );
      }
      return { owner: o, repo: r, octokit: new Octokit({ auth: match.token }), accountName: match.login };
    }

    // Só uma conta na sessão (fluxo de sempre, sem contas adicionais
    // vinculadas): usa ela direto, sem chamada extra à API do GitHub.
    if (candidates.length === 1) {
      return {
        owner: o,
        repo: r,
        octokit: new Octokit({ auth: candidates[0].token }),
        accountName: candidates[0].login,
      };
    }

    // Múltiplas contas vinculadas e nenhuma informada: detecta
    // automaticamente checando qual(is) tem acesso ao repositório-alvo.
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
        `Nenhuma das suas contas vinculadas tem acesso a '${o}/${r}'. Contas disponíveis: ${candidates
          .map((c) => c.login)
          .join(", ")}. Vincule a conta certa com 'link_account', ou confira o nome do repositório.`
      );
    }
    throw new Error(
      `Mais de uma conta vinculada tem acesso a '${o}/${r}' (${withAccess
        .map((c) => c.login)
        .join(", ")}). Repita a chamada informando 'account' com a conta desejada.`
    );
  }

  const { name, config } = resolveStaticAccount(accountName, owner);
  const o = owner || config.defaultOwner;
  const r = repo || config.defaultRepo;
  if (!o || !r) {
    throw new Error(`owner/repo não informados e a conta '${name}' não tem defaultOwner/defaultRepo configurado.`);
  }
  return { owner: o, repo: r, octokit: new Octokit({ auth: config.token }), accountName: name };
}

const ownerRepoShape = {
  account: z
    .string()
    .optional()
    .describe(
      "Login da conta do GitHub a usar para esta chamada. No modo sem OAuth, é o nome da conta pré-configurada. No modo OAuth, é opcional: por padrão o servidor detecta sozinho, entre a conta primária e as vinculadas com 'link_account', qual tem acesso ao repositório informado — só é preciso informar 'account' se mais de uma tiver acesso ao mesmo repositório (a chamada retorna erro pedindo isso quando for o caso)."
    ),
  owner: z
    .string()
    .optional()
    .describe("Dono do repositório (usuário ou organização). Opcional se houver um padrão configurado."),
  repo: z.string().optional().describe("Nome do repositório. Opcional se houver um padrão configurado."),
};

// Aplica um diff unificado (formato 'diff -u' / 'git diff') a um texto. Usado
// tanto por 'patch_file' quanto pelas entradas com 'patch' em
// 'create_tree'/'commit_tree'.
function applyUnifiedPatch(original: string, patchText: string): string {
  const result = applyPatch(original, patchText);
  if (result === false) {
    throw new Error(
      "Não foi possível aplicar o patch — o conteúdo atual do arquivo provavelmente mudou desde que o diff foi gerado. Busque o conteúdo atual (read_file ou get_tree) e gere o patch de novo a partir dele."
    );
  }
  return result;
}

const rawHandler = createMcpHandler(
  (server) => {
    // ---------- GIT BÁSICO ----------

    server.tool(
      "create_branch",
      "Cria uma nova branch a partir de outra branch existente (padrão: main).",
      {
        ...ownerRepoShape,
        branch_name: z.string().describe("Nome da nova branch, ex: fix/146-descricao"),
        from_branch: z.string().default("main").describe("Branch base para criar a nova a partir dela"),
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
              text: `Branch '${branch_name}' criada a partir de '${from_branch}' em ${o}/${r} (SHA completo: ${base.data.object.sha}).`,
            },
          ],
        };
      }
    );

    server.tool(
      "get_branch_head",
      "Lê o SHA completo (40 caracteres) do commit que uma branch aponta atualmente. Use isso pra obter o SHA de entrada de 'parents' em 'create_commit', já que outras ferramentas (commit_file, patch_file, commit_tree) só imprimem um SHA abreviado no texto de resposta.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Nome da branch, ex: main"),
      },
      async ({ account, owner, repo, branch }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const ref = await octokit.git.getRef({ owner: o, repo: r, ref: `heads/${branch}` });
        return {
          content: [{ type: "text", text: `Branch '${branch}' aponta pro commit ${ref.data.object.sha}` }],
        };
      }
    );

    server.tool(
      "commit_file",
      "Cria ou atualiza um arquivo diretamente numa branch, com uma mensagem de commit (conventional commits).",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch onde o commit será feito"),
        path: z.string().describe("Caminho do arquivo no repositório, ex: src/handlers/foo.js"),
        content: z.string().describe("Conteúdo completo do arquivo (texto puro, será codificado em base64)"),
        message: z.string().describe("Mensagem de commit seguindo conventional commits (feat:, fix:, chore:, etc.)"),
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
              text: `Commit '${commitSha?.slice(0, 7)}' (SHA completo: ${commitSha}) criado em '${branch}': ${message}`,
            },
          ],
        };
      }
    );

    server.tool(
      "patch_file",
      "Aplica um diff unificado (formato 'diff -u' ou 'git diff') a um arquivo existente numa branch, sem precisar reenviar o conteúdo inteiro — ideal pra editar um trecho pequeno dentro de um arquivo grande. Busca o conteúdo atual do arquivo na branch, aplica o patch, e commita só o resultado.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch onde o commit será feito"),
        path: z.string().describe("Caminho do arquivo a corrigir, ex: src/handlers/foo.js"),
        patch: z
          .string()
          .describe("Diff unificado (formato 'diff -u' ou 'git diff') a aplicar sobre o conteúdo atual deste arquivo"),
        message: z.string().describe("Mensagem de commit seguindo conventional commits (feat:, fix:, chore:, etc.)"),
      },
      async ({ account, owner, repo, branch, path, patch, message }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);

        const existing = await octokit.repos.getContent({ owner: o, repo: r, path, ref: branch });
        if (Array.isArray(existing.data) || !("content" in existing.data)) {
          throw new Error(`'${path}' não é um arquivo (ou não existe) em '${branch}'.`);
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
              text: `Commit '${commitSha?.slice(0, 7)}' (SHA completo: ${commitSha}) criado em '${branch}' (patch aplicado em '${path}'): ${message}`,
            },
          ],
        };
      }
    );

    // ---------- GIT DATA API (blobs/trees/commits) ----------
    //
    // Pensado pra commits grandes ou multi-arquivo: em vez de reenviar o
    // conteúdo inteiro de cada arquivo em `commit_file`, um blob pode ser
    // criado uma única vez e reaproveitado por SHA (arquivo que não mudou
    // entre commits nunca precisa ser reenviado), e uma árvore com várias
    // entradas vira um único commit atômico. Todas essas operações são
    // stateless — cada chamada é uma requisição isolada à API do GitHub, o
    // que funciona bem com o deploy serverless na Vercel (sem filesystem ou
    // estado compartilhado entre invocações).
    //
    // Cada entrada de tree também aceita 'patch' (diff unificado aplicado
    // sobre o conteúdo atual daquele caminho na tree base) — pra editar um
    // trecho pequeno de um arquivo grande dentro de um commit multi-arquivo,
    // sem reenviar o conteúdo inteiro dele nem tratá-lo à parte.

    server.tool(
      "create_blob",
      "Cria um blob (objeto de conteúdo bruto do Git) e devolve o SHA dele. Use pra criar o conteúdo de um arquivo antes de referenciá-lo numa tree (via 'create_tree' ou 'commit_tree'), ou pra obter o SHA de um conteúdo específico.",
      {
        ...ownerRepoShape,
        content: z.string().describe("Conteúdo do blob"),
        encoding: z
          .enum(["utf-8", "base64"])
          .default("utf-8")
          .describe("Codificação de 'content' — use 'base64' para arquivos binários"),
      },
      async ({ account, owner, repo, content, encoding }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const blob = await octokit.git.createBlob({ owner: o, repo: r, content, encoding });
        return { content: [{ type: "text", text: `Blob criado: ${blob.data.sha}` }] };
      }
    );

    server.tool(
      "get_tree",
      "Lê uma tree (árvore de arquivos) do Git — lista caminhos e SHAs de blob de um commit/branch/tree. Use pra descobrir o SHA de um blob já existente no repositório (e assim reaproveitá-lo sem reenviar conteúdo) antes de montar uma tree nova.",
      {
        ...ownerRepoShape,
        tree_sha: z
          .string()
          .default("main")
          .describe("SHA da tree, ou um branch/tag/commit — a tree associada é resolvida automaticamente"),
        recursive: z.boolean().default(false).describe("Se true, lista recursivamente todas as subpastas"),
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
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Tree vazia." }] };
      }
    );

    const treeEntryShape = z.object({
      path: z.string().describe("Caminho do arquivo, ex: src/handlers/foo.js"),
      mode: z
        .enum(["100644", "100755", "040000", "160000", "120000"])
        .default("100644")
        .describe(
          "Modo do arquivo: 100644 (normal), 100755 (executável), 040000 (subdiretório), 160000 (submódulo), 120000 (symlink)"
        ),
      content: z.string().optional().describe("Conteúdo completo do arquivo (cria um blob novo). Use pra arquivo novo ou reescrita total."),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8").describe("Codificação de 'content', quando informado"),
      patch: z
        .string()
        .optional()
        .describe(
          "Diff unificado a aplicar sobre o conteúdo atual deste caminho na tree base — pra editar um trecho pequeno sem reenviar o arquivo inteiro. Exige que o caminho já exista na tree base."
        ),
      sha: z
        .union([z.string(), z.null()])
        .optional()
        .describe(
          "SHA de um blob já existente pra reaproveitar sem reenviar conteúdo, ou null para remover este caminho"
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
            throw new Error("Entradas com 'patch' exigem 'base_tree' (em 'create_tree') — 'commit_tree' já resolve isso sozinho a partir da branch.");
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
            throw new Error(`Entrada '${e.path}': informe apenas um de 'content', 'sha' ou 'patch'.`);
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
                `Entrada '${e.path}': caminho não encontrado na tree base pra aplicar o patch (arquivo novo? use 'content' em vez de 'patch').`
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
      "Monta uma nova tree a partir de uma tree base, aplicando as entradas informadas. Cada entrada pode trazer 'content' (cria um blob novo), 'patch' (aplica um diff unificado sobre o conteúdo atual do caminho na tree base — pra editar um trecho pequeno sem reenviar o arquivo inteiro) ou 'sha' (reaproveita um blob já existente, sem reenviar conteúdo). 'sha: null' remove o caminho da tree.",
      {
        ...ownerRepoShape,
        base_tree: z
          .string()
          .optional()
          .describe(
            "SHA da tree base (normalmente a tree do commit atual da branch). Se omitido, monta uma tree do zero — nesse caso, entradas com 'patch' não são possíveis."
          ),
        entries: z.array(treeEntryShape).min(1).describe("Lista de arquivos a criar/atualizar/remover nesta tree"),
      },
      async ({ account, owner, repo, base_tree, entries }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const resolvedEntries = await resolveTreeEntries(octokit, o, r, entries, base_tree);
        const tree = await octokit.git.createTree({ owner: o, repo: r, base_tree, tree: resolvedEntries as any });
        return {
          content: [{ type: "text", text: `Tree criada: ${tree.data.sha} (${resolvedEntries.length} entrada(s))` }],
        };
      }
    );

    server.tool(
      "create_commit",
      "Cria um objeto de commit apontando pra uma tree e um ou mais commits-pai. Não move nenhuma branch sozinho — use 'update_ref' depois pra apontar a branch pro novo commit. 'parents' exige o SHA completo (40 caracteres) — use 'get_branch_head' pra obter o SHA completo do commit atual de uma branch.",
      {
        ...ownerRepoShape,
        tree: z.string().describe("SHA da tree deste commit (de 'create_tree')"),
        parents: z.array(z.string()).min(1).describe("SHA(s) completo(s) do(s) commit(s) pai — normalmente o commit atual da branch, obtido via 'get_branch_head'"),
        message: z.string().describe("Mensagem de commit seguindo conventional commits (feat:, fix:, chore:, etc.)"),
      },
      async ({ account, owner, repo, tree, parents, message }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const commit = await octokit.git.createCommit({ owner: o, repo: r, tree, parents, message });
        return { content: [{ type: "text", text: `Commit criado: ${commit.data.sha} — ${message}` }] };
      }
    );

    server.tool(
      "update_ref",
      "Aponta uma branch pra um commit específico. Por padrão recusa mover a branch se não for um fast-forward (evita sobrescrever trabalho concorrente) — use 'force: true' só quando tiver certeza.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Nome da branch a mover, ex: feat/146-descricao"),
        sha: z.string().describe("SHA do commit pro qual a branch deve apontar"),
        force: z.boolean().default(false).describe("Se true, força o update mesmo que não seja um fast-forward"),
      },
      async ({ account, owner, repo, branch, sha, force }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        await octokit.git.updateRef({ owner: o, repo: r, ref: `heads/${branch}`, sha, force });
        return { content: [{ type: "text", text: `Branch '${branch}' agora aponta pra ${sha}.` }] };
      }
    );

    server.tool(
      "commit_tree",
      "Cria um commit atômico com vários arquivos de uma vez, orquestrando blob → tree → commit → update_ref numa chamada só. Cada arquivo pode trazer 'content' (cria um blob novo), 'patch' (aplica um diff unificado sobre o conteúdo atual do arquivo na branch — pra editar um trecho pequeno sem reenviar o arquivo inteiro), 'sha' (reaproveita um blob já existente — pra arquivo que não mudou entre commits, sem reenviar conteúdo nenhum) ou 'sha: null' (remove o arquivo). Ideal pra mudanças grandes ou espalhadas por muitos arquivos, onde 'commit_file' exigiria uma chamada por arquivo com o conteúdo inteiro toda vez.",
      {
        ...ownerRepoShape,
        branch: z.string().describe("Branch onde o commit será feito"),
        message: z.string().describe("Mensagem de commit seguindo conventional commits (feat:, fix:, chore:, etc.)"),
        files: z.array(treeEntryShape).min(1).describe("Arquivos a criar/atualizar/remover neste commit"),
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
              text: `Commit '${commit.data.sha.slice(0, 7)}' (SHA completo: ${commit.data.sha}) criado em '${branch}' com ${resolvedEntries.length} arquivo(s): ${message}`,
            },
          ],
        };
      }
    );

    // ---------- PULL REQUESTS ----------

    server.tool(
      "open_pr",
      "Abre um Pull Request de uma branch para outra.",
      {
        ...ownerRepoShape,
        head: z.string().describe("Branch de origem (com as mudanças)"),
        base: z.string().default("main").describe("Branch de destino"),
        title: z.string().describe("Título do PR"),
        body: z.string().optional().describe("Descrição do PR"),
      },
      async ({ account, owner, repo, head, base, title, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const pr = await octokit.pulls.create({ owner: o, repo: r, head, base, title, body });
        return { content: [{ type: "text", text: `PR #${pr.data.number} aberto: ${pr.data.html_url}` }] };
      }
    );

    server.tool(
      "list_prs",
      "Lista Pull Requests do repositório.",
      {
        ...ownerRepoShape,
        state: z.enum(["open", "closed", "all"]).default("open"),
      },
      async ({ account, owner, repo, state }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const prs = await octokit.pulls.list({ owner: o, repo: r, state, per_page: 30 });
        const lines = prs.data.map((p) => `#${p.number} [${p.state}] ${p.title} (${p.head.ref} → ${p.base.ref})`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Nenhum PR encontrado." }] };
      }
    );

    server.tool(
      "comment_pr",
      "Comenta em um Pull Request existente.",
      {
        ...ownerRepoShape,
        pr_number: z.number().int().describe("Número do PR"),
        body: z.string().describe("Texto do comentário"),
      },
      async ({ account, owner, repo, pr_number, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const comment = await octokit.issues.createComment({ owner: o, repo: r, issue_number: pr_number, body });
        return { content: [{ type: "text", text: `Comentário postado no PR #${pr_number}: ${comment.data.html_url}` }] };
      }
    );

    // ---------- ISSUES / BOARD ----------

    server.tool(
      "list_issues",
      "Lista issues do repositório (pode representar as tarefas do board).",
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
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Nenhuma issue encontrada." }] };
      }
    );

    server.tool(
      "get_issue",
      "Traz o conteúdo completo de uma issue: descrição e todos os comentários, na ordem em que foram postados — pra entender o histórico e o raciocínio por trás dela, não só o título.",
      {
        ...ownerRepoShape,
        issue_number: z.number().int().describe("Número da issue/tarefa"),
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

        const header = `#${issue.data.number} [${issue.data.state}] ${issue.data.title}\nAutor: ${
          issue.data.user?.login ?? "desconhecido"
        } · Criada em: ${issue.data.created_at}`;
        const body = issue.data.body?.trim() ? issue.data.body : "(sem descrição)";
        const commentLines = comments.length
          ? comments
              .map((c) => `— ${c.user?.login ?? "desconhecido"} (${c.created_at}):\n${c.body ?? ""}`)
              .join("\n\n")
          : "(sem comentários)";

        const text = `${header}\n\nDescrição:\n${body}\n\nComentários (${comments.length}):\n${commentLines}`;
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "create_issue",
      "Cria uma nova issue no repositório.",
      {
        ...ownerRepoShape,
        title: z.string(),
        body: z.string().optional(),
      },
      async ({ account, owner, repo, title, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const issue = await octokit.issues.create({ owner: o, repo: r, title, body });
        return { content: [{ type: "text", text: `Issue #${issue.data.number} criada: ${issue.data.html_url}` }] };
      }
    );

    server.tool(
      "comment_issue",
      "Comenta em uma issue existente — use para postar o relatório final de QA na tarefa original do board.",
      {
        ...ownerRepoShape,
        issue_number: z.number().int().describe("Número da issue/tarefa"),
        body: z.string().describe("Texto do comentário (ex: relatório de QA)"),
      },
      async ({ account, owner, repo, issue_number, body }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const comment = await octokit.issues.createComment({ owner: o, repo: r, issue_number, body });
        return {
          content: [{ type: "text", text: `Comentário postado na issue #${issue_number}: ${comment.data.html_url}` }],
        };
      }
    );

    // ---------- LEITURA DE CÓDIGO ----------

    server.tool(
      "read_file",
      "Lê o conteúdo de um arquivo do repositório numa branch/ref específica.",
      {
        ...ownerRepoShape,
        path: z.string(),
        ref: z.string().default("main").describe("Branch, tag ou commit SHA"),
      },
      async ({ account, owner, repo, path, ref }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const res = await octokit.repos.getContent({ owner: o, repo: r, path, ref });
        if (Array.isArray(res.data) || !("content" in res.data)) {
          return { content: [{ type: "text", text: `'${path}' é um diretório, não um arquivo.` }] };
        }
        const text = Buffer.from(res.data.content, "base64").toString("utf-8");
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "search_code",
      "Busca por código dentro do repositório.",
      {
        ...ownerRepoShape,
        query: z.string().describe("Termo de busca (sintaxe de busca de código do GitHub)"),
      },
      async ({ account, owner, repo, query }, extra) => {
        const { owner: o, repo: r, octokit } = await resolveRepo(extra?.authInfo, account, owner, repo);
        const res = await octokit.search.code({ q: `${query} repo:${o}/${r}` });
        const lines = res.data.items.map((i) => `${i.path} — ${i.html_url}`);
        return { content: [{ type: "text", text: lines.length ? lines.join("\n") : "Nada encontrado." }] };
      }
    );

    // ---------- UTILITÁRIO ----------

    server.tool(
      "whoami",
      "Mostra qual identidade/conta do GitHub está sendo usada nesta sessão.",
      {},
      async (_args, extra) => {
        if (extra?.authInfo) {
          const login = extra.authInfo.extra?.githubLogin as string | undefined;
          return {
            content: [
              {
                type: "text",
                text: login
                  ? `Autenticado via OAuth como '${login}'.`
                  : "Autenticado via OAuth (não foi possível ler o login do GitHub).",
              },
            ],
          };
        }
        const accounts = getStaticAccounts();
        const keys = Object.keys(accounts);
        if (keys.length === 0) return { content: [{ type: "text", text: "Nenhuma conta configurada." }] };
        const lines = keys.map((k) => {
          const acc = accounts[k];
          const owners = acc.owners?.length ? acc.owners.join(", ") : acc.defaultOwner ?? "(sem padrão)";
          const repo = acc.defaultRepo ? ` · repo padrão: ${acc.defaultRepo}` : "";
          const isDefault = k === DEFAULT_ACCOUNT || (keys.length === 1 && !DEFAULT_ACCOUNT) ? " [padrão]" : "";
          return `${k}${isDefault} — owners: ${owners}${repo}`;
        });
        return { content: [{ type: "text", text: `Modo de conta fixa (sem OAuth).\n${lines.join("\n")}` }] };
      }
    );

    server.tool(
      "link_account",
      "Gera um link de autorização único pra vincular uma conta ADICIONAL do GitHub à sua sessão atual (suporte a múltiplas contas). Abra a URL devolvida num navegador e aprove — uma vez vinculada, os repositórios dessa conta passam a ser usados automaticamente (detecção por repositório), sem precisar chamar essa ferramenta de novo pra ela. Só funciona no modo OAuth (autenticado com uma conta primária).",
      {},
      async (_args, extra) => {
        if (!extra?.authInfo) {
          throw new Error("link_account só funciona no modo OAuth, autenticado com uma conta primária.");
        }
        const primaryLogin = extra.authInfo.extra?.githubLogin as string | undefined;
        if (!primaryLogin) {
          throw new Error("Não foi possível identificar sua conta primária (login do GitHub ausente na sessão).");
        }
        const origin = getServerOrigin();
        const state = encryptJson({ primaryLogin, iat: nowSeconds() });
        const url = `${origin}/link-account?state=${state}`;
        return {
          content: [
            {
              type: "text",
              text: `Abra este link num navegador e autorize com a conta do GitHub que você quer adicionar (válido por 10 minutos):\n${url}`,
            },
          ],
        };
      }
    );

    server.tool(
      "list_accounts",
      "Lista as contas do GitHub vinculadas à sua sessão atual: a conta primária (autenticada via OAuth) e qualquer conta adicional vinculada com 'link_account'. Use pra conferir quais contas estão disponíveis pra detecção automática de repositório.",
      {},
      async (_args, extra) => {
        if (!extra?.authInfo) {
          throw new Error("list_accounts só funciona no modo OAuth, autenticado com uma conta primária.");
        }
        const primaryLogin = extra.authInfo.extra?.githubLogin as string | undefined;
        if (!primaryLogin) {
          throw new Error("Não foi possível identificar sua conta primária (login do GitHub ausente na sessão).");
        }
        const linked = await getLinkedAccounts(primaryLogin);
        const lines = [
          `${primaryLogin} [primária]`,
          ...linked.map((a) => `${a.login} — vinculada em ${a.linkedAt}`),
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    server.tool(
      "list_repos_by_account",
      "Lista os repositórios acessíveis por uma conta vinculada à sua sessão — a primária, ou uma adicional vinculada com 'link_account'. Útil pra conferir o que cada conta enxerga antes de uma chamada, ou pra escolher o 'account' certo quando 'resolveRepo' pedir por causa de ambiguidade.",
      {
        account: z
          .string()
          .optional()
          .describe(
            "Login da conta vinculada cujos repositórios você quer listar. Se omitido, usa a conta primária da sessão."
          ),
      },
      async ({ account }, extra) => {
        if (!extra?.authInfo) {
          throw new Error("list_repos_by_account só funciona no modo OAuth, autenticado com uma conta primária.");
        }
        const { primaryLogin, candidates } = await getOAuthCandidates(extra.authInfo);
        if (!primaryLogin) {
          throw new Error("Não foi possível identificar sua conta primária (login do GitHub ausente na sessão).");
        }
        const target = account
          ? candidates.find((c) => c.login.toLowerCase() === account.toLowerCase())
          : candidates[0];
        if (!target) {
          throw new Error(
            `Conta '${account}' não está vinculada à sua sessão. Contas disponíveis: ${candidates
              .map((c) => c.login)
              .join(", ")}. Use 'link_account' pra vincular uma nova.`
          );
        }

        const octokit = new Octokit({ auth: target.token });
        const repos: string[] = [];
        let page = 1;
        while (true) {
          const res = await octokit.repos.listForAuthenticatedUser({ per_page: 100, page, sort: "full_name" });
          repos.push(...res.data.map((r) => `${r.full_name}${r.private ? " (privado)" : ""}`));
          if (res.data.length < 100) break;
          page += 1;
        }

        return {
          content: [
            {
              type: "text",
              text: `Repositórios acessíveis por '${target.login}' (${repos.length}):\n${
                repos.length ? repos.join("\n") : "(nenhum)"
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
    throw new Error("Token do GitHub inválido ou expirado.");
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
