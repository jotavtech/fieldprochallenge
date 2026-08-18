# Perguntas e premissas

O que eu levaria a Produto/Tech Lead antes da primeira linha de código, a premissa que assumi para
não ficar bloqueado, e o que muda no desenho se ela estiver errada.

| # | Pergunta | Premissa | Se estiver errada |
|---|---|---|---|
| 1 | Intervalo entre ondas: fixo ou proporcional ao tempo até o início? | Proporcional, com piso: `max(2min, tempo_restante / ondas_restantes)`; sem espaço, as ondas colapsam. | Fixo simplifica o agendador, mas vaga postada <1h antes nunca chega à onda 3. |
| 2 | O cap de 3/dia é só deste fluxo ou global da plataforma? | Global: soma todo push do dia para aquele operador. | Só deste fluxo simplifica a contagem e aumenta a fadiga — o problema que originou o projeto. |
| 3 | Quem bateu o cap é pulado ou espera o dia seguinte? | Pulado; vaga urgente não espera até amanhã. | Fila de espera exige um job de retry no reset do cap: outro componente, outro modo de falha. |
| 4 | Existe horário de silêncio, mesmo para urgente? | Não existe: a urgência é sobre tempo até o início. | Adiar por fuso colide com o intervalo curto entre ondas; as duas regras têm que ser priorizadas juntas. |
| 5 | Edição invalida ondas já disparadas ou só as futuras? | Só as futuras: a versão fica registrada no agendamento e versão diferente aborta a onda. | Invalidar retroativamente exige um evento de "correção", separado da notificação normal. |
| 6 | Onda 2 tem janela de tempo ou histórico completo? | Últimos 12 meses. | Histórico completo encarece a query e traz gente desligada há anos: piora conversão e fadiga juntas. |
| 7 | Raio da onda 3: fixo ou por densidade de operadores? | Fixo por região (10km), com um único fallback de expansão. | Dinâmico exige pré-cálculo de densidade: mais peça móvel, ganho incerto na fase 1. |
| 8 | Cap por dia de calendário ou janela deslizante de 24h? | Dia de calendário **no fuso do operador** — são dois países, e o dia do servidor não é o dia de ninguém. | Janela deslizante muda a contagem e elimina o pico da meia-noite, mas é mais difícil de explicar ao operador. |
| 9 | Vaga confirmada da qual o operador desiste volta a `aberta`? | Não modelei retorno: `confirmada` é terminal nesta fase. | `aberta` deixa de ser estado só de entrada e o dispatch precisa retomar de onde parou: muda a máquina de estados, não uma coluna. |

**Duas coisas que li como informação, não como erro de digitação.** Sair da busca "no mesmo commit"
que muda o status é impossível ao pé da letra entre Postgres e Redis, que não compartilham
transação: trato como mesmo caminho de código, com o 409 do aceite como rede de segurança
(`DECISOES.md`). E "intervalo curto" (req. 1) compete com "3 notificações/dia" (req. 3) pelo mesmo
operador no pico de segunda — quem vence é o cap, porque fadiga degrada todas as vagas seguintes.
Isso é decisão de produto, não de engenharia; se Produto discordar, muda a premissa 2.
