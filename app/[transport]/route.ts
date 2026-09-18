import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { oauthEnabled } from "../../lib/oauth";

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

function resolveRepo(
  authInfo: { token: string; extra?: Record<string, unknown> } | undefined,
  accountName: string | undefined,
  owner: string | undefined,
  repo: string | undefined
): ResolvedRepo {
  if (authInfo) {
    const githubLogin =
      typeof authInfo.extra?.githubLogin === "string" ? (authInfo.extra.githubLogin as string) : undefined;
    const o = owner || process.env.DEFAULT_OWNER || githubLogin;
    const r = repo || process.env.DEFAULT_REPO;
    if (!o || !r) {
      throw new Error(
        `owner/repo não informados.${githubLogin ? ` Seu usuário do GitHub é '${githubLogin}' — informe também o repo.` : " Informe 'owner' e 'repo'."}`
      );
    }
    return { owner: o, repo: r, octokit: new Octokit({ auth: authInfo.token }), accountName: githubLogin ?? "oauth" };
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
      "Nome da conta pré-configurada a usar (só relevante no modo sem OAuth). Ignorado quando o acesso é via login do GitHub."
    ),
  owner: z
    .string()
    .optional()
    .describe("Dono do repositório (usuário ou organização). Opcional se houver um padrão configurado."),
  repo: z.string().optional().describe("Nome do repositório. Opcional se houver um padrão configurado."),
};

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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
        const base = await octokit.git.getRef({ owner: o, repo: r, ref: `heads/${from_branch}` });
        await octokit.git.createRef({
          owner: o,
          repo: r,
          ref: `refs/heads/${branch_name}`,
          sha: base.data.object.sha,
        });
        return {
          content: [
            { type: "text", text: `Branch '${branch_name}' criada a partir de '${from_branch}' em ${o}/${r}.` },
          ],
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);

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

        return {
          content: [
            {
              type: "text",
              text: `Commit '${result.data.commit.sha?.slice(0, 7)}' criado em '${branch}': ${message}`,
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
        const { owner: o, repo: r, octokit } = resolveRepo(extra?.authInfo, account, owner, repo);
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
