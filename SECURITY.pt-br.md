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
- A única coisa que este servidor persiste é o token de uma **conta
  vinculada (não-primária)** (funcionalidade `link_account`), e sempre fica
  guardado criptografado (AES-256-GCM), nunca em texto puro. Veja o
  [ADR 0002](./docs/adr/0002-multi-account-oauth-linking.md) pro design
  completo.
- `whoami` nunca retorna um token, só identifica a conta/sessão em uso.
- O modo legado (`GITHUB_TOKEN`/`GITHUB_ACCOUNTS` fixos, sem OAuth) não tem
  autenticação própria — qualquer um com a URL consegue chamá-lo, com
  acesso a todas as contas configuradas. Ele existe pra quem for rodar a
  própria instância sozinho; o modo OAuth é recomendado pra qualquer
  instância compartilhada. Veja
  [`docs/self-hosting.pt-br.md`](./docs/self-hosting.pt-br.md).

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
de versão, e registre seu próprio GitHub OAuth App em vez de reusar
credenciais de outra pessoa.
