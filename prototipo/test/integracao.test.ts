// Testes de integracao: sobem o app de verdade contra o Postgres e o Redis do
// docker compose. Cobrem as garantias que o PRD chama de nao-negociaveis —
// exclusividade do aceite (RF2), cap diario (RF3), invalidacao do indice (RF4),
// versionamento de onda (RF5) e idempotencia do webhook (RF6).
//
// Pre-requisito: `docker compose up -d && npm run db:migrate`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { app } from '../src/server.ts';
import { pool, q } from '../src/db.ts';
import type { Vaga } from '../src/db.ts';
import { redis } from '../src/redis.ts';
import { cfg } from '../src/config.ts';
import { assinar } from '../src/assinatura.ts';
import { fecharFilas } from '../src/filas.ts';
import { indexarVaga, removerVaga } from '../src/geoindex.ts';
import {
  candidatosDaOnda,
  dispararOnda,
  filtrarElegiveis,
  replanejarOndasPendentes,
} from '../src/ondas.ts';

const servidor = app.listen(0);
const base = `http://localhost:${(servidor.address() as AddressInfo).port}`;
const MARCA = `teste-${process.pid}`;
const vagasIndexadas: string[] = [];

async function criarLocal() {
  const { rows } = await q<{ id: string }>(
    `INSERT INTO locais (nome) VALUES ($1) RETURNING id`,
    [`${MARCA} local`],
  );
  return rows[0].id;
}

async function criarOperador(especialidades = ['limpeza'], ativo = true) {
  const { rows } = await q<{ id: string }>(
    `INSERT INTO operadores (nome, especialidades, latitude, longitude, ativo, push_token)
     VALUES ($1, $2, -23.55, -46.63, $3, 'tok') RETURNING id`,
    [`${MARCA} op`, especialidades, ativo],
  );
  return rows[0].id;
}

async function criarVaga(localId: string, minutosAte = 60, especialidade = 'limpeza') {
  const { rows } = await q<Vaga>(
    `INSERT INTO vagas (local_id, especialidade, endereco, latitude, longitude, data_inicio,
                        duracao_minutos, valor_centavos, timezone)
     VALUES ($1, $2, $3, -23.55, -46.63, now() + ($4 || ' minutes')::interval,
             240, 15000, 'America/Sao_Paulo')
     RETURNING *`,
    [localId, especialidade, `${MARCA} endereco`, String(minutosAte)],
  );
  return rows[0];
}

async function criarOnda(vagaId: string, numero: number, versao: number) {
  const { rows } = await q<{ id: string }>(
    `INSERT INTO dispatch_ondas (vaga_id, numero_onda, versao_vaga_no_agendamento, disparar_em)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [vagaId, numero, versao],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------- RF2
// Spec Req. 2.5 / RF2.2: concorrencia REAL (100 requisicoes HTTP simultaneas), nao mock.
test('RF2: 100 aceites HTTP simultaneos, exatamente um vence', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local);
  const operadores = await Promise.all(Array.from({ length: 100 }, () => criarOperador()));

  const respostas = await Promise.all(
    operadores.map((id) =>
      fetch(`${base}/vagas/${vaga.id}/aceitar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operador_id: id }),
      }),
    ),
  );

  const ok = respostas.filter((r) => r.status === 200);
  const conflito = respostas.filter((r) => r.status === 409);
  assert.equal(ok.length, 1, 'exatamente um aceite pode dar 200');
  assert.equal(conflito.length, 99, 'todos os outros tem que receber 409');

  const vencedor = (await ok[0].json()) as Vaga;
  const { rows } = await q<Vaga>(`SELECT * FROM vagas WHERE id = $1`, [vaga.id]);
  assert.equal(rows[0].status, 'confirmada');
  assert.equal(rows[0].operador_id, vencedor.operador_id);
});

test('RF2: operador sem a especialidade da vaga nao consegue aceitar', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local, 60, 'seguranca');
  const operador = await criarOperador(['limpeza']);

  const r = await fetch(`${base}/vagas/${vaga.id}/aceitar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operador_id: operador }),
  });
  assert.equal(r.status, 409);
  const { rows } = await q<Vaga>(`SELECT status FROM vagas WHERE id = $1`, [vaga.id]);
  assert.equal(rows[0].status, 'aberta', 'a vaga continua disponivel para quem e elegivel');
});

// ---------------------------------------------------------------- RF4
test('RF4: confirmar a vaga tira ela da busca no mesmo caminho', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local);
  const operador = await criarOperador();
  await indexarVaga(vaga, 'local de teste');
  vagasIndexadas.push(vaga.id);

  const antes = await fetch(`${base}/vagas/perto-de-mim?latitude=-23.55&longitude=-46.63&raio_km=1&limite=200`);
  const listaAntes = (await antes.json()) as { id: string }[];
  assert.ok(listaAntes.some((v) => v.id === vaga.id), 'vaga aberta aparece na busca');

  await fetch(`${base}/vagas/${vaga.id}/aceitar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operador_id: operador }),
  });

  assert.equal(await redis.zscore('vagas:geo', vaga.id), null, 'saiu do geoindex');
  const depois = await fetch(`${base}/vagas/perto-de-mim?latitude=-23.55&longitude=-46.63&raio_km=1&limite=200`);
  const listaDepois = (await depois.json()) as { id: string }[];
  assert.ok(!listaDepois.some((v) => v.id === vaga.id), 'vaga confirmada some da busca');
});

