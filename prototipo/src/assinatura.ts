// RNF10: o webhook do provider e um endpoint publico que muda estado de notificacao.
// HMAC do corpo cru com segredo compartilhado — node:crypto resolve, sem dependencia.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const assinar = (corpo: string, segredo: string) =>
  `sha256=${createHmac('sha256', segredo).update(corpo).digest('hex')}`;

export function assinaturaValida(corpo: Buffer | string, cabecalho: string | undefined, segredo: string) {
  if (!cabecalho) return false;
  const esperado = Buffer.from(assinar(corpo.toString(), segredo));
  const recebido = Buffer.from(cabecalho);
  // timingSafeEqual exige mesmo tamanho; comparar antes evita a excecao e nao vaza timing
  // (o tamanho da assinatura e fixo, entao a comparacao de tamanho nao diz nada util).
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}
