// Prova do requisito 2: concorrência REAL (100 requisições HTTP simultâneas contra o
// servidor de verdade e o Postgres de verdade), não simulada por mock.
//
// Rode com: npm test  — o `pretest` sobe o Postgres e aplica o schema.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { app, pool } from '../src/servidor.ts';

const CONCORRENTES = 100;
const RODADAS = 5;

const servidor = app.listen(0);
const base = `http://localhost:${(servidor.address() as AddressInfo).port}`;

async function criarVaga() {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO vagas (data_inicio, valor_centavos)
     VALUES (now() + interval '3 hours', 15000) RETURNING id`,
  );
  return rows[0].id;
}

async function criarOperadores(quantidade: number) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO operadores (nome)
     SELECT 'operador ' || i FROM generate_series(1, $1) AS i RETURNING id`,
    [quantidade],
  );
  return rows.map((o) => o.id);
}

const aceitar = (vagaId: string, operadorId: string) =>
  fetch(`${base}/vagas/${vagaId}/aceitar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operador_id: operadorId }),
  });

test(`${CONCORRENTES} aceitações simultâneas na mesma vaga: exatamente uma vence`, async () => {
  const vagaId = await criarVaga();
  const operadores = await criarOperadores(CONCORRENTES);

  // Todas as requisições são disparadas no mesmo tick, sem await entre elas:
  // é o Promise.all que garante que a corrida acontece de verdade.
  const respostas = await Promise.all(operadores.map((id) => aceitar(vagaId, id)));
  const status = respostas.map((r) => r.status);

  assert.equal(status.filter((s) => s === 200).length, 1, 'exatamente uma requisição pode dar 200');
  assert.equal(status.filter((s) => s === 409).length, CONCORRENTES - 1, 'todas as outras: 409');
  assert.equal(new Set(status).size, 2, 'nenhum outro status pode aparecer (nem 500)');

  const vencedor = (await respostas[status.indexOf(200)].json()) as { operador_id: string };
  const { rows } = await pool.query<{ status: string; operador_id: string }>(
    `SELECT status, operador_id FROM vagas WHERE id = $1`,
    [vagaId],
  );
  assert.equal(rows[0].status, 'confirmada');
  assert.equal(rows[0].operador_id, vencedor.operador_id, 'o banco confirma quem recebeu 200');
});

test(`${RODADAS} rodadas independentes: nunca dois confirmados`, async () => {
  // Uma rodada passar pode ser sorte de escalonamento. Cinco vagas diferentes, com os
  // mesmos 100 operadores brigando em cada uma, é o que descarta a sorte.
  const operadores = await criarOperadores(CONCORRENTES);

  for (let rodada = 1; rodada <= RODADAS; rodada++) {
    const vagaId = await criarVaga();
    const respostas = await Promise.all(operadores.map((id) => aceitar(vagaId, id)));
    const vencedores = respostas.filter((r) => r.status === 200);
    assert.equal(vencedores.length, 1, `rodada ${rodada}: mais de um vencedor`);
  }

  // Nenhuma vaga do banco pode estar confirmada sem dono ou com dono sem confirmação
  // (a CHECK constraint garante estruturalmente; aqui é a verificação de ponta a ponta).
  const { rows } = await pool.query<{ incoerentes: string }>(
    `SELECT count(*) AS incoerentes FROM vagas
      WHERE (status = 'confirmada') <> (operador_id IS NOT NULL)`,
  );
  assert.equal(Number(rows[0].incoerentes), 0);
});

test('vaga já confirmada: 409 e o dono original não muda', async () => {
  const vagaId = await criarVaga();
  const [primeiro, segundo] = await criarOperadores(2);

  const ok = await aceitar(vagaId, primeiro);
  assert.equal(ok.status, 200);

  const tarde = await aceitar(vagaId, segundo);
  assert.equal(tarde.status, 409);
  assert.equal(((await tarde.json()) as { status: string }).status, 'confirmada');

  const { rows } = await pool.query<{ operador_id: string }>(
    `SELECT operador_id FROM vagas WHERE id = $1`,
    [vagaId],
  );
  assert.equal(rows[0].operador_id, primeiro, 'a segunda tentativa não sobrescreveu o dono');
});

test('vaga inexistente: 404, sem 500', async () => {
  const [operador] = await criarOperadores(1);
  const r = await aceitar('00000000-0000-4000-8000-000000000000', operador);
  assert.equal(r.status, 404);
});

after(async () => {
  servidor.close();
  await pool.end();
});
