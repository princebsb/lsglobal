# LS Global Assembleias

Plataforma SaaS multi-tenant para assembleias condominiais presenciais, virtuais e híbridas — LS Global Tecnologia.

> **Estado atual:**
> - Prontas: Fase 1 (fundação), Fase 2 (cadastros e convocação por e-mail) e Fase 3 (votação e quórum).
> - Fase 4 (transmissão, palavra e gravação com LiveKit): implementada; sala, tokens, webhooks e palavra validados
>   com LiveKit Server real em localhost. Gravação (Egress) e uso em rede externa **ainda não validados**
>   (ver [docs/08](docs/08-transmissao-livekit.md)).
> - Ainda não implementados: WhatsApp, serviço gerenciado (Fase 5) e comercial/faturamento (Fase 6).
> Veja [docs/05-backlog.md](docs/05-backlog.md).

## Stack (sem Docker)

| Camada | Tecnologia |
|---|---|
| Front-end | React 18.3, TypeScript 5.9, Vite 6, Ant Design 5, TanStack Query 5, React Router 6, React Hook Form + Zod 4, PWA |
| Back-end | Node.js 22, NestJS 11 (monólito modular), REST + OpenAPI, Socket.IO |
| Banco | PostgreSQL 18 nativo (RLS, triggers append-only, cadeia de hash) |
| Domínio compartilhado | `@lsg/shared` — motor de quórum, máquinas de estado, permissões, esquemas Zod |

Versões exatas: [docs/07-versoes.md](docs/07-versoes.md).

## Estrutura

```
packages/shared   motor de quórum/apuração (aritmética exata BigInt), estados, RBAC, validações
apps/api          NestJS: auth+MFA, multi-tenant, condomínios, pessoas, procurações, regras, assembleias,
                  credenciamento, votação, convocação (e-mail + fila), transmissão (LiveKit), relatórios, auditoria
apps/api/migrations  SQL versionado (checksum) — RLS, constraints, triggers
apps/web          React PWA: painel, cadastros, mesa diretora, credenciamento, sala do condômino
docs/             arquitetura, modelo de dados, riscos, backlog, matriz de permissões
```

## Executar localmente

Pré-requisitos: Node.js ≥ 22 e PostgreSQL (testado no 18, porta 5433).

```bash
cp .env.example .env        # ajuste DATABASE_ADMIN_URL e gere os segredos indicados
npm install
npm run setup               # build do shared, cria papel/bancos, aplica migrações e dados de demonstração
npm run dev                 # API em :3333 e web em :5173
```

- Web: http://localhost:5173 · API: http://localhost:3333/api/v1 · OpenAPI: http://localhost:3333/api/docs
- Usuários de demonstração (somente local), senha `Demo@LSG2026`:
  `admin@lsglobal.local` (plataforma), `gestor@horizonte.demo` (administradora), `sindico@acacias.demo`,
  `presidente@acacias.demo` (mesa), `credenciamento@acacias.demo`, condôminos `ana@` (2 unidades), `bruno@`, `carla@`,
  `daniel@`, `karina@` (coproprietária designada), procuradora `marina@acacias.demo`; outro cliente `admin@beta.demo`.

### Roteiro de demonstração
0. Convocação: `sindico@` → nova assembleia → pauta → homologar → *Aprovada para convocação* → aba **Convocação** →
   redigir e **Publicar e enviar**. Com `MAIL_DRIVER=file`, os e-mails ficam em `apps/api/storage/outbox/*.eml`
   (abra um deles e siga o link pessoal `/c/...`).
1. `presidente@` → Assembleias → 2026-001 → **Abrir credenciamento**.
2. `sindico@` → Condomínios → Procurações → analisar a procuração pendente.
3. `ana@` (outra janela/anônima) → Sala → **Confirmar presença** nas duas unidades.
4. `presidente@` → **Iniciar sessão** (1ª convocação) → Mesa diretora → **Abrir** votação.
5. `ana@` → **Votar** → recebe comprovante.
6. `presidente@` → Encerrar → Apurar → Declarar. Exportar presença/resultado. Auditoria → Verificar integridade.

## Testes

```bash
npm test                    # 36 unitários (shared) + 62 de integração (API, banco de teste recriado a cada execução)
```

Cobrem: titular com duas unidades, coproprietários, procurador com várias unidades, procuração pendente/revogada,
voto duplicado, 8 votos simultâneos (exatamente 1 aceito), reenvio idempotente após reconexão, duas sessões de navegador,
presencial + remoto, mudança de elegibilidade, 1ª/2ª convocação, fração ideal, quórum especial (2/3), votação sigilosa,
cancelamento e nova rodada, isolamento entre tenants (API e RLS no banco), MFA, rotação de refresh token com detecção de reuso,
bloqueio por tentativas, append-only, exportação e detecção de adulteração da auditoria;
convocação (edital imutável, destinatários, fila com nova tentativa, link pessoal, retificação, comprovante);
transmissão (token por papel, fila de palavra, gravação confirmada por webhook assinado, SHA-256, idempotência).

## Avisos

- Modelos de regras jurídicas e textos legais são **pontos de partida sujeitos a validação profissional**.
- O registro de envio/abertura da convocação **não** comprova a validade jurídica da convocação.
- Não usar a seed nem `MFA_ENFORCE_ADMIN=false` fora do ambiente local.
