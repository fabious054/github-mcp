# GitHub MCP

MCP server que dá ao Claude acesso real ao GitHub: criar branch, commitar,
abrir/comentar PRs, listar/criar/comentar issues, ler arquivos e buscar código.

Suporta dois jeitos de conectar contas:

- **OAuth (recomendado)** — qualquer pessoa que adicionar este connector no
  Claude faz login com a própria conta do GitHub, na hora, sem precisar gerar
  token manualmente. Cada um usa a própria conta, dinamicamente — é o modo
  "multi-usuário" de verdade.
- **Conta(s) fixa(s) via variável de ambiente (legado)** — mais simples de
  configurar, mas o(s) token(s) ficam fixos na Vercel e só quem você
  configurou tem acesso.

O mesmo deploy funciona nos dois modos — qual vale depende só de quais
variáveis de ambiente você define (ver abaixo). Se `GITHUB_OAUTH_CLIENT_ID`
estiver definido, o OAuth tem prioridade.

## Ferramentas disponíveis

- `create_branch` — cria uma branch a partir de outra
- `commit_file` — cria/atualiza um arquivo com uma mensagem de commit (conteúdo inteiro, um arquivo por chamada)
- `open_pr` — abre um Pull Request
- `list_prs` — lista PRs
- `comment_pr` — comenta num PR
- `list_issues` — lista issues (tarefas do board)
- `create_issue` — cria uma issue
- `comment_issue` — comenta numa issue (ex: relatório final de QA)
- `read_file` — lê o conteúdo de um arquivo
- `search_code` — busca código no repositório
- `whoami` — mostra qual identidade/conta está sendo usada na sessão atual

### Git Data API — commits grandes ou multi-arquivo

Pra mudanças grandes ou espalhadas por muitos arquivos, `commit_file` obriga
reenviar o conteúdo inteiro de cada arquivo, um por chamada. Essas ferramentas
expõem o modelo de dados do Git diretamente (blob → tree → commit → ref),
permitindo reaproveitar um blob já existente por SHA (arquivo que não mudou
entre commits nunca precisa ser reenviado) e agrupar vários arquivos num
único commit atômico:

- `create_blob` — cria um blob (conteúdo bruto) e devolve o SHA
- `get_tree` — lê uma tree (lista arquivos e SHAs de blob de um commit/branch), útil pra descobrir o SHA de um blob já existente e reaproveitá-lo
- `create_tree` — monta uma nova tree a partir de uma tree base, aplicando entradas que trazem `content` (blob novo) ou `sha` (blob reaproveitado) ou `sha: null` (remove o caminho)
- `create_commit` — cria um commit a partir de uma tree e commit(s)-pai
- `update_ref` — aponta uma branch pra um commit específico (não é fast-forward por padrão, a menos que `force: true`)
- `commit_tree` — **ferramenta de conveniência**: orquestra blob → tree → commit → update_ref numa chamada só, recebendo `branch`, `message` e uma lista de `files` (cada um com `content` ou `sha`). É o substituto direto de "várias chamadas de `commit_file`, cada uma com o conteúdo inteiro" quando a mudança toca vários arquivos ou pode reaproveitar algum já existente.

Todas essas operações são stateless — cada uma é uma chamada isolada à API do
GitHub, sem precisar guardar nada entre invocações, o que combina bem com o
deploy serverless na Vercel.

Todas aceitam `owner`/`repo` opcionais. No modo OAuth, se você não informar
`owner`, o servidor tenta usar o seu próprio usuário do GitHub como padrão
(mas o `repo` ainda precisa ser informado, a menos que `DEFAULT_REPO` esteja
configurado). No modo legado, `account`/`owner`/`repo` seguem as regras de
`DEFAULT_ACCOUNT`/`DEFAULT_OWNER`/`DEFAULT_REPO` descritas abaixo.

## Modo OAuth — como funciona

1. Você cria **um** GitHub OAuth App (github.com → Settings → Developer
   settings → OAuth Apps → New OAuth App), com:
   - Homepage URL: a URL do seu projeto na Vercel.
   - Authorization callback URL: `https://<seu-projeto>.vercel.app/callback`
     (tem que ser essa exata — é fixa, então some depois de saber a URL final
     da Vercel).
2. Na Vercel, configure `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`
   e `OAUTH_ENCRYPTION_KEY` (gerada com `openssl rand -base64 32`).
