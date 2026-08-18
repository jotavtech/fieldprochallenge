# Perguntas e premissas

Perguntas que eu levaria para Produto/Tech Lead **antes da primeira linha de código**, cada uma com
a premissa que assumi para não ficar bloqueado e o que muda no desenho se ela estiver errada.

| # | Pergunta | Premissa assumida | Se estiver errada |
|---|---|---|---|
| 1 | Intervalo entre ondas é fixo ou proporcional ao tempo até o início? | Proporcional, com piso: `max(2min, tempo_restante / ondas_restantes)`; se não cabe, ondas colapsam. | Fixo simplifica o agendador, mas vaga postada <1h antes nunca chega à onda 3. |
| 2 | O cap de 3/dia é só deste fluxo ou global da plataforma? | Global — soma todo push do dia para aquele operador. | Se for só deste fluxo, a query de contagem simplifica, mas o risco de fadiga sobe (é o problema que originou o projeto). |
| 3 | Quem bateu o cap é pulado ou entra em fila para amanhã? | Pulado. Vaga urgente não espera até amanhã. | Fila exige um job de "retry no reset do cap" — outro componente, com outro modo de falha. |
| 4 | Existe horário de silêncio (madrugada no fuso local), mesmo para urgente? | Não existe: a urgência é sobre tempo até o início. | Precisa de adiamento por fuso, que colide de frente com o intervalo curto entre ondas — as duas regras têm que ser priorizadas juntas. |
| 5 | Edição durante o dispatch invalida ondas já disparadas ou só as futuras? | Só as futuras. A versão da vaga fica registrada no agendamento; ao disparar, versão diferente aborta a onda. | Invalidar retroativamente exige um evento de "correção" separado do dispatch — não é a mesma notificação com outro valor. |
| 6 | "Já trabalhou naquele local" (onda 2) tem janela ou é histórico completo? | Últimos 12 meses. | Histórico completo encarece a query e traz gente desligada há anos — piora conversão e fadiga ao mesmo tempo. |
| 7 | Raio da onda 3 é fixo ou dinâmico por densidade de operadores? | Fixo por país/região, parametrizável, começando conservador (10km) com um único fallback de expansão. | Dinâmico exige pré-cálculo de densidade por região: mais peça móvel, ganho incerto na fase 1. |
| 8 | O cap é por dia de calendário ou janela deslizante de 24h? | Dia de calendário **no fuso do operador** (a plataforma opera em dois países; o dia do servidor não é o dia de ninguém). | Janela deslizante muda a query de contagem e elimina o "pico da meia-noite", mas fica mais difícil de explicar ao operador. |
| 9 | Vaga confirmada que o operador desiste depois volta a `aberta`? O dispatch recomeça? | Não modelei retorno: `confirmada` é terminal nesta fase. | Se voltar, `aberta` deixa de ser um estado só de entrada e o dispatch precisa saber retomar de qual onda parou — muda a máquina de estados, não só uma coluna. |

**Duas coisas que li como informação, não como erro de digitação.** Primeira: o enunciado pede que
a vaga saia da busca "no mesmo commit" que muda o status — impossível ao pé da letra entre Postgres
e Redis, que não compartilham transação; trato como "mesmo caminho de código, logo após o commit",
com o 409 do aceite como rede de segurança (detalhe em `DECISOES.md`). Segunda: o requisito 1 diz
"o intervalo deve ser curto" e o requisito 3 limita a 3 notificações/dia — em pico de segunda-feira
essas duas regras competem pelo mesmo operador, e a que vence é o cap. Isso é decisão de produto,
não de engenharia: **prefiro a vaga não preencher a queimar a atenção do operador**, porque a
fadiga degrada todas as vagas seguintes. Se Produto discordar, é a premissa 2 que muda.
