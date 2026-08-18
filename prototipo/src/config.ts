// Todos os knobs de calibracao num lugar so. Nenhum numero magico espalhado pelo codigo:
// as premissas do §4 do PRD (intervalo, cap, janela de historico, raio) sao exatamente
// os valores que Produto vai querer mexer sem abrir PR.
const num = (chave: string, padrao: number) => Number(process.env[chave] ?? padrao);

export const cfg = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://fieldpro:fieldpro@localhost:5432/fieldpro',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  porta: num('PORT', 3000),
  iniciarWorkers: process.env.INICIAR_WORKERS !== '0',

  urgenteHoras: num('URGENTE_HORAS', 24),
  totalOndas: num('TOTAL_ONDAS', 3),
  intervaloMinimoMs: num('INTERVALO_MINIMO_MS', 120_000),
  leadMs: num('LEAD_MS', 120_000),
  capNotificacoesDia: num('CAP_NOTIFICACOES_DIA', 3),
  historicoMeses: num('HISTORICO_MESES', 12),
  raioPadraoKm: num('RAIO_PADRAO_KM', 10),
  raioExpansaoKm: num('RAIO_EXPANSAO_KM', 25),

  pushUrl: process.env.PUSH_URL ?? 'http://localhost:3000/mock-provider/push',
  pushRps: num('PUSH_RPS', 600),
  pushTentativas: num('PUSH_TENTATIVAS', 5),
  pushBackoffMs: num('PUSH_BACKOFF_MS', 500),

  mockTaxa429: num('MOCK_TAXA_429', 0.05),
  mockTaxa5xx: num('MOCK_TAXA_5XX', 0.02),
  webhookUrl: process.env.WEBHOOK_URL ?? 'http://localhost:3000/webhooks/push',
  // Vazio = verificacao desligada (o endpoint segue funcionando). Definido = obrigatorio.
  webhookSegredo: process.env.WEBHOOK_SEGREDO ?? '',
};