3. Cada pessoa que adiciona este MCP como custom connector no Claude é levada
   pra uma tela real de "Autorizar `<seu OAuth App>`" no GitHub. Ao aprovar,
   o Claude passa a chamar as ferramentas usando o token dessa pessoa — nunca
   um token compartilhado.
4. `whoami` confirma, a qualquer momento, qual conta está autenticada na
   sessão.

Se o repositório-alvo pertence a uma organização (ex: `robozz-br`), a
organização pode exigir aprovar o OAuth App explicitamente pra acesso a repos
privados dela (Settings da organização → Third-party access).

### Como o OAuth é implementado (sem banco de dados)

Este servidor roda em funções sem estado na Vercel, então em vez de guardar
sessões/códigos num banco, tudo o que o fluxo de OAuth precisa lembrar viaja
**criptografado (AES-256-GCM)** dentro dos próprios parâmetros — o `client_id`
devolvido em `/register`, o `state` usado com o GitHub, e o `code` trocado em
`/token`. Só quem tem a `OAUTH_ENCRYPTION_KEY` consegue gerar ou ler esses
blobs.

Limitação conhecida: como não há banco, um `code` de autorização não é
invalidado após o primeiro uso — ele simplesmente expira sozinho (2 minutos).
Isso é aceitável pra este caso de uso (o código só existe dentro de um
redirect HTTPS entre o GitHub e o Claude), mas é uma diferença em relação a
um Authorization Server "completo" com armazenamento — vale saber.

O token que o Claude recebe **é o próprio token de acesso do GitHub** da
pessoa — o servidor nunca guarda nem loga esse token, só repassa.

## Modo legado (sem OAuth) — conta única ou múltiplas contas fixas

Se `GITHUB_OAUTH_CLIENT_ID` não estiver definido, o servidor cai automaticamente
nesse modo:

- **Uma conta**: defina `GITHUB_TOKEN` (+ `DEFAULT_OWNER`/`DEFAULT_REPO`
  opcionais).
- **Várias contas pré-configuradas**: defina `GITHUB_ACCOUNTS` (JSON, mapa de
  nome da conta → `{token, defaultOwner, defaultRepo, owners}`) e,
  opcionalmente, `DEFAULT_ACCOUNT`. Use o parâmetro `account` nas ferramentas
  pra escolher qual usar, ou deixe o servidor inferir pelo `owner`.

Esse modo é mais simples mas não é dinâmico: só quem você configurou
manualmente tem acesso, e trocar de conta exige editar a variável de
ambiente.

## Deploy na Vercel

1. Suba este projeto para um repositório no GitHub.
2. Na Vercel, importe o repositório como um novo projeto e faça o primeiro
   deploy (pra descobrir a URL final).
3. Se for usar OAuth: crie o GitHub OAuth App apontando o callback pra
   `https://<url-da-vercel>/callback`, depois configure as variáveis
   (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `OAUTH_ENCRYPTION_KEY`) e faça um redeploy.
4. Se for usar o modo legado: configure `GITHUB_TOKEN` (ou `GITHUB_ACCOUNTS`)
   e faça um redeploy.
5. A URL do MCP é: `https://<seu-projeto>.vercel.app/mcp`

## Conectar no Claude

No Claude, adicione um **custom connector (MCP remoto)** apontando para
`https://<seu-projeto>.vercel.app/mcp`.

- No modo OAuth, o Claude detecta automaticamente que o servidor exige
  autenticação e abre a tela de login do GitHub pra cada pessoa que conectar.
- No modo legado, não é pedida nenhuma autenticação do lado do Claude — o
  token já está fixo na Vercel.

## Desenvolvimento local

```bash
npm install
cp .env.example .env.local   # preencha as variáveis do modo que for usar
npm run dev
```

O servidor MCP local sobe em `http://localhost:3000/mcp`.

## Segurança

- Nenhum token é commitado — tokens (fixos ou os do OAuth) ficam só em
  variáveis de ambiente / passam pelo servidor sem serem persistidos.
- No modo OAuth, o servidor nunca guarda o token de ninguém — ele é
  repassado do GitHub pro Claude a cada troca, e revalidado contra a API do
  GitHub a cada chamada de ferramenta.
- `whoami` nunca retorna tokens, só identifica a conta/sessão.
- No modo legado, recomenda-se usar tokens com escopo restrito
  (fine-grained, só nos repos que este MCP deve tocar).
- No modo legado, este servidor não tem autenticação própria — qualquer
  pessoa com a URL consegue chamá-lo, com acesso a todas as contas
  configuradas. Use o modo OAuth se isso for uma preocupação.
