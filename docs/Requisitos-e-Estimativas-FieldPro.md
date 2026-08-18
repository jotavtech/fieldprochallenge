# Requisitos e Estimativas de Esforço — Dispatch em Ondas (FieldPro)

**Escopo:** estimativas para implementação real em produção (não para o prazo do desafio técnico).
**Premissa de equipe:** 1 engenheiro backend sênior + 1 engenheiro frontend pleno/sênior,
trabalhando em paralelo onde possível. Estimativas em **horas de trabalho focado**, não em
dias corridos de calendário (não incluem reuniões, revisão de PR, deploy gradual etc. — isso está
separado em "Atividades de processo" no fim).

**Como ler a coluna de complexidade:** Baixa = padrão conhecido, pouca decisão de design. Média =
exige decisão de design mas sem incerteza tecnológica. Alta = tem incerteza real (performance sob
carga, integração externa, condição de corrida) e pode estourar a estimativa.

---

## 1. Requisitos Funcionais (RF)

| ID | Requisito | Descrição resumida | Estimativa | Complexidade |
|----|-----------|---------------------|:---:|:---:|
| RF1.1 | Modelo de dados do dispatch | Tabelas `vagas`, `dispatch_ondas`, `notificacoes` + migrations | 4h | Baixa |
| RF1.2 | Cálculo de "urgente" com timezone | Determinar <24h considerando timezone da vaga, não do servidor | 3h | Média |
| RF1.3 | Agendador de ondas | Job de onda com delay, cálculo de intervalo proporcional (premissa #1) | 8h | Média |
| RF1.4 | Query de destinatários — onda 1 (favoritos) | Query de operadores favoritados pelo local | 2h | Baixa |
| RF1.5 | Query de destinatários — onda 2 (histórico) | Operadores que trabalharam no local nos últimos 12 meses | 3h | Baixa |
| RF1.6 | Query de destinatários — onda 3 (raio geográfico) | Operadores elegíveis dentro do raio + especialidade compatível | 6h | Média |
| RF1.7 | Interrupção de ondas ao confirmar | Cancelar/ignorar ondas futuras quando vaga é confirmada | 4h | Média |
| RF1.8 | Revalidação de versão ao disparar onda | Onda checa `versao_vaga_no_agendamento` antes de enviar | 3h | Baixa |
| **RF2.1** | **Endpoint de aceitação com UPDATE atômico** | **`POST /vagas/{id}/aceitar`, garantia de exclusividade** | **4h** | **Alta** |
| RF2.2 | Teste de concorrência real | 100 requisições paralelas, assert de exatamente 1 sucesso | 4h | Alta |
| RF2.3 | Tratamento de resposta 409 no cliente | UX de "vaga já foi preenchida" | 2h | Baixa |
| RF3.1 | Contagem de notificações/dia por operador | Query de anti-spam antes de montar lista de destinatários | 3h | Baixa |
| RF3.2 | Exclusão de operadores no limite antes do envio | Filtro aplicado na montagem da onda, não pós-falha | 2h | Baixa |
| RF4.1 | Índice geoespacial no Redis | `GEOADD`/`GEOSEARCH` para vagas abertas | 6h | Média |
| RF4.2 | Sincronização Postgres → Redis no commit | Invalidação/remoção da entrada no mesmo commit de mudança de status | 5h | Alta |
| RF4.3 | Endpoint de busca com filtros | Raio, data, especialidade, faixa de valor | 6h | Média |
| RF4.4 | Testes de carga (p99 <200ms @ 500rps) | Setup de ferramenta de carga + calibração de índices/cache | 8h | Alta |
| RF5.1 | Edição de vaga com versionamento | Incrementar `versao` em edições relevantes | 3h | Baixa |
| RF5.2 | Cancelamento de vaga | Muda status, invalida ondas pendentes | 2h | Baixa |
| RF5.3 | Aviso de "ondas já disparadas não são reenviadas" | Comunicação no fluxo de edição (backend + frontend) | 2h | Baixa |
| RF6.1 | Cliente HTTP para provider de push | Wrapper com timeout, serialização | 3h | Baixa |
| RF6.2 | Rate limiter global (600 rps) | Compartilhado entre todos os dispatches simultâneos | 6h | Alta |
| RF6.3 | Retry com backoff exponencial (429/5xx) | Teto de tentativas, jitter | 4h | Média |
| RF6.4 | Endpoint de webhook (callback do provider) | Recebe entrega/falha por notificação | 3h | Baixa |
| RF6.5 | Idempotência do webhook | Dedupe por `provider_message_id` | 3h | Média |
| RF7.1 | Tela "vagas perto de mim" (operador) | Lista + filtros + botão aceitar | 8h | Média |
| RF7.2 | Tela de detalhe da vaga | Endereço, valor, horário, botão aceitar | 4h | Baixa |
| RF7.3 | Tela do local: publicar/editar/cancelar vaga | Formulário + validações | 8h | Média |
| RF7.4 | Tela de acompanhamento do dispatch (stretch) | Visualização de ondas/status por vaga | 6h | Média |
| RF7.5 | Tratamento de conflito na UI (409 sem refresh manual) | Refetch/polling ao tentar aceitar vaga já preenchida | 3h | Baixa |

**Subtotal RF:** ~113h (~14 dias de trabalho focado de 8h)

---

## 2. Requisitos Não Funcionais (RNF)

| ID | Requisito | Descrição resumida | Estimativa | Complexidade |
|----|-----------|---------------------|:---:|:---:|
| RNF1 | Performance de leitura | p99 < 200ms @ 500 req/s no endpoint de busca (calibração + índices) | 8h | Alta |
| RNF2 | Consistência forte na escrita | Garantir zero duplo-confirmação sob qualquer carga (validado com teste de carga, não só unitário) | 6h | Alta |
| RNF3 | Disponibilidade do rate limiter | Rate limiter global não pode virar ponto único de falha (Redis com fallback/circuit breaker) | 6h | Alta |
| RNF4 | Idempotência ponta a ponta | Webhook, retry de push e aceitação de vaga todos idempotentes | (coberto em RF2/RF6, sem custo adicional) | — |
| RNF5 | Observabilidade — logs estruturados | Log por evento de onda (agendada/disparada/abortada) com correlação | 4h | Baixa |
| RNF6 | Observabilidade — métricas | Contagem de 409, staleness Redis vs Postgres, taxa de 429/5xx do provider | 6h | Média |
| RNF7 | Alertas | Limiar de erro do provider externo, staleness acima do esperado | 4h | Média |
| RNF8 | Escalabilidade horizontal dos workers | Workers de dispatch e de push stateless, escaláveis independentemente | 6h | Média |
| RNF9 | Segurança — autenticação/autorização | Local só edita/cancela suas próprias vagas; operador só aceita se elegível | 6h | Média |
| RNF10 | Segurança — validação de webhook externo | Verificar assinatura/origem do callback do provider | 3h | Baixa |
| RNF11 | Timezone consistente ponta a ponta | Toda lógica de "urgente" e exibição usa timezone da vaga, não do servidor | (coberto em RF1.2) | — |
| RNF12 | Resiliência a falha do provider externo | Sistema continua funcionando (com degradação) se o provider cair | 4h | Média |
| RNF13 | Auditabilidade | Histórico de notificações rastreável por vaga/onda/operador | (coberto no modelo de dados RF1.1) | — |
| RNF14 | Testabilidade | Cobertura de testes de integração para os fluxos críticos (aceitação, ondas, webhook) | 10h | Média |

**Subtotal RNF:** ~63h (~8 dias)

---

## 3. Atividades de processo (fora do código em si)

| Atividade | Estimativa |
|-----------|:---:|
| Design review / alinhamento com Produto sobre premissas (§4 do PRD) | 4h |
| Setup de infra (CI, ambientes de staging, docker-compose local) | 6h |
| Code review (ao longo de todo o desenvolvimento) | ~15% do tempo de dev ≈ 26h |
| QA manual exploratório antes do rollout | 8h |
| Rollout gradual + monitoramento pós-deploy | 8h |
| Documentação (runbook, README, ADRs) | 6h |

**Subtotal processo:** ~58h (~7 dias)

---

## 4. Resumo total

| Categoria | Horas | Dias úteis (8h) |
|-----------|:---:|:---:|
| Requisitos Funcionais | ~113h | ~14 dias |
| Requisitos Não Funcionais | ~63h | ~8 dias |
| Atividades de processo | ~58h | ~7 dias |
| **Total** | **~234h** | **~29 dias úteis** |

Com 1 backend + 1 frontend trabalhando em paralelo (frontend só depende dos contratos de API, que
saem cedo no RF1–RF2), o calendário real fica em torno de **5–6 semanas corridas**, considerando
que RF7 (frontend, ~29h) roda em paralelo à maior parte do backend depois que os endpoints
principais (RF2, RF4.3) estão com contrato definido.

**Maior risco de estouro de estimativa:** RF4 (busca com p99<200ms sob carga) e RF6.2 (rate
limiter global) — ambos têm complexidade "Alta" porque dependem de calibração empírica sob carga
real, não só de implementação; é comum esse tipo de item levar 1.5–2x a estimativa inicial na
primeira rodada de testes de carga.

**O que eu cortaria primeiro se o prazo apertar:** RF7.4 (tela de acompanhamento do dispatch) e
RNF7 (alertas automatizados) — ambos são "nice to have" que não bloqueiam o funcionamento correto
do sistema, só a visibilidade operacional dele.
