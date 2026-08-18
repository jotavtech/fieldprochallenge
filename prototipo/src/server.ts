import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { cfg } from './config.ts';
import { rotas } from './rotas.ts';
import { mockProvider } from './mock-provider.ts';
import { iniciarWorkers } from './workers.ts';
import { log } from './log.ts';

export const app = express();
// O corpo cru fica guardado para a verificacao de assinatura do webhook (RNF10):
// re-serializar o JSON parseado nao reproduz byte a byte o que foi assinado.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { corpoBruto?: Buffer }).corpoBruto = buf;
    },
  }),
);
app.get('/saude', (_req, res) => res.json({ ok: true }));
app.use(rotas);
app.use(mockProvider);

app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (erro instanceof ZodError) return res.status(400).json({ erro: 'payload invalido', detalhes: erro.issues });

  // 22P02 = "invalid input syntax": id de path que nao e uuid chega ate o Postgres e
  // volta como erro de sintaxe. Isso e entrada invalida do cliente, nao falha do servidor —
  // tratar aqui cobre toda rota com :id de uma vez, em vez de validar em cada uma.
  if (typeof erro === 'object' && erro !== null && (erro as { code?: string }).code === '22P02') {
    return res.status(400).json({ erro: 'identificador invalido' });
  }

  log('http.erro', { erro: String(erro) });
  res.status(500).json({ erro: 'erro interno' });
});

// Importar este arquivo em teste nao deve subir servidor nem worker.
if (process.argv[1]?.endsWith('server.ts')) {
  const pararWorkers = cfg.iniciarWorkers ? iniciarWorkers() : null;
  const servidor = app.listen(cfg.porta, () => log('servidor.ouvindo', { porta: cfg.porta }));

  const desligar = async () => {
    servidor.close();
    if (pararWorkers) await pararWorkers();
    process.exit(0);
  };
  process.on('SIGINT', desligar);
  process.on('SIGTERM', desligar);
}
