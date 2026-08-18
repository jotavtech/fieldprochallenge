// Popula o banco e o indice Redis com um cenario parecido com o do PRD (dois paises,
// dois fusos). Escreve direto no banco de proposito: nao passa pela API para nao
// disparar mil dispatches de uma vez — o fluxo de onda se demonstra com demo.sh.
import { pool, q } from './db.ts';
import { indexarVaga } from './geoindex.ts';
import { redis } from './redis.ts';
import type { Vaga } from './db.ts';

const QTD_LOCAIS = Number(process.argv[2] ?? 20);
const QTD_OPERADORES = Number(process.argv[3] ?? 2000);
const QTD_VAGAS = Number(process.argv[4] ?? 800);

const ESPECIALIDADES = ['limpeza', 'garcom', 'seguranca', 'cozinha', 'recepcao'];
const REGIOES = [
  { nome: 'Sao Paulo', lat: -23.5505, lng: -46.6333, tz: 'America/Sao_Paulo' },
  { nome: 'Lisboa', lat: 38.7223, lng: -9.1393, tz: 'Europe/Lisbon' },
];

const sorteia = <T,>(lista: T[]) => lista[Math.floor(Math.random() * lista.length)];
const perto = (base: number, kmMax: number) => base + (Math.random() - 0.5) * (kmMax / 111);

