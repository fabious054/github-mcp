# Self-hosting (rodar sua própria instância)

*[Read in English](./self-hosting.md)*

Este documento é pra quem trabalha na manutenção deste repositório, ou pra
quem quer rodar a própria instância separada deste servidor MCP. Se você só
quer usar a instância já existente, veja o [`README.md`](../README.pt-br.md)
principal — não precisa configurar nada.

O mesmo código suporta dois modos de autenticação, decididos só por quais
variáveis de ambiente estão definidas. Se `GITHUB_OAUTH_CLIENT_ID` estiver
definido, o OAuth tem prioridade.

## Modo OAuth (recomendado)

Qualquer pessoa que adicionar este connector no Claude faz login com a
própria conta do GitHub, na hora, sem precisar gerar token manualmente. Cada
um usa a própria conta, dinamicamente — é o modo "multi-usuário" de verdade.
Também suporta vincular mais de uma conta do GitHub à mesma pessoa (veja
`link_account` no README principal), com detecção automática por
repositório.

### Configuração

1. Crie **um** GitHub OAuth App (github.com → Settings → Developer settings
   → OAuth Apps → New OAuth App), com:
   - Homepage URL: a URL do seu projeto na Vercel.
   - Authorization callback URL: `https://<seu-projeto>.vercel.app/callback`
     (tem que ser essa exata — é fixa, então adicione depois de saber a URL
     final da Vercel). O GitHub aceita múltiplas callback URLs no mesmo
     OAuth App, então adicione também
     `https://<seu-projeto>.vercel.app/link-callback` (necessária pro
     vínculo de múltiplas contas).
2. Na Vercel, configure `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`
   e `OAUTH_ENCRYPTION_KEY` (gerada com `openssl rand -base64 32`).
3. Se quiser o vínculo de múltiplas contas, configure também `MONGODB_URI`
   (ver "Armazenamento do vínculo de múltiplas contas" abaixo). Sem isso, a
   ferramenta `link_account` falha — o resto do modo OAuth continua
   funcionando normalmente com uma conta por pessoa.

Cada pessoa que adiciona este MCP como custom connector no Claude é levada
pra uma tela real de "Autorizar `<seu OAuth App>`" no GitHub. Ao aprovar, o
Claude passa a chamar as ferramentas usando o token dessa pessoa — nunca um
token compartilhado. `whoami` confirma, a qualquer momento, qual conta está
autenticada na sessão.

Se o repositório-alvo pertence a uma organização (ex: `robozz-br`), a
organização pode exigir aprovar o OAuth App explicitamente pra acesso a
repos privados dela (Settings da organização → Third-party access).

### Como o OAuth é implementado (sem banco de dados pro fluxo base)

Este servidor roda em funções sem estado na Vercel, então em vez de guardar
sessões/códigos num banco, tudo o que o fluxo base de OAuth precisa lembrar
viaja **criptografado (AES-256-GCM)** dentro dos próprios parâmetros — o
`client_id` devolvido em `/register`, o `state` usado com o GitHub, e o
`code` trocado em `/token`. Só quem tem a `OAUTH_ENCRYPTION_KEY` consegue
gerar ou ler esses blobs.

Limitação conhecida: como não há banco pra essa parte, um `code` de
autorização não é invalidado após o primeiro uso — ele simplesmente expira
sozinho (2 minutos). Isso é aceitável pra este caso de uso (o código só
existe dentro de um redirect HTTPS entre o GitHub e o Claude), mas é uma
diferença em relação a um Authorization Server "completo" com
armazenamento — vale saber.

O token que o Claude recebe **é o próprio token de acesso do GitHub** da
pessoa — o servidor nunca guarda nem loga esse token, só repassa.

### Armazenamento do vínculo de múltiplas contas

Vincular mais de uma conta à mesma identidade primária (ferramenta
`link_account`) é a única parte deste servidor que não é stateless — veja o
[ADR 0002](./adr/0002-multi-account-oauth-linking.md) pro raciocínio
completo. Exige `MONGODB_URI` (uma connection string do MongoDB Atlas; o
tier free M0 é suficiente). O token de uma conta vinculada fica guardado
criptografado (AES-256-GCM, reaproveitando os mesmos helpers do fluxo base
de OAuth) — nunca em texto puro.

## Modo legado (sem OAuth) — conta única ou múltiplas contas fixas

Se `GITHUB_OAUTH_CLIENT_ID` não estiver definido, o servidor cai
automaticamente nesse modo:

- **Uma conta**: defina `GITHUB_TOKEN` (+ `DEFAULT_OWNER`/`DEFAULT_REPO`
  opcionais).
- **Várias contas pré-configuradas**: defina `GITHUB_ACCOUNTS` (JSON, mapa
  de nome da conta → `{token, defaultOwner, defaultRepo, owners}`) e,
  opcionalmente, `DEFAULT_ACCOUNT`. Use o parâmetro `account` nas
  ferramentas pra escolher qual usar, ou deixe o servidor inferir pelo
  `owner`.

Esse modo é mais simples mas não é dinâmico: só quem você configurou
manualmente tem acesso, e trocar de conta exige editar a variável de
ambiente. Este servidor não tem autenticação própria nesse modo — qualquer
pessoa com a URL consegue chamá-lo, com acesso a todas as contas
configuradas. Use o modo OAuth se isso for uma preocupação.

## Deploy na Vercel

1. Suba este projeto para um repositório no GitHub.
2. Na Vercel, importe o repositório como um novo projeto e faça o primeiro
   deploy (pra descobrir a URL final).
3. Se for usar OAuth: crie o GitHub OAuth App apontando o callback pra
   `https://<url-da-vercel>/callback`, depois configure as variáveis
   (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `OAUTH_ENCRYPTION_KEY`, e `MONGODB_URI` se quiser o vínculo de múltiplas
   contas) e faça um redeploy.
4. Se for usar o modo legado: configure `GITHUB_TOKEN` (ou `GITHUB_ACCOUNTS`)
   e faça um redeploy.
5. A URL do MCP é: `https://<seu-projeto>.vercel.app/mcp`

## Desenvolvimento local

```bash
npm install
cp .env.example .env.local   # preencha as variáveis do modo que for usar
npm run dev
```

O servidor MCP local sobe em `http://localhost:3000/mcp`.

## Referência das variáveis de ambiente

Veja [`.env.example`](../.env.example) pra lista completa com comentários,
agrupada por modo.

## Decisões de arquitetura

- [0001 — Git Data API for large commits](./adr/0001-git-data-api-for-large-commits.md)
- [0002 — Multi-account OAuth linking](./adr/0002-multi-account-oauth-linking.md)
