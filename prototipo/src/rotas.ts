import { Router } from 'express';
import { z } from 'zod';
import { q } from './db.ts';
import type { Vaga } from './db.ts';
import { cfg } from './config.ts';
import { redis } from './redis.ts';
import { buscarVagas, ehUrgente, indexarVaga, removerVaga } from './geoindex.ts';
import { abortarOndasPendentes, agendarOndas, replanejarOndasPendentes } from './ondas.ts';
import { assinaturaValida } from './assinatura.ts';
import { contadores, inc, log } from './log.ts';

export const rotas = Router();

// ---------------------------------------------------------------- catalogos (UI mockada)
rotas.get('/locais', async (_req, res) => {
  const { rows } = await q(`SELECT id, nome, timezone FROM locais ORDER BY nome`);
  res.json(rows);
});

rotas.get('/operadores', async (req, res) => {
  const f = z
    .object({
      especialidade: z.string().optional(),
      limite: z.coerce.number().int().positive().max(500).default(50),
    })
    .parse(req.query);
  const { rows } = await q(
    `SELECT id, nome, especialidades, latitude, longitude, timezone FROM operadores
     WHERE ativo AND ($1::text IS NULL OR $1 = ANY(especialidades))
     ORDER BY nome LIMIT $2`,
    [f.especialidade ?? null, f.limite],
  );
  res.json(rows);
});

// ---------------------------------------------------------------- publicar vaga (RF1)
const esquemaVaga = z.object({
  local_id: z.string().uuid(),
  especialidade: z.string().min(1),
  endereco: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // horario de parede no fuso da vaga (ex. "2026-08-18T08:00") — quem converte e o Postgres.
  data_inicio_local: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
  timezone: z.string().min(1),
  duracao_minutos: z.number().int().positive(),
  valor_centavos: z.number().int().positive(),
});

rotas.post('/vagas', async (req, res) => {
  const dados = esquemaVaga.parse(req.body);
  const { rows } = await q<Vaga & { local_nome: string }>(
    `WITH nova AS (
       INSERT INTO vagas (local_id, especialidade, endereco, latitude, longitude,
                          data_inicio, duracao_minutos, valor_centavos, timezone)
       VALUES ($1, $2, $3, $4, $5, ($6::timestamp AT TIME ZONE $9), $7, $8, $9)
       RETURNING *
     )
     SELECT nova.*, l.nome AS local_nome FROM nova JOIN locais l ON l.id = nova.local_id`,
    [
      dados.local_id,
      dados.especialidade,
      dados.endereco,
      dados.latitude,
      dados.longitude,
      dados.data_inicio_local,
      dados.duracao_minutos,
      dados.valor_centavos,
      dados.timezone,
    ],
  );
  const vaga = rows[0];
  await indexarVaga(vaga, vaga.local_nome);

  const urgente = ehUrgente(new Date(vaga.data_inicio));
  if (urgente) await agendarOndas(vaga);
  log('vaga.criada', { vaga_id: vaga.id, urgente, data_inicio: vaga.data_inicio });

  res.status(201).json({ ...vaga, urgente });
});

// ---------------------------------------------------------------- editar / cancelar (RF5)
// local_id continua obrigatorio na edicao: RNF9 exige que um local so mexa nas vagas dele.
// Com autenticacao de verdade isso viria do middleware; aqui vem do corpo, mas a checagem
// acontece no mesmo UPDATE — nao num SELECT antes, que seria janela de corrida.
const esquemaEdicao = esquemaVaga.partial().omit({ timezone: true }).required({ local_id: true });

/** Diagnostico do 0-rows: existe? e de outro local? ou so nao esta mais aberta? */
async function motivoDaRecusa(vagaId: string, localId: string) {
  const { rows } = await q<{ status: string; local_id: string }>(
    `SELECT status, local_id FROM vagas WHERE id = $1`,
    [vagaId],
  );
  if (rows.length === 0) return { http: 404, erro: 'vaga inexistente' };
  if (rows[0].local_id !== localId) return { http: 403, erro: 'vaga pertence a outro local' };
  return { http: 409, erro: `vaga esta ${rows[0].status}`, status: rows[0].status };
}

