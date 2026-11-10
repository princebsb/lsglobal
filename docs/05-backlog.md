# 05 — Backlog e situação por fase

Legenda: ✅ entregue e testado · 🟡 parcial · ⬜ não iniciado

## Fase 1 — Fundação
✅ monorepo · ✅ auth (Argon2id, JWT, refresh rotativo com detecção de reuso, bloqueio) · ✅ MFA TOTP (obrigatório para perfis administrativos via `MFA_ENFORCE_ADMIN`) ·
✅ multi-tenant + RLS · ✅ RBAC contextual · ✅ migrações versionadas · ✅ OpenAPI · ✅ design system (Ant Design, tema claro/escuro) · ✅ condomínios/blocos/unidades ·
✅ auditoria append-only · 🟡 rate limiting (em memória; mover para Redis em cluster) · ⬜ CI/CD · ⬜ logs centralizados

## Fase 2 — Assembleias
✅ unidades e importação CSV validada · ✅ condôminos (cifra de documentos) · ✅ procurações (análise, conflitos, limite da convenção, revogação) ·
✅ pauta · ✅ credenciamento presencial/remoto · ✅ convocação por e-mail (edital versionado e imutável, destinatários das unidades, fila com nova tentativa, link pessoal com registro de abertura, retificação, comprovante CSV/XLSX com hash) · ⬜ WhatsApp · ⬜ upload de documentos/anexos (tabela existe; storage S3 pendente) · ⬜ QR Code de credenciamento

## Fase 3 — Votação e quórum
✅ motor transacional · ✅ regras versionadas e homologação · ✅ apuração exata (unidade/fração) · ✅ sigilosa · ✅ cancelamento e rodadas ·
✅ quórum ao vivo e simulação · ✅ relatórios CSV/XLSX com hash · 🟡 dashboards (painel do cliente e plataforma básicos) · ⬜ PDF e minuta de ata · ⬜ pacote final da assembleia

## Fase 4 — Transmissão e gravação 🟡
✅ token por papel · ✅ sala no portal (assistir; mesa publica câmera/microfone/tela) · ✅ fila de palavra com tempo ·
✅ permissão de publicação aplicada em tempo real · ✅ gravação Egress com confirmação de início por webhook ·
✅ SHA-256 e imutabilidade da gravação · ✅ alerta de falha · ✅ conexão/desconexão como evidência de presença ·
✅ validação com LiveKit real em localhost · ⬜ Egress real, rede externa/TURN e teste de carga · ⬜ RTMP/WHIP de equipamentos · ⬜ reprodução sincronizada · ⬜ upload S3 ·
⬜ métricas de qualidade. Ver [08-transmissao-livekit.md](08-transmissao-livekit.md).

## Fases 5, 6 e 7 ⬜
Serviço gerenciado (equipamentos, fornecedores, OS, checklists), comercial (planos, contratos, faturamento, gateways, NF), homologação (carga, segurança, validação jurídica, piloto).

## Próximas histórias priorizadas
1. **Gravação real**: Egress em Linux/WSL2 + Redis; depois teste de carga e TURN.
2. **Minuta de ata em PDF** a partir da linha do tempo (inclui palavra, gravações e resultados declarados).
3. **WhatsApp** (API oficial) como segundo canal de convocação, com opt-in registrado.
4. **Upload de documentos/anexos** (edital, procurações) em object storage.

**Definição de pronto:** código tipado, validação Zod na API, autorização no back-end, migração, auditoria, testes de integração, documentação atualizada.
