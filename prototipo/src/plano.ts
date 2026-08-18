// Modulo sem efeito colateral de propósito: so depende de config, entao da pra testar
// o calculo do plano de ondas sem subir Postgres, Redis nem fila.
import { cfg } from './config.ts';

export type OndaPlanejada = { numero: number; disparar_em: Date };

/**
 * Premissa #1 do PRD: intervalo proporcional ao tempo que sobra, com piso.
 *   intervalo = max(INTERVALO_MINIMO, tempo_restante / ondas_restantes)
 *
 * `tempo_restante` conta ate `data_inicio - LEAD_MS`: notificar 30 segundos antes da vaga
 * comecar nao preenche vaga nenhuma, entao a ultima onda tem que caber antes disso.
 *
 * Quando a proxima onda nao cabe (respeitando piso E limite), todas as ondas restantes
 * colapsam no instante atual — que e o caso da vaga publicada faltando pouco tempo:
 * as tres ondas viram um disparo so. O UNIQUE (vaga_id, operador_id) das notificacoes
 * garante que ninguem recebe push duplicado por causa da sobreposicao.
 */
export function planejarOndas(
  agora: Date,
  dataInicio: Date,
  total = cfg.totalOndas,
  intervaloMinimoMs = cfg.intervaloMinimoMs,
  leadMs = cfg.leadMs,
): OndaPlanejada[] {
  const limite = dataInicio.getTime() - leadMs;
  const ondas: OndaPlanejada[] = [];
  let t = agora.getTime();

  for (let n = 1; n <= total; n++) {
    ondas.push({ numero: n, disparar_em: new Date(t) });
    const restantes = total - n;
    if (restantes === 0) break;

    const intervalo = Math.max(intervaloMinimoMs, (limite - t) / restantes);
    if (t + intervalo > limite) {
      for (let m = n + 1; m <= total; m++) ondas.push({ numero: m, disparar_em: new Date(t) });
      break;
    }
    t += intervalo;
  }
  return ondas;
}
