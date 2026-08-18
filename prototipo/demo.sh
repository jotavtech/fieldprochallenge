#!/usr/bin/env bash
# Roteiro de defesa: exercita RF1, RF2, RF3, RF5 e RF6 em ~20 segundos.
# Precisa de: docker compose up -d && npm run db:migrate && npm run seed && npm start (outro terminal)
# Dependencias: curl, jq
#
# Rode `npm run seed` antes de cada execucao. Rodar duas vezes no mesmo dia sem reseed faz os
# operadores da regiao baterem o cap de 3 notificacoes/dia e as ondas aparecem com 0 notificados
# — o que e o RF3 funcionando, mas atrapalha a leitura do roteiro.
set -euo pipefail

API=${API:-http://localhost:3000}
TZ_VAGA=${TZ_VAGA:-America/Sao_Paulo}
titulo() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

titulo "0. estado inicial"
curl -s "$API/metricas" | jq '{vagas_abertas, aceites_ok, aceites_409}'

LOCAL=$(curl -s "$API/locais" | jq -r '.[0].id')

titulo "1. RF1 — publicar vaga urgente (comeca em 60min => dispatch em ondas)"
VAGA=$(curl -s -X POST "$API/vagas" -H 'content-type: application/json' -d "{
  \"local_id\": \"$LOCAL\",
  \"especialidade\": \"limpeza\",
  \"endereco\": \"Av. Paulista, 1000\",
  \"latitude\": -23.5614, \"longitude\": -46.6559,
  \"data_inicio_local\": \"$(TZ=$TZ_VAGA date -d '+60 minutes' +%Y-%m-%dT%H:%M)\",
  \"timezone\": \"$TZ_VAGA\",
  \"duracao_minutos\": 240, \"valor_centavos\": 15000
}")
ID=$(echo "$VAGA" | jq -r .id)
echo "$VAGA" | jq '{id, versao, status, urgente}'

sleep 2
titulo "2. plano das 3 ondas (onda 1 ja disparou; 2 e 3 espacadas ate o inicio)"
curl -s "$API/vagas/$ID/dispatch" | jq -c '.[] | {onda: .numero_onda, status, versao: .versao_vaga_no_agendamento, disparar_em, notificados, entregues}'

titulo "3. RF5 — editar o valor: ondas ja disparadas ficam, pendentes viram versao 2"
curl -s -X PATCH "$API/vagas/$ID" -H 'content-type: application/json' \
  -d "{\"local_id\": \"$LOCAL\", \"valor_centavos\": 22000}" | jq '{versao, valor_centavos}'
curl -s "$API/vagas/$ID/dispatch" | jq -c '.[] | {onda: .numero_onda, status, versao: .versao_vaga_no_agendamento}'

titulo "4. RF2 — 20 operadores aceitando ao mesmo tempo"
curl -s "$API/operadores?especialidade=limpeza&limite=100" | jq -r '.[].id' | head -20 > /tmp/fieldpro-ops.txt
xargs -a /tmp/fieldpro-ops.txt -P 20 -I{} \
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/vagas/$ID/aceitar" \
    -H 'content-type: application/json' -d '{"operador_id":"{}"}' \
  | sort | uniq -c | sed 's/^/   /'
echo "   (200 = quem levou a vaga, 409 = todo mundo que chegou depois)"

titulo "5. estado final da vaga: confirmada, ondas futuras abortadas, fora da busca"
curl -s "$API/vagas/$ID" | jq '{status, operador_id, versao}'
curl -s "$API/vagas/$ID/dispatch" | jq -c '.[] | {onda: .numero_onda, status}'
echo -n "   aparece na busca? "
curl -s "$API/vagas/perto-de-mim?latitude=-23.5614&longitude=-46.6559&raio_km=2&limite=200" \
  | jq --arg id "$ID" 'map(select(.id == $id)) | length | if . == 0 then "nao (indice invalidado)" else "SIM — BUG" end'

titulo "6. premissa #1 — vaga publicada em cima da hora: as 3 ondas colapsam"
VAGA2=$(curl -s -X POST "$API/vagas" -H 'content-type: application/json' -d "{
  \"local_id\": \"$LOCAL\",
  \"especialidade\": \"limpeza\",
  \"endereco\": \"Rua Augusta, 200\",
  \"latitude\": -23.5545, \"longitude\": -46.6620,
  \"data_inicio_local\": \"$(TZ=$TZ_VAGA date -d '+2 minutes' +%Y-%m-%dT%H:%M)\",
  \"timezone\": \"$TZ_VAGA\",
  \"duracao_minutos\": 120, \"valor_centavos\": 9000
}")
ID2=$(echo "$VAGA2" | jq -r .id)
sleep 2
curl -s "$API/vagas/$ID2/dispatch" | jq -c '.[] | {onda: .numero_onda, status, disparar_em, notificados}'

titulo "7. RF3 — cap de 3 notificacoes/dia: mais 3 vagas no mesmo ponto"
for i in 1 2 3; do
  curl -s -o /dev/null -X POST "$API/vagas" -H 'content-type: application/json' -d "{
    \"local_id\": \"$LOCAL\",
    \"especialidade\": \"limpeza\",
    \"endereco\": \"Rua Augusta, 20$i\",
    \"latitude\": -23.5545, \"longitude\": -46.6620,
    \"data_inicio_local\": \"$(TZ=$TZ_VAGA date -d '+2 minutes' +%Y-%m-%dT%H:%M)\",
    \"timezone\": \"$TZ_VAGA\",
    \"duracao_minutos\": 120, \"valor_centavos\": 9000
  }"
done
sleep 3
curl -s "$API/metricas" | jq '{notificacoes_bloqueadas_por_cap}'
echo "   (operadores que ja receberam 3 push hoje sao cortados ANTES do envio)"

titulo "8. RF6/§10 — metricas (409 alto aqui e saude, nao bug)"
curl -s "$API/metricas" | jq
