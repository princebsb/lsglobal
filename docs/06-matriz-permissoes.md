# 06 — Matriz de permissões

Fonte única: `packages/shared/src/permissions.ts` (sincronizada no banco a cada `db:migrate`).

| Perfil | Escopo | MFA | Principais permissões |
|---|---|---|---|
| Superadministrador LS Global | plataforma | sim | painel global, clientes, acesso auditado a clientes, auditoria |
| Operacional LS Global | plataforma | sim | painel, acesso a clientes, operação técnica |
| Comercial LS Global | plataforma | sim | painel, clientes |
| Administradora (tenant_admin) | cliente | sim | tudo do cliente, inclusive **convocar** (edital), exceto conduzir a mesa |
| Síndico | condomínio | sim | cadastros, procurações, regras (criar/homologar), planejar e homologar assembleia, **convocar**, credenciar, relatórios, votos nominais |
| Subsíndico | condomínio | sim | cadastros, procurações (registrar), planejar, credenciar |
| Presidente da assembleia | condomínio | não | **conduzir** (sessões, abrir/encerrar/apurar/declarar, conceder a palavra, gravação), credenciar, votos nominais |
| Secretário | condomínio | não | conduzir, credenciar |
| Operador técnico / Moderador / Fornecedor AV | condomínio | não | operação técnica (sala, gravação, participantes conectados) — **sem acesso a votos** |
| Fiscal/auditor | condomínio | não | consulta, auditoria, relatórios |
| Apoio ao credenciamento | condomínio | não | credenciar |
| Condômino / Procurador | condomínio | não | participar, ver resultados declarados |
| Convidado | condomínio | não | visualizar |

Regras transversais:
- **Votar não é permissão administrativa**: exige pessoa vinculada ao usuário, credenciada como representante da unidade.
- Ninguém altera votos (sem rota; tabelas append-only e sem UPDATE para a aplicação).
- Votos nominais: somente após o encerramento e com `votes.view_nominal`; votações sigilosas nunca.
- Transmissão: publicar áudio/vídeo só para a mesa/técnico ou para o condômino **com a palavra concedida**; assistir exige credenciamento ativo.
- Revelação de CPF/CNPJ: `people.view_sensitive`, auditada.
