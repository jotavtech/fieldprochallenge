import { Queue } from 'bullmq';
import { conexaoFila } from './redis.ts';
import { cfg } from './config.ts';

export type JobOnda = { vagaId: string; numero: number };
export type JobPush = {
  notificacaoId: string;
  operadorId: string;
  vagaId: string;
  push_token: string;
  titulo: string;
  corpo: string;
};

// Uma onda = um job com delay (§7.3). jobId deterministico para poder remover/reagendar.
export const filaOndas = new Queue<JobOnda>('ondas', { connection: conexaoFila });

// Fila de saida do push. O rate limit de 600 rps vive no Worker desta fila e e
// global no Redis: vale para todos os workers somados, nao por processo e nao por vaga (RF6).
export const filaPush = new Queue<JobPush>('push', { connection: conexaoFila });

export const idJobOnda = (vagaId: string, numero: number) => `onda:${vagaId}:${numero}`;

export const opcoesPush = {
  attempts: cfg.pushTentativas,
  backoff: { type: 'custom' as const },
  removeOnComplete: 1000,
  removeOnFail: 1000,
};

export async function fecharFilas() {
  await Promise.all([filaOndas.close(), filaPush.close()]);
}