// ---------------------------------------------------------------- RF3
test('RF3: operador que bateu o cap do dia e cortado antes do envio', async () => {
  const local = await criarLocal();
  const noCap = await criarOperador();
  const livre = await criarOperador();

  // 3 notificacoes hoje = cap cheio (uma por vaga: o UNIQUE (vaga_id, operador_id) impede repetir)
  for (let i = 0; i < 3; i++) {
    const outra = await criarVaga(local);
    const onda = await criarOnda(outra.id, 1, 1);
    await q(`INSERT INTO notificacoes (vaga_id, onda_id, operador_id) VALUES ($1, $2, $3)`, [
      outra.id,
      onda,
      noCap,
    ]);
  }

  const vaga = await criarVaga(local);
  const elegiveis = await filtrarElegiveis(vaga, [noCap, livre]);
  assert.deepEqual(elegiveis, [livre], 'so o operador abaixo do cap sobra');
});

test('RF3: operador inativo ou sem token nao e destinatario', async () => {
  const local = await criarLocal();
  const inativo = await criarOperador(['limpeza'], false);
  const vaga = await criarVaga(local);
  assert.deepEqual(await filtrarElegiveis(vaga, [inativo]), []);
});

// ---------------------------------------------------------------- RF1
test('RF1: onda 1 = favoritos, onda 2 = historico dentro da janela de 12 meses', async () => {
  const local = await criarLocal();
  const favorito = await criarOperador();
  const recente = await criarOperador();
  const antigo = await criarOperador();
  const vaga = await criarVaga(local);

  await q(`INSERT INTO operador_favoritos (local_id, operador_id) VALUES ($1, $2)`, [local, favorito]);
  await q(
    `INSERT INTO operador_historico_local (local_id, operador_id, ultima_vez_trabalhou)
     VALUES ($1, $2, now() - interval '3 months'), ($1, $3, now() - interval '14 months')`,
    [local, recente, antigo],
  );

  assert.deepEqual(await candidatosDaOnda(vaga, 1), [favorito]);
  const onda2 = await candidatosDaOnda(vaga, 2);
  assert.ok(onda2.includes(recente), 'quem trabalhou ha 3 meses entra na onda 2');
  assert.ok(!onda2.includes(antigo), 'quem trabalhou ha 14 meses fica de fora (premissa #6)');
});

// ---------------------------------------------------------------- RF5
test('RF5: onda agendada com versao velha aborta sem notificar ninguem', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local);
  const favorito = await criarOperador();
  await q(`INSERT INTO operador_favoritos (local_id, operador_id) VALUES ($1, $2)`, [local, favorito]);
  await criarOnda(vaga.id, 1, vaga.versao);

  // simula a corrida: a vaga e editada depois que o job da onda ja estava em voo
  await q(`UPDATE vagas SET versao = versao + 1 WHERE id = $1`, [vaga.id]);
  await dispararOnda(vaga.id, 1);

  const { rows } = await q<{ status: string }>(
    `SELECT status FROM dispatch_ondas WHERE vaga_id = $1 AND numero_onda = 1`,
    [vaga.id],
  );
  assert.equal(rows[0].status, 'abortada');
  const { rows: notif } = await q(`SELECT 1 FROM notificacoes WHERE vaga_id = $1`, [vaga.id]);
  assert.equal(notif.length, 0, 'onda invalidada nao manda push');
});

