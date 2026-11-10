# 04 — Matriz de riscos

| Risco | Prob. | Impacto | Mitigação atual | Pendência |
|---|---|---|---|---|
| Regra jurídica mal parametrizada | Média | Alto | Regras não presumidas; homologação obrigatória com fundamento; resultado não declarável com pendência bloqueante | Validação por advogado de cada modelo e cenários de teste jurídicos assinados |
| Vazamento entre clientes | Baixa | Crítico | Guard + RLS forçado + FKs compostas + papel sem BYPASSRLS + testes | DAST/pentest externo |
| Voto duplicado / ambíguo | Baixa | Crítico | Constraints, idempotência, savepoint, teste de concorrência | Teste de carga com milhares de votos simultâneos |
| Quebra de sigilo | Média | Alto | Separação participação/escolha; leitura bloqueada; sem timestamps | Ordem física de inserção e pesos únicos podem correlacionar — avaliar esquema criptográfico |
| Adulteração por DBA | Baixa | Alto | Cadeia de hash detecta | Ancorar o hash-cabeça periodicamente fora do banco (e-mail/carimbo de tempo) |
| Falha de transmissão/gravação | Média | Alto | Início confirmado só por webhook; alerta de falha; aviso de sessão sem gravação; SHA-256 | Validar com LiveKit real; procedimento de contingência; redundância de gravação |
| Convocação inválida | Média | Alto | Edital imutável com hash; destinatários = todos os titulares; aviso de prazo (parametrizável); ciência obrigatória do aviso jurídico; unidades sem e-mail destacadas | Meio previsto na convenção (carta/AR) fora do sistema; SMTP só confirma aceite, não entrega |
| Escala de mídia | — | Alto | — | Não afirmar capacidade sem testes de carga do LiveKit |
| Dependências com vulnerabilidades (exceljs transitivas) | Média | Médio | — | `npm audit`; avaliar substituto do exceljs |
| Link pessoal de convocação vazado | Média | Baixo | Link só exibe o edital e registra abertura; participar exige login + credenciamento | — |
| LGPD | Média | Alto | Minimização, cifra de documentos, revelação auditada | RIPD, política de retenção, contratos controlador/operador |
