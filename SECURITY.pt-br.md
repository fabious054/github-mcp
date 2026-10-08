# Política de segurança

*[Read in English](./SECURITY.md)*

Este documento descreve o modelo de segurança deste servidor, o que foi
verificado antes de tornar o repositório público, e como reportar uma
vulnerabilidade.

## Modelo de acesso

- Toda pessoa que conecta autentica com a **própria** conta do GitHub, por
  um fluxo real de OAuth ("Autorizar") — não existe token manual pra gerar
  nem credencial compartilhada.
- O servidor nunca guarda o token da conta primária. Ele é repassado do
  GitHub pro Claude a cada troca, e revalidado contra a API do GitHub a
  cada chamada de ferramenta — nada é escrito em disco ou banco de dados.
- O Claude também recebe um **refresh token** pra renovar a validade de 8
  horas do token sem novo login. Ele é um blob criptografado (AES-256-GCM)
  que contém o token do GitHub e fica só com o Claude; nunca expira sozinho
  e para de funcionar assim que a autorização é revogada no GitHub, o que é
  conferido a cada renovação. Trate-o como o próprio token do GitHub. Veja o
  [ADR 0011](./docs/adr/0011-stateless-refresh-tokens.md).
- A única coisa que este servidor persiste é o token de uma **conta
  vinculada (não-primária)** (funcionalidade `link_account`), e sempre fica
  guardado criptografado (AES-256-GCM), nunca em texto puro. Veja o
  [ADR 0002](./docs/adr/0002-multi-account-oauth-linking.md) pro design
  completo. O `unlink_account` apaga esse vínculo e revoga o token dele no
  GitHub; cada pessoa só consegue remover vínculos da própria conta primária
  (veja a [ADR 0013](./docs/adr/0013-unlink-account.md)).
- `whoami` nunca retorna um token, só identifica a conta/sessão em uso.
- Todo endpoint público tem limite de requisições, feito por um limitador
  baseado em Redis, pra frear abuso e tentativas de força bruta (veja o
  [ADR 0003](./docs/adr/0003-redis-rate-limiting.md)). Os limites são por
  IP nos endpoints de OAuth e por bearer token no `/mcp`; tokens inválidos
  repetidos são limitados por IP. O limitador é fail-open: se o Redis cair,
  as requisições passam em vez de bloquear o uso legítimo, então ele reduz
  a exposição mas não substitui um WAF. O Redis guarda só contadores com
  chave por IP ou por hash do token — nunca um token em si.
- O modo legado (`GITHUB_TOKEN`/`GITHUB_ACCOUNTS` fixos, sem OAuth) não tem
  autenticação própria — qualquer um com a URL consegue chamá-lo, com
  acesso a todas as contas configuradas. Ele existe pra quem for rodar a
  própria instância sozinho; o modo OAuth é recomendado pra qualquer
  instância compartilhada. Veja
  [`docs/self-hosting.pt-br.md`](./docs/self-hosting.pt-br.md).

## Logs de auditoria

Eventos de autenticação e de limite de requisições são gravados nos logs de
execução, um JSON por linha (busque por `"audit":` nos logs da Vercel):

| Evento | Quando |
|---|---|
| `mcp.auth.rejected` | O GitHub recusou o token no `/mcp` (resposta 401; o cliente precisa reconectar) |
| `mcp.auth.transient` | O GitHub não conseguiu validar o token naquele momento — 5xx, limite de requisições, erro de rede ou timeout (resposta 503 + `Retry-After`; a sessão é mantida) |
| `ratelimit.blocked` | Uma requisição recebeu 429, com a rota e qual limite estourou |
| `oauth.token.issued` | Um login OAuth terminou e o Claude recebeu o token |
| `oauth.token.refreshed` | O Claude renovou o token usando o refresh token |
| `oauth.token.refresh_rejected` | Uma renovação falhou porque o GitHub não aceita mais o token (revogado); a pessoa precisa fazer login de novo |
| `oauth.token.refresh_transient` | O GitHub não conseguiu validar o token durante uma renovação (resposta 503 + `Retry-After`; o refresh token continua válido) |
| `oauth.link.completed` / `oauth.link.failed` | Um fluxo de `link_account` terminou ou falhou |
| `oauth.link.removed` | Uma conta foi desvinculada com `unlink_account`, com o resultado da revogação do token dela no GitHub |
| `oauth.link.token_revoked` | O GitHub recusou o token guardado de uma conta vinculada (revogado ou expirado), com o ponto em que isso foi detectado; a conta precisa ser vinculada de novo (veja a [ADR 0007](./docs/adr/0007-revoked-linked-accounts.md)) |

Cada linha traz o necessário pra diagnóstico: status do GitHub, o
`x-github-request-id` do GitHub, cabeçalhos de limite quando existem, o IP
do cliente e uma **impressão digital do token** (os 12 primeiros caracteres
hex do SHA-256 do token — suficiente pra correlacionar eventos, inútil pra
recuperar o token). **Nenhum token é registrado em log** — nem o bearer do
MCP, nem o token do GitHub, nem o de uma conta vinculada. Chamadas de
ferramenta bem-sucedidas não são registradas.

## O que foi verificado antes de abrir este repositório

- `.gitignore` exclui `.env`, `.env.local` e `.vercel` — nenhum arquivo de
  segredo está rastreado.
- O código atual foi checado contra padrões comuns de segredo (prefixos de
  token do GitHub, strings de conexão do MongoDB, cabeçalhos de chave
  privada) — nada encontrado.

**Limitação conhecida:** essa checagem cobre só o conteúdo atual da branch
padrão, não o histórico completo do git. Ela descarta um segredo presente
hoje; não prova que um nunca foi commitado e removido depois. Se em algum
momento você suspeitar que uma credencial foi exposta, o mais simples é
rotacioná-la — gerar uma `OAUTH_ENCRYPTION_KEY` nova e trocar o client
secret do GitHub OAuth App não custa nada e fecha essa dúvida
independentemente do histórico.

## Reportando uma vulnerabilidade

Se encontrar um problema de segurança, abra uma issue neste repositório
marcada claramente como reporte de segurança, ou entre em contato direto
com o mantenedor em vez de divulgar publicamente primeiro. Reportes são
levados a sério e tratados como prioridade.

## Pra quem roda a própria instância

Quem roda a própria instância (veja
[`docs/self-hosting.pt-br.md`](./docs/self-hosting.pt-br.md)) é responsável
pelos próprios segredos: gere uma `OAUTH_ENCRYPTION_KEY` nova (nunca
reaproveite a de outra instância), mantenha `MONGODB_URI` fora do controle
de versão (e o mesmo vale pra `REDIS_URL`), e registre seu próprio GitHub
OAuth App em vez de reusar credenciais de outra pessoa.
