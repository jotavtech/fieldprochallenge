#!/usr/bin/env bash
# RF4: p99 < 200ms sustentando 500 req/s.
#
# -R 500 fixa a TAXA em 500 req/s (nao mede throughput maximo): o requisito e latencia
# sob carga alvo, entao e assim que ele tem que ser medido.
#
# Pre-requisitos: docker compose up -d && npm run db:migrate && npm run seed && npm start
set -euo pipefail

LAT=${LAT:--23.5505}
LNG=${LNG:--46.6333}
RAIO=${RAIO:-15}
DURACAO=${DURACAO:-20}
TAXA=${TAXA:-500}
CONEXOES=${CONEXOES:-100}

URL="http://localhost:3000/vagas/perto-de-mim?latitude=$LAT&longitude=$LNG&raio_km=$RAIO&limite=50"

echo "alvo: $TAXA req/s por ${DURACAO}s em $URL"
exec autocannon -c "$CONEXOES" -d "$DURACAO" -R "$TAXA" --renderStatusCodes "$URL"
