# Registro de uso de IA

## Ferramenta

**Claude Code (Opus 5)** — uma só, do começo ao fim: leitura do enunciado, desenho, código, testes,
medição de carga e escrita dos documentos. Rodou com o plugin `ponytail` ligado, que enviesa as
respostas para a solução mais simples que funciona (stdlib antes de biblioteca, recurso nativo
antes de dependência, menor diff). Isso explica escolhas visíveis na entrega: sem `tsx`, sem
`dotenv`, sem framework de teste — Node 22+ roda TypeScript direto e tem `node:test` embutido.

Não usei uma segunda ferramenta, então não há etapa para separar.

---

## Registro dos prompts, na ordem

### 1
```
git@github.com:jotavtech/fieldprochallenge.git
```
Clone do repositório (SSH falhou nesta máquina, saiu por HTTPS). Repositório vazio, sem commits.

### 2
```
npm i autocannon -g
```
Ferramenta de carga para o requisito 4. Falhou com `EACCES` em `/usr/lib/node_modules`; em vez de
`sudo`, movi o prefixo global do npm para `~/.local`, que já está no `PATH`.

### 3
```
PRD — Dispatch em Ondas para Vagas Urgentes (FieldPro)
[PRD completo — está em docs/PRD-FieldPro-Dispatch-Ondas.md, no repositório]
os arquivos devem ser criados exatamente como esta descrito no PRD acima,
documentando todos os prompts do processo.
```
Aqui eu mandei implementar o PRD inteiro: modelo de dados, dispatch em ondas com fila e agendamento
por versão, integração com provider de push (rate limit global, retry com jitter, webhook
idempotente), busca geoespacial em Redis, frontend React com 4 telas, 18 testes e benchmark. Tudo
foi construído e verificado rodando — Postgres e Redis em Docker, não mock.

### 4
```
adicione estes dois arquivos ao projeto por favor
```
Sem anexo. A IA avisou que nada tinha chegado e seguiu o trabalho em vez de travar esperando.

### 5
```
/home/jota/Downloads/SPEC-FieldPro-Dispatch-Ondas.md
/home/jota/Downloads/Requisitos-e-Estimativas-FieldPro.md
```
Os arquivos do prompt anterior: o spec em formato Spec-Driven Development (critérios de aceite em
notação EARS) e as estimativas de esforço. Pedi que fossem confrontados com o que já existia; a
auditoria achou três lacunas, corrigidas na hora — o teste de concorrência tinha 20 requisições e o
spec exige no mínimo 100; `PATCH`/`cancelar` não verificavam se a vaga era do local que pedia; o
webhook não validava assinatura.

### 6
```
adicione estes dois arquivos ao projeto por favor
```
De novo sem anexo. A IA vasculhou `~/Downloads`, achou os dois arquivos FieldPro que ainda não
estavam no repositório (o PRD original e **`Desafio-Tecnico-Backend.pdf`**) e começou a ler o PDF.

### 7
```
Este repositório ainda não tem nenhum commit. Preciso que você:
1. CONFIRME A IDENTIDADE ANTES DE QUALQUER COISA (git config, gh auth status, remote)
2. USE OS OUTROS REPOS DE jotavtech COMO REFERÊNCIA DE PADRÃO (commits e CI/CD)
3. ORGANIZE OS ARQUIVOS (os dois documentos em /docs)
4. CI/CD (replique o padrão, rode localmente antes de commitar)
5. COMMIT (primeiro commit, mensagem bem explicada, sem --no-verify)
6. PUSH (branch correta, confirmar URL e CI disparado)
[instrução completa, com a regra: se a identidade não puder ser confirmada, PARE e pergunte]
```
Identidade confirmada (`gh` autenticado como `jotavtech`, remote sob `github.com/jotavtech`),
`user.name`/`user.email` configurados **só neste repositório**. Padrão dos meus outros repos
(`Portfolio2026`, `Cynthia`, `dashmeboard`): Conventional Commits com escopo e
`.github/workflows/ci.yml` com job `quality`.

### 8
```
é a entrega do desafio, mas nao deve existir no codigo nada que nao esteja pedindo
no PRD que eu enviei e nem neste documento /home/jota/Downloads/Desafio-Tecnico-Backend.pdf
```
O corte. Detalhado na seção seguinte.

---

## O que a IA propôs e eu rejeitei

