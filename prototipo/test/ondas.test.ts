// Teste puro: nao precisa de banco nem Redis (`npm run test:unit`).
// O calculo de intervalo entre ondas e a unica logica do sistema que nao da pra
// olhar e conferir de cabeca — premissa #1 do PRD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planejarOndas } from '../src/plano.ts';

const MIN = 60_000;
const agora = new Date('2026-08-17T12:00:00Z');
const em = (minutos: number) => new Date(agora.getTime() + minutos * MIN);
const minutosDepois = (d: Date) => Math.round((d.getTime() - agora.getTime()) / MIN);

test('vaga com folga: 3 ondas proporcionais ao tempo que sobra', () => {
  // inicio em 62min, lead de 2min => 60min uteis, 2 intervalos de 30min
  const plano = planejarOndas(agora, em(62), 3, 2 * MIN, 2 * MIN);
  assert.deepEqual(plano.map((o) => minutosDepois(o.disparar_em)), [0, 30, 60]);
});

test('a primeira onda sempre dispara na hora', () => {
  const plano = planejarOndas(agora, em(600), 3, 2 * MIN, 2 * MIN);
  assert.equal(minutosDepois(plano[0].disparar_em), 0);
});

test('nenhuma onda e agendada depois de data_inicio - lead', () => {
  const lead = 15 * MIN;
  const plano = planejarOndas(agora, em(120), 3, 2 * MIN, lead);
  const limite = em(120).getTime() - lead;
  for (const onda of plano) assert.ok(onda.disparar_em.getTime() <= limite);
});

test('vaga apertada: intervalo nunca fica abaixo do piso', () => {
  // 6min uteis para 2 intervalos daria 3min, mas o piso e de 5min aqui
  const plano = planejarOndas(agora, em(8), 3, 5 * MIN, 2 * MIN);
  const intervalos = plano.slice(1).map((o, i) => o.disparar_em.getTime() - plano[i].disparar_em.getTime());
  for (const intervalo of intervalos) assert.ok(intervalo === 0 || intervalo >= 5 * MIN);
});

test('vaga sem tempo nenhum: ondas colapsam no mesmo instante', () => {
  // comeca em 1min com lead de 2min => o limite ja passou
  const plano = planejarOndas(agora, em(1), 3, 2 * MIN, 2 * MIN);
  assert.equal(plano.length, 3);
  assert.deepEqual(plano.map((o) => minutosDepois(o.disparar_em)), [0, 0, 0]);
});

test('replanejamento usa n+1 slots e descarta o primeiro (nao dispara na hora)', () => {
  // e assim que replanejarOndasPendentes reagenda so o que sobrou (§7.3)
  const restantes = planejarOndas(agora, em(62), 2 + 1, 2 * MIN, 2 * MIN).slice(1);
  assert.equal(restantes.length, 2);
  assert.ok(restantes[0].disparar_em.getTime() > agora.getTime());
});
