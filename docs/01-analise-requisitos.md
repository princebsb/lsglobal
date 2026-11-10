# 01 — Análise de requisitos

## Inconsistências e decisões

| # | Ponto do prompt mestre | Decisão |
|---|---|---|
| 1 | Pede Docker/Docker Compose (§4, §34) | Instrução do cliente: **sem Docker**. PostgreSQL nativo; scripts `db:setup`/`db:migrate`/`db:seed`. Redis, LiveKit e storage S3 serão instalados nativamente ou como serviços gerenciados. |
| 2 | Redis obrigatório | Não instalado. O MVP roda sem Redis (Socket.IO em nó único). Redis torna-se obrigatório para escala horizontal (adapter Socket.IO) e filas (BullMQ). |
| 3 | Base legal cita só a Lei 14.309/2022 | A Lei 14.405/2022 alterou o art. 1.351 (2/3 para alteração de convenção e mudança de destinação). Registrado nos modelos para validação jurídica. |
| 4 | "Votação sigilosa" + "auditoria completa" + "ponderação por fração" | Conflito parcial: com frações ideais únicas, o peso pode revelar a unidade. Implementado: participação separada da escolha, sem timestamps nas escolhas, leitura bloqueada ao papel da aplicação. Recomendar contagem por unidade em votações sigilosas. Sigilo criptográfico forte (mixnet/homomórfico) fica fora do MVP. |
| 5 | "Abstenção" no denominador | Interpretação controversa — parametrizado (`votes_cast` × `valid_votes`). |
| 6 | Estado "Suspensa ou sessão subsequente" | Modelado como `suspended`, com sessões numeradas (`assembly_sessions`). |
| 7 | Associações | Regime próprio (`legal_regime = associacao`); modelos de condomínio edilício são bloqueados para elas. |
| 8 | Biometria | Não utilizada. |
| 9 | Impersonação | Não implementada no MVP. Acesso de suporte é feito por permissão `platform.tenants.access`, marcado na auditoria e **sem possibilidade de voto** (voto exige pessoa credenciada vinculada ao usuário). |

## Obrigatórios × opcionais (MVP)

**Obrigatórios (prompt §35):** cliente/condomínio, unidades/proprietários, procurações, assembleia, regras homologadas,
convocação, credenciamento, transmissão interativa, gravação, palavra remota, votação sem duplicidade, quórum, resultado,
encerramento, reprodução da gravação, exportação, auditoria, isolamento.

**Entregues nesta etapa:** todos, exceto convocação (envio), transmissão, gravação, palavra remota e reprodução.

**Opcionais/pós-MVP:** WhatsApp, SMS, white-label avançado, assinatura eletrônica, integrações com ERPs condominiais,
transcrição, legendas, API pública versionada para clientes.
