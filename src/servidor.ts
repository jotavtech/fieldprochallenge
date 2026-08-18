// Núcleo da aceitação de vaga — requisito 2 do enunciado ("primeiro que aceita, leva").
// É o único endpoint implementado; o desenho do resto está em DECISOES.md.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import pg from 'pg';

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://fieldpro:fieldpro@localhost:5432/fieldpro',
  // Folgado de propósito: o teste dispara 100 aceitações simultâneas e a contenção
  // que interessa é a da LINHA da vaga, não a da fila de conexões do pool.
  max: Number(process.env.PG_POOL_MAX ?? 50),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const app = express();
app.use(express.json());

app.post('/vagas/:id/aceitar', async (req: Request, res: Response) => {
  const vagaId = String(req.params.id); // nos tipos do Express 5, params pode ser string[]
  const operadorId = (req.body as { operador_id?: unknown } | undefined)?.operador_id;
  if (!UUID.test(vagaId) || typeof operadorId !== 'string' || !UUID.test(operadorId)) {
    return res.status(400).json({ erro: 'vaga e operador precisam ser uuid' });
  }

  // A GARANTIA DO REQUISITO 2, inteira, é esta instrução.
  //
  // O Postgres serializa UPDATEs concorrentes na MESMA linha: o primeiro a pegar o lock
  // escreve; os outros ficam bloqueados e, quando o lock sai, reavaliam o WHERE contra a
  // versão nova da linha (EvalPlanQual, em READ COMMITTED). Como `status` já não é mais
  // 'aberta', o predicado falha e eles saem com rowCount = 0 — sem escrever nada.
  //
  // Uma instrução, autocommit, sem transação explícita, sem SELECT ... FOR UPDATE (que
  // custaria um round-trip a mais) e sem lock em Redis (que seria um segundo sistema
  // precisando estar correto para a garantia valer).
  const { rows } = await pool.query(
    `UPDATE vagas
        SET status = 'confirmada', operador_id = $1, atualizada_em = now()
      WHERE id = $2 AND status = 'aberta'
      RETURNING id, status, operador_id, atualizada_em`,
    [operadorId, vagaId],
  );

  if (rows.length === 1) return res.status(200).json(rows[0]);

  // rowCount = 0: ou a vaga não existe, ou alguém chegou primeiro. A leitura extra só
  // acontece no caminho de conflito — o caminho de sucesso continua com uma query só.
  const { rows: atual } = await pool.query<{ status: string }>(
    `SELECT status FROM vagas WHERE id = $1`,
    [vagaId],
  );
  if (atual.length === 0) return res.status(404).json({ erro: 'vaga inexistente' });
  return res.status(409).json({ erro: 'essa vaga já foi preenchida', status: atual[0].status });
});

app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // 23503 = violação de FK: operador_id que não existe. É erro do cliente, não do servidor.
  if (typeof erro === 'object' && erro !== null && (erro as { code?: string }).code === '23503') {
    return res.status(400).json({ erro: 'operador inexistente' });
  }
  console.error(erro);
  res.status(500).json({ erro: 'erro interno' });
});

// Importar este arquivo no teste não deve subir servidor.
if (process.argv[1]?.endsWith('servidor.ts')) {
  const porta = Number(process.env.PORT ?? 3000);
  app.listen(porta, () => console.log(`ouvindo em http://localhost:${porta}`));
}
