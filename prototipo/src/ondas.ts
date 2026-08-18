// Nucleo do PRD: RF1 (dispatch em ondas), RF3 (anti-spam) e RF5 (invalidacao por versao).
import { q } from './db.ts';
import type { Vaga } from './db.ts';
import { cfg } from './config.ts';
import { filaOndas, filaPush, idJobOnda, opcoesPush } from './filas.ts';
import { operadoresNoRaio } from './geoindex.ts';
import { planejarOndas } from './plano.ts';
import { inc, log } from './log.ts';

export { planejarOndas };

/** Agenda as ondas de uma vaga recem-criada: linha no banco + job com delay na fila. */
export async function agendarOndas(vaga: Vaga, agora = new Date()) {
  const plano = planejarOndas(agora, new Date(vaga.data_inicio));
  for (const onda of plano) {
    await q(
      `INSERT INTO dispatch_ondas (vaga_id, numero_onda, versao_vaga_no_agendamento, disparar_em)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (vaga_id, numero_onda) DO UPDATE
         SET status = 'agendada',
             versao_vaga_no_agendamento = EXCLUDED.versao_vaga_no_agendamento,
             disparar_em = EXCLUDED.disparar_em
         WHERE dispatch_ondas.status = 'agendada'`,
      [vaga.id, onda.numero, vaga.versao, onda.disparar_em],
    );
    await enfileirarOnda(vaga.id, onda.numero, Math.max(0, onda.disparar_em.getTime() - Date.now()));
    log('onda.agendada', {
      vaga_id: vaga.id,
      onda: onda.numero,
      versao: vaga.versao,
      disparar_em: onda.disparar_em.toISOString(),
    });
  }
}

async function enfileirarOnda(vagaId: string, numero: number, delay: number) {
  const jobId = idJobOnda(vagaId, numero);
  await filaOndas.remove(jobId).catch(() => {}); // reagendamento: o job antigo pode existir
  await filaOndas.add('onda', { vagaId, numero }, { jobId, delay, removeOnComplete: true, removeOnFail: 500 });
}

/**
 * RF5 / premissa #5: edicao relevante nao desfaz onda ja disparada — ela re-planeja as futuras
 * com a versao nova. As ondas ainda pendentes sao redistribuidas no tempo que sobrou.
 */
export async function replanejarOndasPendentes(vaga: Vaga, agora = new Date()) {
  const { rows: pendentes } = await q<{ numero_onda: number }>(
    `SELECT numero_onda FROM dispatch_ondas
     WHERE vaga_id = $1 AND status = 'agendada' ORDER BY numero_onda`,
    [vaga.id],
  );
  if (pendentes.length === 0) return;

  // planeja n+1 ondas e descarta o primeiro slot (que seria "agora"): as ondas pendentes
  // continuam sendo futuro, so que redistribuidas ate o novo data_inicio.
  const slots = planejarOndas(agora, new Date(vaga.data_inicio), pendentes.length + 1).slice(1);

  for (let i = 0; i < pendentes.length; i++) {
    const numero = pendentes[i].numero_onda;
    const disparar_em = slots[i].disparar_em;
    await q(
      `UPDATE dispatch_ondas
       SET versao_vaga_no_agendamento = $3, disparar_em = $4
       WHERE vaga_id = $1 AND numero_onda = $2 AND status = 'agendada'`,
      [vaga.id, numero, vaga.versao, disparar_em],
    );
    await enfileirarOnda(vaga.id, numero, Math.max(0, disparar_em.getTime() - Date.now()));
    log('onda.replanejada', { vaga_id: vaga.id, onda: numero, versao: vaga.versao, disparar_em });
  }
}

/** Confirmacao (RF2) e cancelamento (RF5) matam o que ainda nao disparou. */
export async function abortarOndasPendentes(vagaId: string, motivo: string) {
  const { rows } = await q<{ numero_onda: number }>(
    `UPDATE dispatch_ondas SET status = 'abortada'
     WHERE vaga_id = $1 AND status = 'agendada' RETURNING numero_onda`,
    [vagaId],
  );
  for (const r of rows) {
    await filaOndas.remove(idJobOnda(vagaId, r.numero_onda)).catch(() => {});
    inc('ondas_abortadas');
    log('onda.abortada', { vaga_id: vagaId, onda: r.numero_onda, motivo });
  }
}

/** RF1: quem entra em cada onda, antes de qualquer filtro de elegibilidade. */
export async function candidatosDaOnda(vaga: Vaga, numero: number): Promise<string[]> {
  if (numero === 1) {
    const { rows } = await q<{ operador_id: string }>(
      `SELECT operador_id FROM operador_favoritos WHERE local_id = $1`,
      [vaga.local_id],
    );
    return rows.map((r) => r.operador_id);
  }

  if (numero === 2) {
    const { rows } = await q<{ operador_id: string }>(
      `SELECT operador_id FROM operador_historico_local
       WHERE local_id = $1 AND ultima_vez_trabalhou >= now() - ($2 || ' months')::interval`,
      [vaga.local_id, String(cfg.historicoMeses)],
    );
    return rows.map((r) => r.operador_id);
  }

  // Onda 3: raio conservador primeiro; se nao achou ninguem, um unico fallback de
  // expansao (premissa #7) — em vez de um job extra, porque e a mesma pergunta com raio maior.
  const perto = await operadoresNoRaio(vaga.latitude, vaga.longitude, cfg.raioPadraoKm);
  if (perto.length > 0) return perto;
  log('onda3.raio_expandido', { vaga_id: vaga.id, de: cfg.raioPadraoKm, para: cfg.raioExpansaoKm });
  return operadoresNoRaio(vaga.latitude, vaga.longitude, cfg.raioExpansaoKm);
}

