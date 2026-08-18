import pg from 'pg';
import { cfg } from './config.ts';

// numeric volta como string por padrao no node-pg; latitude/longitude sao numeros aqui.
pg.types.setTypeParser(1700, Number);

export const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 20 });

export async function q<T extends pg.QueryResultRow = any>(texto: string, valores: unknown[] = []) {
  return pool.query<T>(texto, valores);
}

export type Vaga = {
  id: string;
  local_id: string;
  status: 'aberta' | 'confirmada' | 'cancelada' | 'expirada';
  operador_id: string | null;
  especialidade: string;
  endereco: string;
  latitude: number;
  longitude: number;
  data_inicio: Date;
  duracao_minutos: number;
  valor_centavos: number;
  versao: number;
  timezone: string;
  criada_em: Date;
  atualizada_em: Date;
};