async function main() {
  await q(`TRUNCATE notificacoes, dispatch_ondas, operador_favoritos,
           operador_historico_local, vagas, operadores, locais CASCADE`);
  await redis.del('vagas:geo', 'vagas:doc', 'operadores:geo');

  // --- locais
  // `id: ''` ate o INSERT devolver o uuid — evita casts espalhados pelo resto do arquivo.
  const locais = Array.from({ length: QTD_LOCAIS }, (_, i) => {
    const r = REGIOES[i % REGIOES.length];
    return { id: '', nome: `Local ${i + 1} (${r.nome})`, regiao: r, lat: perto(r.lat, 25), lng: perto(r.lng, 25) };
  });
  const { rows: locaisSalvos } = await q<{ id: string }>(
    `INSERT INTO locais (nome, timezone)
     SELECT * FROM unnest($1::text[], $2::text[]) RETURNING id`,
    [locais.map((l) => l.nome), locais.map((l) => l.regiao.tz)],
  );
  locaisSalvos.forEach((l, i) => (locais[i].id = l.id));

  // --- operadores, espalhados em volta dos locais
  const operadores = Array.from({ length: QTD_OPERADORES }, (_, i) => {
    const l = locais[i % locais.length];
    const qtdEsp = 1 + Math.floor(Math.random() * 2);
    return {
      id: '',
      nome: `Operador ${i + 1}`,
      especialidades: [...new Set(Array.from({ length: qtdEsp }, () => sorteia(ESPECIALIDADES)))],
      lat: perto(l.lat, 30),
      lng: perto(l.lng, 30),
      tz: l.regiao.tz,
      local: l,
    };
  });
  const { rows: operadoresSalvos } = await q<{ id: string }>(
    // especialidades vai como CSV e vira array no banco: text[][] exigiria matriz
    // retangular (todo operador com o mesmo numero de especialidades), que nao e o caso.
    `INSERT INTO operadores (nome, especialidades, latitude, longitude, timezone, push_token)
     SELECT nome, string_to_array(esp, ','), lat, lng, tz, 'tok_' || nome
     FROM unnest($1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::text[])
          AS t(nome, esp, lat, lng, tz)
     RETURNING id`,
    [
      operadores.map((o) => o.nome),
      operadores.map((o) => o.especialidades.join(',')),
      operadores.map((o) => o.lat),
      operadores.map((o) => o.lng),
      operadores.map((o) => o.tz),
    ],
  );
  operadoresSalvos.forEach((o, i) => (operadores[i].id = o.id));

  const pipeGeo = redis.pipeline();
  for (const o of operadores) {
    pipeGeo.geoadd('operadores:geo', o.lng, o.lat, o.id);
  }
  await pipeGeo.exec();

  // --- favoritos (onda 1) e historico (onda 2). Parte do historico e proposital-
  // mente mais velho que a janela de 12 meses (premissa #6) para o filtro ter o que cortar.
  const favoritos: [string, string][] = [];
  const historico: [string, string, Date][] = [];

  // Favoritos: 2 por (local, especialidade). Sorteio puro deixaria locais sem nenhum
  // favorito capaz de fazer o servico — a onda 1 ficaria vazia por acidente de fixture,
  // nao por comportamento do sistema.
  for (const l of locais) {
    for (const esp of ESPECIALIDADES) {
      const candidatos = operadores.filter((o) => o.local.id === l.id && o.especialidades.includes(esp));
      for (const o of candidatos.slice(0, 2)) favoritos.push([l.id, o.id]);
    }
  }

  for (const o of operadores) {
    const l = o.local;
    if (Math.random() < 0.35) {
      const mesesAtras = Math.random() < 0.75 ? Math.random() * 11 : 13 + Math.random() * 10;
      historico.push([l.id, o.id, new Date(Date.now() - mesesAtras * 30 * 86_400_000)]);
    }
  }
  await q(
    `INSERT INTO operador_favoritos (local_id, operador_id)
     SELECT * FROM unnest($1::uuid[], $2::uuid[]) ON CONFLICT DO NOTHING`,
    [favoritos.map((f) => f[0]), favoritos.map((f) => f[1])],
  );
  await q(
    `INSERT INTO operador_historico_local (local_id, operador_id, ultima_vez_trabalhou)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::timestamptz[]) ON CONFLICT DO NOTHING`,
    [historico.map((h) => h[0]), historico.map((h) => h[1]), historico.map((h) => h[2])],
  );

  // --- vagas abertas (nao urgentes: sao o volume que a busca do RF4 tem que atender)
  const vagas = Array.from({ length: QTD_VAGAS }, (_, i) => {
    const l = locais[i % locais.length];
    return {
      local_id: l.id,
      especialidade: sorteia(ESPECIALIDADES),
      endereco: `Rua ${i + 1}, ${l.regiao.nome}`,
      lat: perto(l.lat, 20),
      lng: perto(l.lng, 20),
      // entre 2 e 9 dias no futuro — fora da janela de urgencia
      data_inicio: new Date(Date.now() + (2 + Math.random() * 7) * 86_400_000),
      duracao: 60 * (2 + Math.floor(Math.random() * 6)),
      valor: 5000 + Math.floor(Math.random() * 25000),
      tz: l.regiao.tz,
    };
  });
  const { rows: vagasSalvas } = await q<Vaga & { local_nome: string }>(
    `INSERT INTO vagas (local_id, especialidade, endereco, latitude, longitude,
                        data_inicio, duracao_minutos, valor_centavos, timezone)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::numeric[], $5::numeric[],
                          $6::timestamptz[], $7::int[], $8::int[], $9::text[])
     RETURNING *`,
    [
      vagas.map((v) => v.local_id),
      vagas.map((v) => v.especialidade),
      vagas.map((v) => v.endereco),
      vagas.map((v) => v.lat),
      vagas.map((v) => v.lng),
      vagas.map((v) => v.data_inicio),
      vagas.map((v) => v.duracao),
      vagas.map((v) => v.valor),
      vagas.map((v) => v.tz),
    ],
  );

  const nomePorLocal = new Map(locais.map((l) => [l.id, l.nome]));
  for (const v of vagasSalvas) await indexarVaga(v, nomePorLocal.get(v.local_id)!);

  console.log(
    JSON.stringify(
      {
        locais: locais.length,
        operadores: operadores.length,
        favoritos: favoritos.length,
        historico: historico.length,
        vagas_abertas: vagasSalvas.length,
        exemplo_local: locais[0].id,
        exemplo_operador: operadores[0].id,
        busca_exemplo: `http://localhost:3000/vagas/perto-de-mim?latitude=${REGIOES[0].lat}&longitude=${REGIOES[0].lng}&raio_km=30`,
      },
      null,
      2,
    ),
  );
}

await main();
await pool.end();
await redis.quit();
