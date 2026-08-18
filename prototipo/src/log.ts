// PRD §10: log estruturado. Uma linha JSON por evento, que e o que qualquer coletor
// (Datadog, Loki, CloudWatch) ja sabe ler — nao precisa de biblioteca pra isso.
export function log(evento: string, dados: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), evento, ...dados }));
}

// Contadores em memoria expostos em GET /metricas (§10). Em producao isso vira um
// counter do Prometheus/OTel; a semantica dos nomes e a mesma.
export const contadores: Record<string, number> = {
  aceites_ok: 0,
  aceites_409: 0,
  push_enviados: 0,
  push_429: 0,
  push_5xx: 0,
  push_falhados: 0,
  ondas_disparadas: 0,
  ondas_abortadas: 0,
  notificacoes_bloqueadas_por_cap: 0,
};

export const inc = (chave: keyof typeof contadores | string, n = 1) => {
  contadores[chave] = (contadores[chave] ?? 0) + n;
};