test('RF5: cancelar a vaga invalida a onda pendente', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local);
  await criarOnda(vaga.id, 2, vaga.versao);

  const r = await fetch(`${base}/vagas/${vaga.id}/cancelar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local_id: local }),
  });
  assert.equal(r.status, 200);

  const { rows } = await q<{ status: string }>(
    `SELECT status FROM dispatch_ondas WHERE vaga_id = $1 AND numero_onda = 2`,
    [vaga.id],
  );
  assert.equal(rows[0].status, 'abortada');

  // e mesmo que um job atrasado escape e rode assim mesmo, o disparo se auto-invalida
  await dispararOnda(vaga.id, 2);
  const { rows: notif } = await q(`SELECT 1 FROM notificacoes WHERE vaga_id = $1`, [vaga.id]);
  assert.equal(notif.length, 0);
});

test('RF5: editar replaneja as ondas pendentes com a versao nova', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local, 60);
  await criarOnda(vaga.id, 2, vaga.versao);
  await criarOnda(vaga.id, 3, vaga.versao);
  await q(`UPDATE dispatch_ondas SET status = 'concluida' WHERE vaga_id = $1 AND numero_onda = 3`, [vaga.id]);

  const editada = { ...vaga, versao: vaga.versao + 1 };
  await replanejarOndasPendentes(editada);

  const { rows } = await q<{ numero_onda: number; status: string; versao_vaga_no_agendamento: number; disparar_em: Date }>(
    `SELECT * FROM dispatch_ondas WHERE vaga_id = $1 ORDER BY numero_onda`,
    [vaga.id],
  );
  const onda2 = rows.find((o) => o.numero_onda === 2)!;
  const onda3 = rows.find((o) => o.numero_onda === 3)!;
  assert.equal(onda2.versao_vaga_no_agendamento, 2, 'a pendente passa a valer a versao nova');
  assert.ok(onda2.disparar_em.getTime() > Date.now(), 'e continua no futuro');
  assert.equal(onda3.versao_vaga_no_agendamento, 1, 'onda ja concluida nao e reescrita');
});

// ---------------------------------------------------------------- RF6
test('RF6: webhook do provider e idempotente', async () => {
  const local = await criarLocal();
  const vaga = await criarVaga(local);
  const onda = await criarOnda(vaga.id, 1, vaga.versao);
  const operador = await criarOperador();
  const msgId = `msg-${MARCA}`;
  await q(
    `INSERT INTO notificacoes (vaga_id, onda_id, operador_id, status, provider_message_id)
     VALUES ($1, $2, $3, 'enviada', $4)`,
    [vaga.id, onda, operador, msgId],
  );

  const entregar = async (evento: string, assinado = true) => {
    const corpo = JSON.stringify({ provider_message_id: msgId, evento });
    const r = await fetch(`${base}/webhooks/push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(assinado && cfg.webhookSegredo
          ? { 'x-assinatura': assinar(corpo, cfg.webhookSegredo) }
          : {}),
      },
      body: corpo,
    });
    return { http: r.status, ...((await r.json()) as { aplicado?: boolean }) };
  };

  assert.equal((await entregar('entregue')).aplicado, true);
  assert.equal((await entregar('entregue')).aplicado, false, 'reentrega do mesmo evento nao reaplica');
  assert.equal((await entregar('falhou')).aplicado, false, 'estado terminal nao regride');

  const { rows } = await q<{ status: string }>(`SELECT status FROM notificacoes WHERE provider_message_id = $1`, [msgId]);
  assert.equal(rows[0].status, 'entregue');
});

// ---------------------------------------------------------------- RNF9 / RNF10
test('RNF10: webhook sem assinatura valida e recusado', async (t) => {
  if (!cfg.webhookSegredo) return t.skip('WEBHOOK_SEGREDO nao configurado');
  const r = await fetch(`${base}/webhooks/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider_message_id: 'qualquer', evento: 'entregue' }),
  });
  assert.equal(r.status, 401);
});

test('RNF9: local nao edita nem cancela vaga de outro local', async () => {
  const dono = await criarLocal();
  const intruso = await criarLocal();
  const vaga = await criarVaga(dono);

  const edicao = await fetch(`${base}/vagas/${vaga.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local_id: intruso, valor_centavos: 1 }),
  });
  assert.equal(edicao.status, 403);

  const cancelamento = await fetch(`${base}/vagas/${vaga.id}/cancelar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ local_id: intruso }),
  });
  assert.equal(cancelamento.status, 403);

  const { rows } = await q<{ status: string; valor_centavos: number }>(
    `SELECT status, valor_centavos FROM vagas WHERE id = $1`,
    [vaga.id],
  );
  assert.equal(rows[0].status, 'aberta', 'nada foi alterado');
  assert.equal(rows[0].valor_centavos, 15000);
});

after(async () => {
  const marca = `${MARCA}%`;
  for (const id of vagasIndexadas) await removerVaga(id);
  await q(`DELETE FROM vagas WHERE endereco LIKE $1`, [marca]); // cascata leva ondas e notificacoes
  await q(`DELETE FROM operador_favoritos WHERE operador_id IN (SELECT id FROM operadores WHERE nome LIKE $1)`, [marca]);
  await q(`DELETE FROM operador_historico_local WHERE operador_id IN (SELECT id FROM operadores WHERE nome LIKE $1)`, [marca]);
  await q(`DELETE FROM notificacoes WHERE operador_id IN (SELECT id FROM operadores WHERE nome LIKE $1)`, [marca]);
  await q(`DELETE FROM operadores WHERE nome LIKE $1`, [marca]);
  await q(`DELETE FROM locais WHERE nome LIKE $1`, [marca]);
  servidor.close();
  await Promise.all([pool.end(), fecharFilas(), redis.quit()]);
});