rotas.patch('/vagas/:id', async (req, res) => {
  const d = esquemaEdicao.parse(req.body);
  const { rows } = await q<Vaga & { local_nome: string }>(
    `WITH alterada AS (
       UPDATE vagas SET
         especialidade   = coalesce($2, especialidade),
         endereco        = coalesce($3, endereco),
         latitude        = coalesce($4, latitude),
         longitude       = coalesce($5, longitude),
         data_inicio     = coalesce(($6::timestamp AT TIME ZONE timezone), data_inicio),
         duracao_minutos = coalesce($7, duracao_minutos),
         valor_centavos  = coalesce($8, valor_centavos),
         versao          = versao + 1,
         atualizada_em   = now()
       WHERE id = $1 AND local_id = $9 AND status = 'aberta'
       RETURNING *
     )
     SELECT alterada.*, l.nome AS local_nome FROM alterada JOIN locais l ON l.id = alterada.local_id`,
    [
      req.params.id,
      d.especialidade ?? null,
      d.endereco ?? null,
      d.latitude ?? null,
      d.longitude ?? null,
      d.data_inicio_local ?? null,
      d.duracao_minutos ?? null,
      d.valor_centavos ?? null,
      d.local_id,
    ],
  );
  if (rows.length === 0) {
    const motivo = await motivoDaRecusa(req.params.id, d.local_id);
    return res.status(motivo.http).json({ erro: motivo.erro });
  }

  const vaga = rows[0];
  await indexarVaga(vaga, vaga.local_nome);
  // Ondas ja disparadas nao voltam atras; as pendentes passam a valer a versao nova (§7.3).
  await replanejarOndasPendentes(vaga);
  log('vaga.editada', { vaga_id: vaga.id, versao: vaga.versao });
  res.json(vaga);
});

rotas.post('/vagas/:id/cancelar', async (req, res) => {
  const { local_id } = z.object({ local_id: z.string().uuid() }).parse(req.body);
  const { rows } = await q<Vaga>(
    `UPDATE vagas SET status = 'cancelada', versao = versao + 1, atualizada_em = now()
     WHERE id = $1 AND local_id = $2 AND status = 'aberta' RETURNING *`,
    [req.params.id, local_id],
  );
  if (rows.length === 0) {
    const motivo = await motivoDaRecusa(req.params.id, local_id);
    return res.status(motivo.http).json({ erro: motivo.erro });
  }

  await removerVaga(rows[0].id);
  await abortarOndasPendentes(rows[0].id, 'vaga_cancelada');
  log('vaga.cancelada', { vaga_id: rows[0].id });
  res.json(rows[0]);
});

// ---------------------------------------------------------------- aceitar (RF2)
rotas.post('/vagas/:id/aceitar', async (req, res) => {
  const { operador_id } = z.object({ operador_id: z.string().uuid() }).parse(req.body);

  // O coracao do RF2. UPDATE condicional atomico: o Postgres serializa os concorrentes
  // na mesma linha e so um sai com rowCount = 1. Sem SELECT ... FOR UPDATE, sem transacao
  // explicita, sem lock em Redis. O JOIN com operadores adiciona a checagem de
  // elegibilidade DENTRO da mesma instrucao — checar antes seria uma janela de corrida.
  const { rows } = await q<Vaga>(
    `UPDATE vagas v
     SET status = 'confirmada', operador_id = o.id, atualizada_em = now()
     FROM operadores o
     WHERE v.id = $1
       AND v.status = 'aberta'
       AND o.id = $2
       AND o.ativo
       AND v.especialidade = ANY(o.especialidades)
     RETURNING v.*`,
    [req.params.id, operador_id],
  );

  if (rows.length === 0) {
    inc('aceites_409');
    const { rows: atual } = await q<{ status: string }>(`SELECT status FROM vagas WHERE id = $1`, [
      req.params.id,
    ]);
    log('vaga.aceite_conflito', { vaga_id: req.params.id, operador_id, status: atual[0]?.status });
    return res.status(409).json({
      erro:
        atual.length === 0
          ? 'vaga inexistente'
          : atual[0].status === 'aberta'
            ? 'operador nao elegivel para esta vaga'
            : 'essa vaga ja foi preenchida',
      status: atual[0]?.status ?? 'inexistente',
    });
  }

  // Some da busca no mesmo caminho da confirmacao (§7.4) e mata as ondas que faltavam (§7.3).
  await removerVaga(req.params.id);
  await abortarOndasPendentes(req.params.id, 'vaga_confirmada');
  inc('aceites_ok');
  log('vaga.confirmada', { vaga_id: req.params.id, operador_id });
  res.json(rows[0]);
});

