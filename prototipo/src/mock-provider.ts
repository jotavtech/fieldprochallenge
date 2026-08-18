// NAO faz parte do produto: e o dublê do provider de push externo, para dar pra exercitar
// rate limit, 429/5xx com backoff e webhook de entrega sem depender de fornecedor real.
import { Router } from 'express';
import { cfg } from './config.ts';
import { assinar } from './assinatura.ts';
import { log } from './log.ts';

export const mockProvider = Router();
let sequencia = 0;

mockProvider.post('/mock-provider/push', (req, res) => {
  const sorte = Math.random();
  if (sorte < cfg.mockTaxa429) return res.status(429).json({ erro: 'rate limit excedido' });
  if (sorte < cfg.mockTaxa429 + cfg.mockTaxa5xx) return res.status(503).json({ erro: 'indisponivel' });

  const message_id = `msg_${Date.now().toString(36)}_${sequencia++}`;
  res.status(202).json({ message_id });

  // Callback assincrono de entrega. Manda o MESMO evento duas vezes de proposito:
  // o webhook precisa ser idempotente porque o provider reentrega (RF6).
  const evento = Math.random() < 0.97 ? 'entregue' : 'falhou';
  const corpo = JSON.stringify({ provider_message_id: message_id, evento });
  const entregar = () =>
    fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // provider real assina o callback; o mock imita isso (RNF10)
        ...(cfg.webhookSegredo ? { 'x-assinatura': assinar(corpo, cfg.webhookSegredo) } : {}),
      },
      body: corpo,
    }).catch((e) => log('mock.webhook_erro', { erro: String(e) }));

  setTimeout(entregar, 200 + Math.random() * 800).unref();
  setTimeout(entregar, 1500 + Math.random() * 1000).unref();
});
