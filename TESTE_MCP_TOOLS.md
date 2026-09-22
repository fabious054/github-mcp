# Teste das ferramentas do GitHub MCP

Este arquivo foi criado via `commit_tree` para validar a Git Data API (issue #3 / PR #4) ao vivo.

- Criado por: fabious054
- Objetivo: confirmar que create_blob -> create_tree -> create_commit -> update_ref funcionam corretamente numa chamada só, misturando um arquivo novo com um arquivo reaproveitado por SHA.
- patch_file: testado com sucesso via diff unificado, sem reenviar o arquivo inteiro.
