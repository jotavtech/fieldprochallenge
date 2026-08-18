# API do protótipo — dispatch em ondas

Implementação completa do PRD de dispatch em ondas: vaga urgente (< 24h de antecedência) deixa de
ser um push simultâneo para todo mundo e vira **três ondas progressivas** que param assim que
alguém aceita.

**Isto é protótipo, não a entrega do desafio.** O enunciado pede que apenas o núcleo da aceitação
vá em código — essa entrega está em
[jotavtech/fieldprochallenge](https://github.com/jotavtech/fieldprochallenge), junto com o desenho
(`DECISOES.md`), as premissas e o registro de uso de IA. Aqui está o sistema inteiro, que serviu
para validar o desenho com números medidos em vez de intenção.

## Rodar

Precisa de Docker e Node ≥ 22.18 (o projeto roda TypeScript por type stripping nativo — **não tem
build step**).

```bash
cp .env.example .env
docker compose up -d        # postgres + redis
npm install
npm run db:migrate
npm run seed                # 20 locais, 2000 operadores, 800 vagas (São Paulo e Lisboa)
npm start                   # API + workers na porta 3000
```

Com a API no ar, o front (raiz deste repositório) sobe com `npm run dev` e já aponta para a 3000.

Roteiro de defesa ponta a ponta em ~20s:

```bash
npm run seed && ./demo.sh   # reseed antes: o cap de 3/dia é por dia, e uma segunda
                            # execução seguida zera as ondas (corretamente) por cota esgotada
```

Testes e carga:

```bash
npm test          # 18 testes (precisa do docker compose de pé)
npm run test:unit # só os testes puros do plano de ondas
npm run bench     # autocannon: 500 req/s em GET /vagas/perto-de-mim
npm run typecheck
```

## Resultados medidos

| Requisito | Alvo | Medido |
|---|---|---|
| Busca "perto de mim" | p99 < 200ms a 500 req/s | **p99 = 70ms**, p50 = 11ms, 10.000/10.000 respostas 200, 500 req/s por 20s |
| Aceite exclusivo | exatamente 1 vencedor | **100 aceites HTTP simultâneos → 1× 200, 99× 409** |
| Staleness do índice | 0 | `GET /metricas` → `indice_stale: 0` após confirmar/cancelar |
| Cap de 3/dia | ninguém passa de 3 | 4 vagas urgentes no mesmo ponto → 688 destinatários cortados antes do envio |
| Retry do provider | não perder notificação | mock com 429/5xx em ~7% → `push_429: 13`, `push_5xx: 4`, `push_falhados: 0` |

Números desta máquina, com dados sintéticos e Postgres/Redis em container ao lado do processo:
indicativos do desenho, não SLA de produção.

## Onde cada requisito virou código

| Requisito | Arquivo | Ponto exato |
|---|---|---|
| Ondas por prioridade | `src/ondas.ts` | `candidatosDaOnda()`: favoritos → histórico 12 meses → raio |
| Intervalo entre ondas | `src/plano.ts` | `planejarOndas()`, testado em `test/ondas.test.ts` |
| Aceite exclusivo | `src/rotas.ts` | `POST /vagas/:id/aceitar`, um único UPDATE condicional |
| Anti-spam | `src/ondas.ts` | `filtrarElegiveis()`, contagem no fuso do operador |
| Busca | `src/geoindex.ts` | `buscarVagas()` (GEOSEARCH) e `removerVaga()` (invalidação) |
| Edição/cancelamento | `src/ondas.ts`, `src/rotas.ts` | `replanejarOndasPendentes()`, `abortarOndasPendentes()`, revalidação de versão em `dispararOnda()` |
| Provider de push | `src/workers.ts` | worker com `limiter: 600/s` global + backoff com jitter |
| Webhook idempotente | `src/rotas.ts`, `src/assinatura.ts` | `POST /webhooks/push` com HMAC |
| Observabilidade | `src/log.ts`, `GET /metricas` | log estruturado, contadores e staleness |

## Decisões que valem a defesa

**O aceite é uma instrução SQL só.** O `JOIN operadores` entra na mesma instrução para checar
elegibilidade: checar antes, num SELECT separado, abriria a janela de corrida que o endpoint existe
para fechar. O Postgres serializa os concorrentes na mesma linha e só um sai com `rowCount = 1`.

**Cancelar/editar não varre a fila.** A onda se auto-invalida no disparo comparando
`versao_vaga_no_agendamento` com a versão atual. Remover o job é otimização, não correção — o que
elimina a corrida entre "cancelar" e "remover da fila".

**Rate limit global de graça.** O `limiter` do BullMQ é implementado em Redis e vale para a soma de
todos os workers da fila, que é exatamente o requisito ("não por-vaga"). Rodar `npm run worker` em
N terminais não multiplica o teto de 600 rps.

**Uma notificação por operador por vaga, garantida pelo schema.** `UNIQUE (vaga_id, operador_id)` +
`INSERT ... ON CONFLICT DO NOTHING RETURNING` faz três trabalhos numa instrução: dedupe entre
ondas, idempotência do disparo, e a lista exata de quem precisa de push.

**Sem build step e sem dependência que o Node já resolve.** Node 22+ roda `.ts` direto e traz
`--env-file-if-exists`, `node:test` e `fetch` — não há `tsx`, `dotenv`, `jest` nem `axios` aqui.

## API

| Método | Rota | Para quê |
|---|---|---|
| `POST` | `/vagas` | publica vaga (dispara ondas se urgente) |
| `PATCH` | `/vagas/:id` | edita (bump de versão + replanejamento) — exige `local_id` |
| `POST` | `/vagas/:id/cancelar` | cancela e interrompe ondas — exige `local_id` |
| `POST` | `/vagas/:id/aceitar` | 200 ou 409 |
| `GET` | `/vagas/perto-de-mim` | `latitude`, `longitude`, `raio_km`, `data`, `especialidade`, `valor_min`, `valor_max`, `limite` |
| `GET` | `/vagas/:id` · `/vagas/:id/dispatch` | detalhe e acompanhamento das ondas |
| `GET` | `/locais` · `/locais/:id/vagas` · `/operadores?especialidade&limite` | catálogos da UI |
| `POST` | `/webhooks/push` | callback idempotente do provider, com assinatura HMAC |
| `GET` | `/metricas` | contadores e staleness do índice |
