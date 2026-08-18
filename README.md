# FieldPro — núcleo da aceitação de vaga

Desafio técnico. O enunciado pede um pedaço funcionando, não o sistema: aqui está
`POST /vagas/{id}/aceitar` com a garantia de que **nunca existem dois operadores confirmados na
mesma vaga**, provada por teste de concorrência real.

## Rodar

Um comando (precisa de Docker e Node ≥ 22.18):

```bash
npm install && npm test
```

`pretest` sobe o Postgres (`docker compose up -d --wait`) e aplica `db/schema.sql`; o teste dispara
**100 requisições HTTP simultâneas** contra o servidor e o banco reais, em 5 rodadas independentes.

```
✔ 100 aceitações simultâneas na mesma vaga: exatamente uma vence
✔ 5 rodadas independentes: nunca dois confirmados
✔ vaga já confirmada: 409 e o dono original não muda
✔ vaga inexistente: 404, sem 500
```

Para subir só a API: `npm start` (porta 3000).

## O que está aqui

| Arquivo | |
|---|---|
| [DECISOES.md](./DECISOES.md) | o desenho: modelo de dados, a garantia do requisito 2, ondas, provider de push, plano de latência e o que ficou fora |
| [PERGUNTAS-E-PREMISSAS.md](./PERGUNTAS-E-PREMISSAS.md) | o que eu perguntaria antes da primeira linha, e o que assumi para não travar |
| [IA.md](./IA.md) | registro completo dos prompts, o que a IA propôs e eu rejeitei, e o que deixei passar |
| `src/servidor.ts` | o endpoint — o `UPDATE` condicional é a garantia inteira |
| `test/aceitar.test.ts` | a prova de concorrência |
| `db/schema.sql` | só as tabelas que a aceitação toca |
| `docs/` | documentos de origem (PRD, spec e estimativas) |
| `prototipo/` | **anexo, não entrega**: o spike do sistema completo que produziu os números citados |

O resto do sistema — ondas, push, busca geoespacial, frontend, autenticação — está desenhado em
`DECISOES.md` e **fora da entrega**, como o enunciado pede. O porquê da priorização está na seção
"Fora de escopo".

## Sobre `prototipo/`

Antes de escolher o que entregar, implementei o desenho inteiro para poder medir em vez de supor:
é de lá que vêm o `p99 = 70ms a 500 req/s` e o comportamento das ondas descritos em `DECISOES.md`.
Deixei versionado em vez de descartar porque número medido sem código que o produza é só afirmação.

**A entrega é a raiz do repositório** — `src/`, `test/`, `db/` e os quatro documentos. O
`prototipo/` tem projeto, dependências e `docker compose` próprios, não é tocado pelo CI e não faz
parte do `npm test` daqui. Para rodá-lo: `cd prototipo && cat README.md`. O front correspondente
está em [jotavtech/fieldpro-frontend-prototipo](https://github.com/jotavtech/fieldpro-frontend-prototipo).
