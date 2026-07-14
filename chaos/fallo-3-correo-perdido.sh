#!/usr/bin/env bash
# =============================================================
#  FALLO #3 - "EL CORREO PERDIDO"
#  Defensa: FALLBACK + DEAD-LETTER QUEUE
# =============================================================
#
#  QUE VAMOS A HACER:
#  Apagar COMPLETAMENTE el Servicio de Notificaciones
#  (kubectl scale --replicas=0). Cero pods. Desaparece.
#
#  QUE DEBERIA PASAR:
#  El usuario COMPRA IGUAL. Recibe su entrada. Status 201 CONFIRMED.
#  El correo no se envia, pero TAMPOCO SE PIERDE: se guarda en la
#  Dead-Letter Queue.
#
#  Y cuando revivimos el servicio, el worker drena la cola SOLO
#  y los correos salen. Nada se perdio, solo se retraso.
#
#  ESTE ES EL FALLO QUE MEJOR DEMUESTRA "DEGRADACION ELEGANTE":
#  se rompe una pieza secundaria y el sistema pierde una funcion,
#  NO el servicio entero.
# =============================================================

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

# ---------- ESTADO LIMPIO ----------
# Sin esto, al correr las demos varias veces se acaban los asientos
# y todo devuelve 409 en vez de probar el fallo real.
curl -s -X POST $URL/api/admin/reset > /dev/null
echo "  inventario reseteado a 100 asientos"
echo

azul "[1/5] Notificaciones esta arriba:"
kubectl get pods -n $NS -l app=notifications -o wide
echo
azul "La DLQ deberia estar vacia:"
curl -s $URL/api/metrics/dlq | jq '{pendientes}'
echo
sleep 2

# ---------- EL CAOS ----------
rojo "[2/5] >>> INYECTANDO EL FALLO <<<"
rojo "Apagando Notificaciones POR COMPLETO (replicas = 0)..."
kubectl scale deploy/notifications --replicas=0 -n $NS
kubectl wait --for=delete pod -l app=notifications -n $NS --timeout=30s 2>/dev/null || true
echo
verde "Confirmamos que NO queda ni un pod:"
kubectl get pods -n $NS -l app=notifications 2>/dev/null || echo "  (ninguno - el servicio no existe)"
echo
sleep 2

# ---------- LA PRUEBA CLAVE ----------
ama "[3/5] LA PREGUNTA DEL MILLON:"
ama "Con Notificaciones MUERTO, se puede seguir comprando?"
echo
for i in $(seq 1 4); do
  RESULTADO=$(curl -s -w "|%{http_code}" -X POST $URL/api/reservations \
    -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"concierto-2026\",\"userId\":\"sin-correo-$i\",\"quantity\":1}")

  CODE="${RESULTADO##*|}"
  BODY="${RESULTADO%|*}"

  if [ "$CODE" = "201" ]; then
    verde "  Compra #$i -> HTTP 201 CONFIRMED  <-- LA COMPRA FUNCIONO!"
    echo "$BODY" | jq -r '"      \(.notificacion)"'
  else
    rojo "  Compra #$i -> HTTP $CODE  (esto NO deberia pasar)"
  fi
  sleep 0.5
done
echo

azul "[4/5] Y los correos? NO se perdieron. Estan en la DLQ:"
curl -s $URL/api/metrics/dlq | jq '{pendientes, mensajes: [.mensajes[] | {reservation_id, error}]}'
echo
verde "^^^ Ahi estan, guardados y esperando. Ninguno se perdio."
echo
sleep 3

# ---------- RECUPERACION AUTOMATICA ----------
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
verde " QUE ACABA DE PASAR:"
verde " 1. Apagamos Notificaciones ENTERO. Cero pods."
verde " 2. Los usuarios SIGUIERON COMPRANDO. HTTP 201. Sin errores."
verde "    -> Un fallo NO CRITICO no debe tumbar el camino critico."
verde " 3. Los correos NO se perdieron: cayeron en la DLQ."
verde " 4. Al revivir el servicio, el worker drenó la cola SOLO."
verde " 5. Nada se perdio. Solo se retraso. Eso es DEGRADACION ELEGANTE."
verde "=============================================="
