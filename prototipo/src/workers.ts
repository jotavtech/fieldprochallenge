// Workers das duas filas. Sao processos separados do HTTP por design (podem escalar
// horizontalmente), mas o servidor sobe eles no mesmo processo em dev (INICIAR_WORKERS=1).
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { conexaoFila } from './redis.ts';
import { cfg } from './config.ts';
import type { JobOnda, JobPush } from './filas.ts';
import { dispararOnda } from './ondas.ts';
import { q } from './db.ts';
import { removerVaga } from './geoindex.ts';
import { inc, log } from './log.ts';

function criarWorkerOndas() {
  const w = new Worker<JobOnda>(
    'ondas',
    async (job: Job<JobOnda>) => dispararOnda(job.data.vagaId, job.data.numero),
    { connection: conexaoFila, concurrency: 5 },
  );
  w.on('failed', (job, err) =>
    log('onda.erro', { vaga_id: job?.data.vagaId, onda: job?.data.numero, erro: err.message }),
  );
  return w;
}

function criarWorkerPush() {
  const w = new Worker<JobPush>(
    'push',
    async (job: Job<JobPush>) => {
      const { notificacaoId, push_token, titulo, corpo, vagaId } = job.data;

      const resposta = await fetch(cfg.pushUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ push_token, titulo, corpo, dados: { vaga_id: vagaId } }),
      });

      // 429/5xx sao transitorios: relanca e deixa o backoff exponencial com jitter agir (RF6).
      if (resposta.status === 429 || resposta.status >= 500) {
        inc(resposta.status === 429 ? 'push_429' : 'push_5xx');
        await q(`UPDATE notificacoes SET tentativas = tentativas + 1, atualizada_em = now() WHERE id = $1`, [notificacaoId]);
        throw new Error(`provider respondeu ${resposta.status}`);
      }

      // 4xx nao-429 e permanente (token invalido, payload rejeitado): repetir so gasta quota.
      if (!resposta.ok) {
        await q(
          `UPDATE notificacoes SET status = 'falhou', tentativas = tentativas + 1, atualizada_em = now() WHERE id = $1`,
          [notificacaoId],
        );
        inc('push_falhados');
        log('push.rejeitado', { notificacao_id: notificacaoId, http: resposta.status });
        return;
      }

      const { message_id } = (await resposta.json()) as { message_id: string };
      await q(
        `UPDATE notificacoes
         SET status = 'enviada', provider_message_id = $2, tentativas = tentativas + 1, atualizada_em = now()
         WHERE id = $1`,
        [notificacaoId, message_id],
      );
      inc('push_enviados');
    },
    {
      connection: conexaoFila,
      concurrency: 50,
      // RF6: teto de 600 req/s no provider. O limiter do BullMQ e global no Redis —
      // vale para a soma de todos os workers, que e exatamente o requisito
      // ("nao por-vaga"), inclusive no pico de segunda 8h-10h com varios dispatches juntos.
      limiter: { max: cfg.pushRps, duration: 1000 },
      settings: {
        // backoff exponencial + jitter (full jitter): sem o jitter, todas as notificacoes
        // de uma onda que tomou 429 voltam ao provider no mesmo milissegundo.
        backoffStrategy: (tentativas: number) =>
          Math.round(cfg.pushBackoffMs * 2 ** (tentativas - 1) * (0.5 + Math.random())),
      },
    },
  );

  w.on('failed', async (job, err) => {
    if (!job) return;
    // Estourou o teto de tentativas: marca falhou e segue — uma notificacao nao trava a onda.
    if (job.attemptsMade >= (job.opts.attempts ?? cfg.pushTentativas)) {
      await q(`UPDATE notificacoes SET status = 'falhou', atualizada_em = now() WHERE id = $1`, [
        job.data.notificacaoId,
      ]);
      inc('push_falhados');
      log('push.falhou', { notificacao_id: job.data.notificacaoId, tentativas: job.attemptsMade, erro: err.message });
    }
  });
  return w;
}

/**
 * Expiracao: vaga aberta cujo horario ja passou sai da busca (§7.4 cita confirmacao,
 * cancelamento e expiracao como os tres gatilhos de invalidacao do indice).
 * ponytail: setInterval no worker, nao um scheduler. O UPDATE e condicional, entao
 * N processos rodando isso ao mesmo tempo nao se atrapalham.
 */
function iniciarExpiracao() {
  const varrer = async () => {
    const { rows } = await q<{ id: string }>(
      `UPDATE vagas SET status = 'expirada', atualizada_em = now()
       WHERE status = 'aberta' AND data_inicio <= now() RETURNING id`,
    );
    for (const v of rows) {
      await removerVaga(v.id);
      log('vaga.expirada', { vaga_id: v.id });
    }
  };
  varrer().catch((e) => log('expiracao.erro', { erro: String(e) }));
  return setInterval(() => varrer().catch((e) => log('expiracao.erro', { erro: String(e) })), 60_000);
}

export function iniciarWorkers() {
  const ondas = criarWorkerOndas();
  const push = criarWorkerPush();
  const timer = iniciarExpiracao();
  log('workers.iniciados', { push_rps: cfg.pushRps });
  return async () => {
    clearInterval(timer);
    await Promise.all([ondas.close(), push.close()]);
  };
}