// ---------------------------------------------------------------- busca (RF4)
const esquemaBusca = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  raio_km: z.coerce.number().positive().max(100).default(10),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  especialidade: z.string().optional(),
  valor_min: z.coerce.number().int().optional(),
  valor_max: z.coerce.number().int().optional(),
  limite: z.coerce.number().int().positive().max(200).default(50),
});

rotas.get('/vagas/perto-de-mim', async (req, res) => {
  const f = esquemaBusca.parse(req.query);
  res.json(await buscarVagas(f));
});

// ---------------------------------------------------------------- detalhe e acompanhamento
rotas.get('/vagas/:id', async (req, res) => {
  const { rows } = await q(
    `SELECT v.*, l.nome AS local_nome FROM vagas v JOIN locais l ON l.id = v.local_id WHERE v.id = $1`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'vaga inexistente' });
  res.json({ ...rows[0], urgente: ehUrgente(new Date(rows[0].data_inicio)) });
});

rotas.get('/locais/:id/vagas', async (req, res) => {
  const { rows } = await q(
    `SELECT * FROM vagas WHERE local_id = $1 ORDER BY criada_em DESC LIMIT 50`,
    [req.params.id],
  );
  res.json(rows);
});

// §8.4: quantos operadores cada onda alcancou, e em que estado ela esta.
rotas.get('/vagas/:id/dispatch', async (req, res) => {
  const { rows } = await q(
    `SELECT d.numero_onda, d.status, d.disparar_em, d.disparada_em,
            d.versao_vaga_no_agendamento,
            count(n.id)                                      AS notificados,
            count(n.id) FILTER (WHERE n.status = 'entregue') AS entregues,
            count(n.id) FILTER (WHERE n.status = 'falhou')   AS falhas
     FROM dispatch_ondas d
     LEFT JOIN notificacoes n ON n.onda_id = d.id
     WHERE d.vaga_id = $1
     GROUP BY d.id ORDER BY d.numero_onda`,
    [req.params.id],
  );
  res.json(rows);
});

// ---------------------------------------------------------------- webhook do provider (RF6)
rotas.post('/webhooks/push', async (req, res) => {
  // RNF10: endpoint publico que muda estado — so aceita callback assinado pelo provider.
  if (cfg.webhookSegredo) {
    const bruto = (req as typeof req & { corpoBruto?: Buffer }).corpoBruto ?? Buffer.alloc(0);
    if (!assinaturaValida(bruto, req.header('x-assinatura'), cfg.webhookSegredo)) {
      log('webhook.assinatura_invalida', { ip: req.ip });
      return res.status(401).json({ erro: 'assinatura invalida' });
    }
  }

  const { provider_message_id, evento } = z
    .object({
      provider_message_id: z.string().min(1),
      evento: z.enum(['entregue', 'falhou']),
    })
    .parse(req.body);

  // Idempotencia por estado terminal: reentrega do mesmo evento (ou de um evento antigo
  // depois de um terminal) nao muda nada. Mesmo padrao condicional do RF2.
  const { rowCount } = await q(
    `UPDATE notificacoes SET status = $2, atualizada_em = now()
     WHERE provider_message_id = $1 AND status NOT IN ('entregue', 'falhou')`,
    [provider_message_id, evento],
  );
  // `tipo` e nao `evento`: o campo `evento` do log estruturado ja e o nome do proprio log.
  log('webhook.recebido', { provider_message_id, tipo: evento, aplicado: rowCount === 1 });
  res.json({ ok: true, aplicado: rowCount === 1 });
});

// ---------------------------------------------------------------- observabilidade (§10)
rotas.get('/metricas', async (_req, res) => {
  // Staleness do indice: vagas que sairam do "aberta" no Postgres mas continuam
  // aparecendo na busca. E o numero que prova (ou derruba) a garantia do RF4.
  const { rows } = await q<{ id: string }>(
    `SELECT id FROM vagas WHERE status <> 'aberta' AND atualizada_em > now() - interval '10 minutes'`,
  );
  const scores = rows.length
    ? await redis.zmscore('vagas:geo', ...rows.map((r) => r.id))
    : [];
  const vazadas = scores.filter((s) => s !== null).length;

  const { rows: agregados } = await q(
    `SELECT
       count(*) FILTER (WHERE status = 'aberta')     AS vagas_abertas,
       count(*) FILTER (WHERE status = 'confirmada') AS vagas_confirmadas,
       count(*) FILTER (WHERE status = 'cancelada')  AS vagas_canceladas
     FROM vagas`,
  );

  res.json({ ...contadores, ...agregados[0], indice_stale: vazadas, verificadas: rows.length });
});
