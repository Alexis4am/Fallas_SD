#!/usr/bin/env bash
# FALLO #3 - "EL CORREO PERDIDO"
# Defensa: FALLBACK + DEAD-LETTER QUEUE
#
# Apaga Notificaciones por completo (replicas=0).
# Las compras siguen funcionando (HTTP 201).
# Los correos no entregados se guardan en la DLQ y se
# reenvian automaticamente al restaurar el servicio.

set -e
NS=ticketing
URL=http://localhost:30080

azul()  { echo -e "\033[1;34m$1\033[0m"; }
verde() { echo -e "\033[1;32m$1\033[0m"; }
rojo()  { echo -e "\033[1;31m$1\033[0m"; }
ama()   { echo -e "\033[1;33m$1\033[0m"; }

azul "=============================================="
azul " FALLO #3: EL CORREO PERDIDO"
azul " Defensa esperada: FALLBACK + DEAD-LETTER QUEUE"
azul "=============================================="
echo

curl -s -X POST $URL/api/admin/reset > /dev/null
echo "  inventario reseteado a 100 asientos"

PAGOS_POD=$(kubectl get pods -n $NS -l app=payments -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0}' \
  --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
echo "  fallos aleatorios de Pagos: DESACTIVADOS (aislamos la variable)"

restaurar() {
  kubectl scale deploy/notifications --replicas=1 -n $NS > /dev/null 2>&1 || true
  kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0.1}' \
    --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
}
trap restaurar EXIT

echo "  esperando a que el circuit breaker se estabilice..."
sleep 12

HUMO=$(curl -s -X POST $URL/api/reservations -H 'Content-Type: application/json' \
  -d '{"eventId":"concierto-2026","userId":"humo","quantity":1}' | jq -r '.status')
if [ "$HUMO" != "CONFIRMED" ]; then
  echo
  echo "  AVISO: el sistema no esta sano (compra de prueba: $HUMO)."
  echo "  Espera 20s y vuelve a correr el script."
  exit 1
fi
echo "  sistema sano (compra de prueba: CONFIRMED)"
echo

azul "[1/5] Notificaciones esta arriba:"
kubectl get pods -n $NS -l app=notifications -o wide
echo
azul "La DLQ deberia estar vacia:"
curl -s $URL/api/metrics/dlq | jq '{pendientes}'
echo
sleep 2

rojo "[2/5] >>> INYECTANDO EL FALLO <<<"
rojo "Apagando Notificaciones POR COMPLETO (replicas = 0)..."
kubectl scale deploy/notifications --replicas=0 -n $NS
kubectl wait --for=delete pod -l app=notifications -n $NS --timeout=30s 2>/dev/null || true
echo
verde "Confirmamos que NO queda ni un pod:"
kubectl get pods -n $NS -l app=notifications 2>/dev/null || echo "  (ninguno - el servicio no existe)"
echo
sleep 2

ama "[3/5] LA PREGUNTA DEL MILLON:"
ama "Con Notificaciones MUERTO, se puede seguir comprando?"
echo
COMPRAS_OK=0
COMPRAS_FALLO=0
for i in $(seq 1 4); do
  RESULTADO=$(curl -s -w "|%{http_code}" -X POST $URL/api/reservations \
    -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"concierto-2026\",\"userId\":\"sin-correo-$i\",\"quantity\":1}")

  CODE="${RESULTADO##*|}"
  BODY="${RESULTADO%|*}"

  if [ "$CODE" = "201" ]; then
    COMPRAS_OK=$((COMPRAS_OK + 1))
    verde "  Compra #$i -> HTTP 201 CONFIRMED  <-- LA COMPRA FUNCIONO!"
    echo "$BODY" | jq -r '"      \(.notificacion)"'
  else
    COMPRAS_FALLO=$((COMPRAS_FALLO + 1))
    rojo "  Compra #$i -> HTTP $CODE  (esto NO deberia pasar)"
  fi
  sleep 1
done
echo
echo "  ---------------------------------------------"
printf "   Compras confirmadas SIN servicio de correo : %s de 4\n" "$COMPRAS_OK"
echo "  ---------------------------------------------"
echo

azul "[4/5] Y los correos? NO se perdieron. Estan en la DLQ:"
curl -s $URL/api/metrics/dlq | jq '{pendientes, mensajes: [.mensajes[] | {reservation_id, error}]}'
echo
verde "^^^ Ahi estan, guardados y esperando. Ninguno se perdio."
echo
sleep 3

azul "[5/5] Revivimos Notificaciones..."
kubectl scale deploy/notifications --replicas=1 -n $NS
kubectl wait --for=condition=ready pod -l app=notifications -n $NS --timeout=60s
echo
ama "El worker de la DLQ corre cada 15s. Esperando a que drene sola..."
echo

for i in $(seq 1 6); do
  PENDIENTES=$(curl -s $URL/api/metrics/dlq | jq -r '.pendientes')
  echo "  t+$((i*5))s -> mensajes pendientes en la DLQ: $PENDIENTES"
  if [ "$PENDIENTES" = "0" ]; then
    verde "  >>> LA COLA SE DRENO SOLA. Todos los correos salieron."
    break
  fi
  sleep 5
done
echo

verde "Logs del drenado:"
kubectl logs -n $NS -l app=reservations --tail=100 2>/dev/null \
  | grep -i "dlq" | tail -8
echo

verde "=============================================="
if [ "$COMPRAS_OK" -eq 4 ]; then
verde " DEGRADACION ELEGANTE: FUNCIONO."
else
rojo " ATENCION: solo $COMPRAS_OK de 4 compras funcionaron."
rojo " Espera 20s (para que el circuit breaker se cierre) y repite."
fi
verde "=============================================="
verde " QUE ACABA DE PASAR:"
verde " 1. Apagamos Notificaciones ENTERO. Cero pods."
verde " 2. Los usuarios SIGUIERON COMPRANDO: $COMPRAS_OK de 4 con HTTP 201."
verde "    -> Un fallo NO CRITICO no debe tumbar el camino critico."
verde " 3. Los correos NO se perdieron: cayeron en la DLQ."
verde " 4. Al revivir el servicio, el worker drenó la cola SOLO."
verde " 5. Nada se perdio. Solo se retraso. Eso es DEGRADACION ELEGANTE."
verde "=============================================="