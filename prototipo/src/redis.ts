import { Redis } from 'ioredis';
import { cfg } from './config.ts';

// Conexao de uso geral (geoindex, leituras da busca).
export const redis = new Redis(cfg.redisUrl);

// BullMQ exige maxRetriesPerRequest: null na conexao dele; nao da pra reaproveitar a de cima.
export const conexaoFila = { url: cfg.redisUrl, maxRetriesPerRequest: null } as const;

export async function fecharRedis() {
  await redis.quit();
}