**1. Rejeitei o sistema inteiro como entrega.** É o caso mais concreto que tenho, e o mais caro: a
IA construiu, a meu pedido, ondas, push, busca geoespacial, frontend e 18 testes — tudo
funcionando, tudo verificado contra infraestrutura real. Quando ela leu o `Desafio-Tecnico-Backend.pdf`
e apontou que o enunciado pede **um pedaço só** ("não queremos ver ondas, push, filtros geográficos
ou autenticação em código"), a decisão de cortar foi minha: joguei fora ~35 arquivos que passavam
nos testes e reduzi o repositório ao núcleo da aceitação. O trabalho não foi inútil — ele é a razão
de `DECISOES.md` falar de agendamento, colapso de ondas e rate limit global com números medidos em
vez de intenção. Mas entregar aquilo seria responder a um enunciado que ninguém escreveu.

**2. Rejeitei o `JOIN operadores` dentro do UPDATE de aceitação.** A IA propôs (e implementou)
checar elegibilidade — operador ativo e com especialidade compatível — dentro da mesma instrução
atômica. O argumento técnico dela estava certo: checar antes, num `SELECT` separado, abriria a
janela de corrida que o requisito 2 existe para fechar. Tirei mesmo assim: autorização está
declarada fora de escopo pelo enunciado, e o único código que eu entrego tem que ser exatamente o
que prova o requisito 2. Menos superfície para o avaliador ler é parte da resposta.

**3. Rejeitei a marcação das tasks no documento que recebi.** A IA marcou os checkboxes do spec e
inseriu uma tabela de rastreabilidade dentro dele. Documento recebido não se reescreve — a
rastreabilidade tem que viver em documento meu, não no de outra pessoa.

**4. Rejeitei `sudo npm i -g` e commit sem confirmação de identidade.** Coisas pequenas, mas ambas
mudam estado fora do projeto: a primeira virou prefixo do npm em `~/.local`; a segunda virou
`git config` local, com o `--global` intocado.

---

## O que a IA errou e o teste pegou

Registro porque é o argumento de por que testar código gerado por IA não é opcional:

- **Piso do intervalo entre ondas violado.** A primeira versão do agendador fazia
  `t = min(t + intervalo, limite)`. O clamp no limite gerava intervalo **menor que o piso de 2
  minutos** — com 6 minutos úteis e piso de 5, saía `[0, 5, 6]`: a onda 3 um minuto depois da onda
  2, que é exatamente a fadiga de notificação que o projeto existe para evitar. O teste do piso
  pegou; a correção (colapsar as restantes quando a próxima não cabe) deixou o código menor.
- **Teste "puro" travando o processo.** O teste do cálculo de ondas não tocava banco, mas importava
  um módulo que criava a fila do BullMQ — abria conexão com Redis e o processo nunca terminava.
  Separei o cálculo num módulo sem efeito colateral.
- **`text[][]` no seed.** Postgres exige matriz retangular; cada operador tinha 1 ou 2
  especialidades. Falhou com `malformed array literal`.

Nenhum dos três apareceria em revisão de código lendo o diff. Os três apareceram na primeira
execução.

---

## O que eu deixei passar

- **O `pretest` depende de Docker e do healthcheck do Compose.** `npm test` sobe o Postgres, espera
  ficar saudável e aplica o schema. Não testei em máquina sem Docker nem no Windows. Risco
  aceitável: o enunciado pede um comando, e o comando pressupõe Docker como o próprio enunciado
  sugere.
- **`pool.max = 50` para 100 requisições simultâneas.** Metade das requisições espera conexão. Não
  medi se 100 conexões mudariam o resultado, porque a contenção que a prova exige é a da **linha**
  da vaga, e ela acontece igual. Aceito o risco de o número ser mais estético que necessário.
- **`String(req.params.id)`.** Os tipos do Express 5 declaram `params` como `string | string[]`.
  Contornei sem investigar a fundo a razão; o regex de UUID logo em seguida fecha o buraco.
- **O `p99 = 70ms` citado em `DECISOES.md`** veio de um spike local, com dados sintéticos, numa
  máquina só, com Postgres e Redis em container ao lado do processo. Não é número de produção e
  está citado como indicativo do desenho, não como SLA comprovado.
- **A mensagem de erro 400 não distingue** UUID inválido de corpo ausente. Vi e deixei: não vale
  código a mais no único arquivo que o avaliador vai ler com atenção.
- **No material descartado** (mock do provider, seed, taxas de 429/5xx) não revisei nada a fundo.
  Não estava no caminho da entrega e foi para fora do repositório junto com o resto.
