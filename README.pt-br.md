# GitHub MCP

*[Read in English](./README.md)*

MCP server que dá ao Claude acesso real ao GitHub: criar branch, commitar,
abrir/comentar PRs, listar/criar/comentar issues, ler arquivos e buscar código.

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
- `commit_file` — cria/atualiza um arquivo com uma mensagem de commit (conteúdo inteiro, um arquivo por chamada)
- `patch_file` — aplica um diff unificado a um arquivo existente numa branch, sem reenviar o conteúdo inteiro
- `get_branch_head` — lê o SHA completo (40 caracteres) do commit que uma branch aponta
- `open_pr` — abre um Pull Request
- `list_prs` — lista PRs
- `comment_pr` — comenta num PR
- `list_issues` — lista issues (tarefas do board)
- `create_issue` — cria uma issue
- `comment_issue` — comenta numa issue (ex: relatório final de QA)
- `read_file` — lê o conteúdo de um arquivo
- `search_code` — busca código no repositório
- `whoami` — mostra qual identidade/conta está sendo usada na sessão atual
- `link_account` — vincula uma conta ADICIONAL do GitHub à sua sessão
- `list_accounts` — lista as contas vinculadas à sua sessão
- `list_repos_by_account` — lista os repositórios acessíveis por uma conta vinculada específica

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
- `get_tree` — lê uma tree (lista arquivos e SHAs de blob de um commit/branch), útil pra descobrir o SHA de um blob já existente e reaproveitá-lo
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
   qual(is) tem acesso ao repositório-alvo e usa a que bater
   automaticamente, ou pede pra você repetir a chamada com `account`
   explícito quando mais de uma bater.
4. `list_accounts` lista todas as contas vinculadas à sua sessão, e
   `list_repos_by_account` lista o que uma conta específica acessa — útil
   pra conferir antes de uma chamada, ou pra descobrir qual `account`
   informar quando o erro de ambiguidade acima acontecer.

## Segurança

- Nenhum token é commitado neste repositório.
- O servidor nunca guarda o token da sua conta primária — ele é repassado do
  GitHub pro Claude a cada troca, e revalidado contra a API do GitHub a cada
  chamada de ferramenta.
- `whoami` nunca retorna tokens, só identifica a conta/sessão.
- O token de uma conta vinculada (não-primária) é a única coisa que este
  servidor persiste, e sempre fica guardado criptografado (AES-256-GCM) —
  nunca em texto puro.

Política de segurança completa, modelo de ameaça e como reportar uma
vulnerabilidade: [`SECURITY.pt-br.md`](./SECURITY.pt-br.md).

## Decisões de arquitetura

Decisões de design relevantes ficam registradas como ADRs em
[`docs/adr/`](./docs/adr/) (em inglês):

- [0001 — Git Data API for large commits](./docs/adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./docs/adr/0002-multi-account-oauth-linking.md)

## Licença

[MIT](./LICENSE)
