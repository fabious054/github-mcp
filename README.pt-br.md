# GitHub MCP

*[Read in English](./README.md)*

MCP server que dá ao Claude acesso real ao GitHub: criar e apagar branches,
commitar, abrir, editar e comentar PRs, listar, criar, ler e comentar issues,
ler arquivos e buscar código.

## Conectar nesta instância

Já existe uma instância deste servidor rodando — você não precisa configurar
nem fazer deploy de nada pra usar.

1. No Claude, adicione um **custom connector (MCP remoto)** apontando para:
   ```
   https://github-mcp-seven.vercel.app/mcp
   ```
2. O Claude abre uma tela real de "Autorizar" do GitHub. Faça login com a
   sua própria conta do GitHub — sem gerar token manualmente, sem configurar
   nada.
3. Pronto. Toda chamada de ferramenta roda com o seu próprio acesso do
   GitHub — nunca uma conta compartilhada.

Quer usar mais de uma conta do GitHub no mesmo connector (ex: uma conta
pessoal e uma de organização)? Chame a ferramenta `link_account` — ela te
guia pra vincular contas adicionais, e o servidor depois descobre sozinho
qual conta vinculada usar pra cada repositório que você apontar. Veja
[Ferramentas disponíveis](#ferramentas-disponíveis) abaixo.

> Trabalhando na construção/manutenção deste servidor, ou quer rodar sua
> própria instância separada dele? Veja
> [`docs/self-hosting.pt-br.md`](./docs/self-hosting.pt-br.md) pra criar seu
> próprio GitHub OAuth App, variáveis de ambiente e deploy na Vercel.

## Ferramentas disponíveis

- `create_branch` — cria uma branch a partir de outra
- `delete_branch` — apaga uma branch; recusa a branch padrão, branches protegidas e branches com PR aberto
- `commit_file` — cria/atualiza um arquivo com uma mensagem de commit (conteúdo inteiro, um arquivo por chamada)
- `patch_file` — aplica um diff unificado a um arquivo existente numa branch, sem reenviar o conteúdo inteiro
- `get_branch_head` — lê o SHA completo (40 caracteres) do commit que uma branch aponta
- `open_pr` — abre um Pull Request
- `update_pr` — edita título, descrição ou branch de destino de um PR, e fecha ou reabre (nunca faz merge)
- `list_prs` — lista PRs
- `comment_pr` — comenta num PR
- `list_issues` — lista issues (tarefas do board)
- `get_issue` — lê uma issue completa: descrição e todos os comentários, em ordem
- `create_issue` — cria uma issue
- `comment_issue` — comenta numa issue (ex: relatório final de QA)
- `read_file` — lê o conteúdo de um arquivo numa branch (`branch`, ou `ref` pra branch, tag ou commit; padrão `main`)
- `search_code` — busca código no repositório
- `whoami` — mostra qual identidade/conta está sendo usada na sessão atual
- `link_account` — vincula uma conta ADICIONAL do GitHub à sua sessão
- `list_accounts` — lista as contas vinculadas à sua sessão
- `unlink_account` — remove uma conta adicional da sua sessão e revoga o token dela no GitHub (nunca a sua conta primária)
- `list_repos_by_account` — lista os repositórios acessíveis por uma conta vinculada específica
- `create_repo` — cria um repositório vazio pra você ou pra uma organização; a visibilidade (privado ou público) é sempre escolhida por você (não existe ferramenta pra apagar repositório)

### Editando um trecho pequeno de um arquivo grande

`commit_file` sempre exige o conteúdo inteiro do arquivo, mesmo quando só uma
linha mudou. `patch_file` resolve isso pro caso de um arquivo só: recebe um
diff unificado (formato `diff -u` ou `git diff`), busca o conteúdo atual do
arquivo na branch, aplica o patch e commita o resultado — sem nunca precisar
do conteúdo completo do arquivo na chamada.

### Git Data API — commits grandes ou multi-arquivo

Pra mudanças espalhadas por muitos arquivos (não só um), estas ferramentas
expõem o modelo de dados do Git diretamente (blob → tree → commit → ref),
permitindo reaproveitar um blob já existente por SHA (arquivo que não mudou
entre commits nunca precisa ser reenviado) e agrupar vários arquivos num
único commit atômico. Cada entrada de arquivo também aceita `patch` — o
mesmo mecanismo de diff unificado do `patch_file`, mas dentro de um commit
multi-arquivo:

- `create_blob` — cria um blob (conteúdo bruto) e devolve o SHA
- `get_tree` — lê uma tree (lista arquivos e SHAs de blob de um commit/branch; escolha com `branch` ou `tree_sha`, padrão `main`), útil pra descobrir o SHA de um blob já existente e reaproveitá-lo
- `get_branch_head` — lê o SHA completo do commit atual de uma branch, necessário como `parents` de `create_commit` (o GitHub exige o SHA completo, não o abreviado que `commit_file`/`patch_file`/`commit_tree` imprimem na resposta)
- `create_tree` — monta uma nova tree a partir de uma tree base, aplicando entradas que trazem `content` (blob novo), `patch` (diff unificado sobre o conteúdo atual do caminho na tree base) ou `sha` (blob reaproveitado, ou `null` pra remover o caminho)
- `create_commit` — cria um commit a partir de uma tree e commit(s)-pai (`parents` exige SHA completo — use `get_branch_head` pra obtê-lo)
- `update_ref` — aponta uma branch pra um commit específico (não é fast-forward por padrão, a menos que `force: true`)
- `commit_tree` — **ferramenta de conveniência**: orquestra blob → tree → commit → update_ref numa chamada só, recebendo `branch`, `message` e uma lista de `files` (cada um com `content`, `patch` ou `sha`). É o substituto direto de "várias chamadas de `commit_file`, cada uma com o conteúdo inteiro" quando a mudança toca vários arquivos, edita só um trecho de algum deles, ou pode reaproveitar algum já existente.

`commit_file`, `patch_file` e `commit_tree` imprimem o SHA completo do commit
na resposta (além do abreviado) — útil pra encadear com `create_commit` sem
precisar de uma chamada extra a `get_branch_head`.

Todas as ferramentas aceitam `owner`/`repo` opcionais. Se você não informar
`owner`, o servidor tenta usar o seu próprio usuário do GitHub como padrão
(mas o `repo` ainda precisa ser informado).

As ferramentas recusam argumentos que não conhecem: um argumento com nome
errado ou não suportado volta como erro dizendo qual é, em vez de ser
ignorado em silêncio (veja a
[ADR 0008](./docs/adr/0008-strict-tool-arguments.md)).

## Vinculando várias contas à mesma sessão

Uma mesma pessoa pode vincular mais de uma conta do GitHub ao mesmo
conector, através de logins sucessivos — sem precisar adicionar o conector
duas vezes ou gerenciar conexões separadas:

1. Chame a ferramenta `link_account`. Ela devolve um link de autorização de
   uso único (válido por 10 minutos).
2. Abra esse link num navegador e autorize com a conta **diferente** do
   GitHub que você quer adicionar. A conta primária com a qual você já está
   conectado nunca muda.
3. A partir daí, toda ferramenta que aponta pra um repositório escolhe a
   conta certa automaticamente: se só a sua conta primária estiver
   vinculada, nada muda; se mais de uma estiver vinculada, o servidor checa
   o que cada uma pode fazer no repositório-alvo e usa a única conta que
   consegue **escrever** nele. Num repositório em que nenhuma escreve (por
   exemplo, um repo público de outra pessoa), usa a sua conta primária. Só
   pede pra você repetir a chamada com `account` explícito quando mais de
   uma conta consegue escrever no repositório (veja a
   [ADR 0006](./docs/adr/0006-account-selection-by-write-access.md)).
4. `list_accounts` lista todas as contas vinculadas à sua sessão, com o
   estado da autorização de cada conta vinculada, e
   `list_repos_by_account` lista o que uma conta específica acessa — útil
   pra conferir antes de uma chamada, ou pra descobrir qual `account`
   informar quando o erro de ambiguidade acima acontecer.

Se o GitHub deixar de aceitar a autorização de uma conta vinculada (você
revogou, ou o GitHub expirou), o servidor não passa a usar outra conta por
conta própria: as chamadas que dependem da detecção automática param e dizem
qual conta vincular de novo com `link_account`, e o `list_accounts` marca ela
como revogada. Enquanto isso, dá pra informar `account` explicitamente (veja
a [ADR 0007](./docs/adr/0007-revoked-linked-accounts.md)).

Não usa mais uma conta vinculada? O `unlink_account` remove ela da sua sessão
e revoga o token dela no GitHub. Ele só mexe em contas vinculadas à sua
própria conta primária — outras pessoas que vincularam a mesma conta do
GitHub continuam com a delas (veja a
[ADR 0013](./docs/adr/0013-unlink-account.md)).

## Limite de requisições

Todo endpoint público tem limite de requisições (baseado em Redis, veja o
[ADR 0003](./docs/adr/0003-redis-rate-limiting.md)). Ao passar do limite, o
servidor responde `429 Too Many Requests` com o header `Retry-After`.

| Endpoint | Limite | Chave |
|---|---|---|
| `/register`, `/token`, `/authorize` | 20 requisições / 5 min | IP do cliente |
| `/token`, renovação do token (`refresh_token`) | 30 renovações / 5 min | hash do token do GitHub |
| `/link-account`, `/link-callback`, `/callback` | 30 requisições / 5 min | IP do cliente |
| `/mcp` (modo OAuth) | 60 requisições / min (rajadas permitidas) | hash do bearer token |
| `/mcp` (modo legado) | 60 requisições / min (rajadas permitidas) | IP do cliente |
| `/mcp`, tokens inválidos | 20 tokens recusados / 5 min | IP do cliente |

O uso normal fica bem abaixo desses limites. Se o Redis estiver fora do ar,
as requisições passam (fail-open), então uma queda nunca bloqueia o login
nem as chamadas de ferramenta.

Se o próprio GitHub não conseguir validar o seu token por um instante (5xx,
limite de requisições, erro de rede), o `/mcp` responde `503` com
`Retry-After` em vez de `401`, então o Claude tenta de novo e você não
precisa reconectar. Só conta como token inválido o que o GitHub de fato
recusa (veja o [ADR 0004](./docs/adr/0004-transient-github-errors-503.md)).

## Conexão contínua

A conexão continua de pé por mais tempo que você deixe o conector sem uso:
cada token é anunciado com validade de 10 anos (e um refresh token de
reserva), então o Claude nunca considera ele vencido. Você só faz login de
novo se revogar a autorização no GitHub (Settings → Applications) — e isso
vale já na próxima chamada de ferramenta, porque toda chamada é conferida com
o GitHub. Se o GitHub estiver indisponível por um instante durante uma
renovação, ela é tentada de novo em vez de te desconectar (veja o
[ADR 0011](./docs/adr/0011-stateless-refresh-tokens.md) e o
[ADR 0014](./docs/adr/0014-long-token-lifetime.md)).

## Segurança

- Nenhum token é commitado neste repositório.
- O servidor nunca guarda o token da sua conta primária — ele é repassado do
  GitHub pro Claude a cada troca, e revalidado contra a API do GitHub a cada
  chamada de ferramenta.
- `whoami` nunca retorna tokens, só identifica a conta/sessão.
- O token de uma conta vinculada (não-primária) é a única coisa que este
  servidor persiste, e sempre fica guardado criptografado (AES-256-GCM) —
  nunca em texto puro.
- Eventos de autenticação e de limite de requisições são gravados nos logs
  do servidor pra auditoria, sem nenhum token — veja o
  [`SECURITY.pt-br.md`](./SECURITY.pt-br.md#logs-de-auditoria).

Política de segurança completa, modelo de ameaça e como reportar uma
vulnerabilidade: [`SECURITY.pt-br.md`](./SECURITY.pt-br.md).

## Decisões de arquitetura

Decisões de design relevantes ficam registradas como ADRs em
[`docs/adr/`](./docs/adr/) (em inglês):

- [0001 — Git Data API for large commits](./docs/adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./docs/adr/0002-multi-account-oauth-linking.md)
- [0003 — Redis-backed rate limiting](./docs/adr/0003-redis-rate-limiting.md)
- [0004 — Transient GitHub errors answered with 503, not 401](./docs/adr/0004-transient-github-errors-503.md)
- [0005 — Migrate to mcp-handler 2 (MCP SDK v2)](./docs/adr/0005-migrate-to-mcp-handler-2.md)
- [0006 — Pick the linked account by write access](./docs/adr/0006-account-selection-by-write-access.md)
- [0007 — Never pick an account while a linked one is revoked](./docs/adr/0007-revoked-linked-accounts.md)
- [0008 — Reject unknown tool arguments; `branch` in the read tools](./docs/adr/0008-strict-tool-arguments.md)
- [0009 — `update_pr` scope: edit, retarget, close/reopen](./docs/adr/0009-update-pr-scope.md)
- [0010 — `delete_branch` guards: default, protected, open PRs](./docs/adr/0010-delete-branch-guards.md)
- [0011 — Stateless refresh tokens so Claude renews silently](./docs/adr/0011-stateless-refresh-tokens.md)
- [0012 — `create_repo`: account by owner, empty, no default visibility](./docs/adr/0012-create-repo.md)
- [0013 — `unlink_account`: own links only, token revoked](./docs/adr/0013-unlink-account.md)
- [0014 — Access token lifetime: 8 hours → 10 years (never expires in practice)](./docs/adr/0014-long-token-lifetime.md)

## Licença

[MIT](./LICENSE)
