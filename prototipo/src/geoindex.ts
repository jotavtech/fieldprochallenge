// PRD §7.4: Postgres e a fonte de verdade; o Redis guarda o indice geoespacial das vagas
// ABERTAS com os campos de filtro redundados na mesma entrada. A busca "perto de mim"
// nunca toca o Postgres no caminho critico — e por isso que p99 < 200ms a 500 req/s cabe.
import { redis } from './redis.ts';
import type { Vaga } from './db.ts';
import { cfg } from './config.ts';

const VAGAS_GEO = 'vagas:geo';
const VAGAS_DOC = 'vagas:doc';
const OPERADORES_GEO = 'operadores:geo';

export type VagaIndexada = {
  id: string;
  local_id: string;
  local_nome: string;
  especialidade: string;
  endereco: string;
  latitude: number;
  longitude: number;
  data_inicio: number; // epoch ms — comparacao de data sem parse de string
  duracao_minutos: number;
  valor_centavos: number;
  timezone: string;
  urgente: boolean;
};

export function ehUrgente(dataInicio: Date, agora = new Date()) {
  return dataInicio.getTime() - agora.getTime() < cfg.urgenteHoras * 3_600_000;
}

/** Insere/atualiza a vaga no indice. Chamado na criacao e em toda edicao. */
export async function indexarVaga(v: Vaga, localNome: string) {
  const doc: VagaIndexada = {
    id: v.id,
    local_id: v.local_id,
    local_nome: localNome,
    especialidade: v.especialidade,
    endereco: v.endereco,
    latitude: Number(v.latitude),
    longitude: Number(v.longitude),
    data_inicio: new Date(v.data_inicio).getTime(),
    duracao_minutos: v.duracao_minutos,
    valor_centavos: v.valor_centavos,
    timezone: v.timezone,
    urgente: ehUrgente(new Date(v.data_inicio)),
  };
  await redis
    .multi()
    .geoadd(VAGAS_GEO, doc.longitude, doc.latitude, v.id)
    .hset(VAGAS_DOC, v.id, JSON.stringify(doc))
    .exec();
}

/**
 * Tira a vaga da busca. Chamado no mesmo caminho que muda o status no Postgres
 * (confirmacao, cancelamento, expiracao) — nao ha TTL nem job de sincronizacao,
 * porque qualquer um dos dois introduziria staleness (§7.4).
 */
export async function removerVaga(vagaId: string) {
  await redis.multi().zrem(VAGAS_GEO, vagaId).hdel(VAGAS_DOC, vagaId).exec();
}

export type FiltrosBusca = {
  latitude: number;
  longitude: number;
  raio_km: number;
  data?: string; // YYYY-MM-DD — vagas que comecam nesse dia (no fuso da vaga)
  especialidade?: string;
  valor_min?: number;
  valor_max?: number;
  limite: number;
};

export async function buscarVagas(f: FiltrosBusca) {
  // ponytail: GEOSEARCH + HMGET = 2 round-trips no Redis (~1ms), nao 1. Da pra colapsar
  // num EVAL Lua se a medicao pedir; nao pede: o orcamento do RF4 e 200ms.
  const proximos = (await redis.geosearch(
    VAGAS_GEO,
    'FROMLONLAT',
    f.longitude,
    f.latitude,
    'BYRADIUS',
    f.raio_km,
    'km',
    'ASC',
    'COUNT',
    f.limite * 5, // folga para os filtros pos-geo sem varrer o pais inteiro
    'WITHDIST',
  )) as [string, string][];

  if (proximos.length === 0) return [];

  const docs = await redis.hmget(VAGAS_DOC, ...proximos.map(([id]) => id));
  const resultado: (VagaIndexada & { distancia_km: number })[] = [];

  for (let i = 0; i < proximos.length; i++) {
    const cru = docs[i];
    if (!cru) continue; // vaga saiu do indice entre o GEOSEARCH e o HMGET — ja nao esta disponivel
    const v: VagaIndexada = JSON.parse(cru);

    if (f.especialidade && v.especialidade !== f.especialidade) continue;
    if (f.valor_min !== undefined && v.valor_centavos < f.valor_min) continue;
    if (f.valor_max !== undefined && v.valor_centavos > f.valor_max) continue;
    if (f.data && diaLocal(v.data_inicio, v.timezone) !== f.data) continue;

    resultado.push({ ...v, distancia_km: Number(proximos[i][1]) });
    if (resultado.length >= f.limite) break;
  }
  return resultado;
}

/** Data (YYYY-MM-DD) do instante no fuso da vaga — §7.6, o servidor nunca impoe o fuso dele. */
export function diaLocal(epochMs: number, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' }).format(
    new Date(epochMs),
  );
}

// --- Operadores: mesma mecanica, usada pela onda 3 (RF1) para achar quem esta no raio da vaga.
export async function indexarOperador(id: string, latitude: number, longitude: number) {
  await redis.geoadd(OPERADORES_GEO, longitude, latitude, id);
}

export async function operadoresNoRaio(latitude: number, longitude: number, raioKm: number) {
  return (await redis.geosearch(
    OPERADORES_GEO,
    'FROMLONLAT',
    longitude,
    latitude,
    'BYRADIUS',
    raioKm,
    'km',
    'ASC',
  )) as string[];
}