/**
 * RF3: corta quem ja bateu o cap ANTES do envio, nao depois de uma tentativa falha.
 * O corte do dia usa o fuso do operador (§7.6), nao o do servidor.
 * Tambem exige especialidade compativel — um favorito que nao faz o servico nao e destinatario.
 */
export async function filtrarElegiveis(vaga: Vaga, candidatos: string[]): Promise<string[]> {
  if (candidatos.length === 0) return [];
  const { rows } = await q<{ id: string; no_cap: boolean }>(
    `SELECT o.id,
            (SELECT count(*) FROM notificacoes n
              WHERE n.operador_id = o.id
                AND n.criada_em >= date_trunc('day', now() AT TIME ZONE o.timezone) AT TIME ZONE o.timezone
            ) >= $3 AS no_cap
     FROM operadores o
     WHERE o.id = ANY($1::uuid[])
       AND o.ativo
       AND o.push_token IS NOT NULL
       AND $2 = ANY(o.especialidades)`,
    [candidatos, vaga.especialidade, cfg.capNotificacoesDia],
  );
  const bloqueados = rows.filter((r) => r.no_cap).length;
  if (bloqueados) inc('notificacoes_bloqueadas_por_cap', bloqueados);
  return rows.filter((r) => !r.no_cap).map((r) => r.id);
}

/**
 * Disparo de uma onda (§7.3). Roda no worker; e o unico lugar que decide enviar push.
 * Idempotente de ponta a ponta: o claim da onda e condicional e o INSERT das
 * notificacoes tem ON CONFLICT DO NOTHING.
 */
export async function dispararOnda(vagaId: string, numero: number) {
  const { rows: ondas } = await q(
    `SELECT * FROM dispatch_ondas WHERE vaga_id = $1 AND numero_onda = $2`,
    [vagaId, numero],
  );
  const onda = ondas[0];
  if (!onda || onda.status !== 'agendada') return;

  const { rows: vagas } = await q<Vaga & { local_nome: string }>(
    `SELECT v.*, l.nome AS local_nome FROM vagas v JOIN locais l ON l.id = v.local_id WHERE v.id = $1`,
    [vagaId],
  );
  const vaga = vagas[0];

  // A revalidacao que substitui varrer a fila no cancelamento/edicao: a onda se auto-invalida.
  if (!vaga || vaga.status !== 'aberta' || vaga.versao !== onda.versao_vaga_no_agendamento) {
    await q(`UPDATE dispatch_ondas SET status = 'abortada' WHERE id = $1 AND status = 'agendada'`, [
      onda.id,
    ]);
    inc('ondas_abortadas');
    log('onda.abortada', {
      vaga_id: vagaId,
      onda: numero,
      motivo: !vaga
        ? 'vaga_inexistente'
        : vaga.status !== 'aberta'
          ? `status_${vaga.status}`
          : 'versao_mudou',
      versao_agendada: onda.versao_vaga_no_agendamento,
      versao_atual: vaga?.versao,
    });
    return;
  }

  const claim = await q(
    `UPDATE dispatch_ondas SET status = 'disparando', disparada_em = now()
     WHERE id = $1 AND status = 'agendada'`,
    [onda.id],
  );
  if (claim.rowCount === 0) return; // outro worker pegou a mesma onda

  const candidatos = await candidatosDaOnda(vaga, numero);
  const elegiveis = await filtrarElegiveis(vaga, candidatos);

  const { rows: novas } = await q<{ id: string; operador_id: string }>(
    `INSERT INTO notificacoes (vaga_id, onda_id, operador_id)
     SELECT $1, $2, unnest($3::uuid[])
     ON CONFLICT (vaga_id, operador_id) DO NOTHING
     RETURNING id, operador_id`,
    [vaga.id, onda.id, elegiveis],
  );

  await enfileirarPushes(vaga, vaga.local_nome, novas);
  await q(`UPDATE dispatch_ondas SET status = 'concluida' WHERE id = $1`, [onda.id]);

  inc('ondas_disparadas');
  log('onda.disparada', {
    vaga_id: vaga.id,
    onda: numero,
    versao: vaga.versao,
    candidatos: candidatos.length,
    elegiveis: elegiveis.length,
    notificados: novas.length,
  });
}

async function enfileirarPushes(
  vaga: Vaga,
  localNome: string,
  destinos: { id: string; operador_id: string }[],
) {
  if (destinos.length === 0) return;
  const { rows: tokens } = await q<{ id: string; push_token: string }>(
    `SELECT id, push_token FROM operadores WHERE id = ANY($1::uuid[])`,
    [destinos.map((d) => d.operador_id)],
  );
  const porOperador = new Map(tokens.map((t) => [t.id, t.push_token]));
  const valor = (vaga.valor_centavos / 100).toFixed(2);

  await filaPush.addBulk(
    destinos.map((d) => ({
      name: 'push',
      data: {
        notificacaoId: d.id,
        operadorId: d.operador_id,
        vagaId: vaga.id,
        push_token: porOperador.get(d.operador_id)!,
        titulo: `Vaga urgente: ${vaga.especialidade}`,
        corpo: `${localNome} — R$ ${valor} — ${vaga.endereco}`,
      },
      opts: opcoesPush,
    })),
  );
}
