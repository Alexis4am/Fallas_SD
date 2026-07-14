#!/usr/bin/env bash
# =============================================================
#  FALLO #2 - "LA PASARELA LENTA"
#  Defensa: TIMEOUT + CIRCUIT BREAKER
# =============================================================
#
#  QUE VAMOS A HACER:
#  Poner al Servicio de Pagos a tardar 20 SEGUNDOS en responder.
#
#  QUE DEBERIA PASAR:
#  - Las primeras peticiones fallan a los 3s (TIMEOUT), no a los 20s.
#  - Tras varios fallos, el CIRCUITO SE ABRE.
#  - Con el circuito abierto, las siguientes fallan al instante:
#    ya ni siquiera llamamos a Pagos. Eso es FAIL FAST.
#  - El asiento se DEVUELVE al inventario (compensacion).
#  - Cuando apagamos el caos, el circuito se cierra SOLO.
#
#  -------------------------------------------------------------
#  DETALLE IMPORTANTE DE SISTEMAS DISTRIBUIDOS:
#
#  El circuit breaker vive EN LA MEMORIA DE CADA POD. No es un
#  estado compartido. Y tenemos 2 REPLICAS de Reservas.
#
#  O sea: hay DOS circuitos independientes, y el balanceador
#  reparte las peticiones entre ambos. Para que los dos se abran,
#  cada pod debe acumular SUS PROPIOS fallos.
#
#  Por eso mandamos 14 peticiones y no 6: con 6, cada pod recibia
#  solo ~3 y se quedaba justo en el borde del umbral sin abrir.
#  -------------------------------------------------------------
# =============================================================

set -e
NS=ticketing
URL=http://localhost:30080
PETICIONES=14

azul()  { echo -e "\033[1;34m$1\033[0m"; }
verde() { echo -e "\033[1;32m$1\033[0m"; }
rojo()  { echo -e "\033[1;31m$1\033[0m"; }
ama()   { echo -e "\033[1;33m$1\033[0m"; }

azul "=============================================="
azul " FALLO #2: LA PASARELA LENTA"
azul " Defensa esperada: TIMEOUT + CIRCUIT BREAKER"
azul "=============================================="
echo

# ---------- ESTADO LIMPIO ----------
# Sin esto, al correr las demos varias veces se acaban los asientos
# y todo devuelve 409 en vez de probar el fallo real.
curl -s -X POST $URL/api/admin/reset > /dev/null
echo "  inventario reseteado a 100 asientos"
echo

PAGOS_POD=$(kubectl get pods -n $NS -l app=payments -o jsonpath='{.items[0].metadata.name}')
REPLICAS=$(kubectl get pods -n $NS -l app=reservations --no-headers | wc -l)

ama "Reservas tiene $REPLICAS replicas -> hay $REPLICAS circuit breakers"
ama "independientes (cada pod lleva su estado en memoria)."
echo

azul "[1/5] Estado del circuito ANTES (deberia estar CLOSED):"
curl -s $URL/api/metrics/circuit | jq '.'
echo
sleep 1

azul "[2/5] Una compra normal (fijate en el tiempoMs):"
curl -s -X POST $URL/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"concierto-2026","userId":"antes","quantity":1}' \
  | jq '{status, tiempoMs}'
echo
sleep 1

# ---------- EL CAOS ----------
rojo "[3/5] >>> INYECTANDO EL FALLO <<<"
rojo "Poniendo a Pagos a tardar 20 SEGUNDOS..."
kubectl exec -n $NS $PAGOS_POD -- \
  wget -qO- --post-data='{"lento":true}' \
  --header='Content-Type: application/json' \
  http://localhost:3000/chaos > /dev/null
echo "  caos activado."
echo

ama "Mandando $PETICIONES compras. Observa la columna tiempoMs:"
echo

LENTAS=0     # fallaron por timeout (~3000ms) -> circuito aun CERRADO
RAPIDAS=0    # fallaron al instante (<500ms)  -> CIRCUITO ABIERTO

for i in $(seq 1 $PETICIONES); do
  R=$(curl -s -X POST $URL/api/reservations \
    -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"concierto-2026\",\"userId\":\"caos-$i\",\"quantity\":1}")

  TIEMPO=$(echo "$R" | jq -r '.tiempoMs // 0')
  CIRCUITO=$(echo "$R" | jq -r '.circuitBreaker // "CLOSED"')
  ESTADO=$(echo "$R" | jq -r '.status')
  POD=$(echo "$R" | jq -r '.servedBy.pod // "?"' | tail -c 6)

  # Un fallo RAPIDO solo puede significar una cosa: el circuito
  # estaba ABIERTO y ni se molesto en llamar a Pagos.
  if [ "$TIEMPO" -lt 500 ] 2>/dev/null; then
    RAPIDAS=$((RAPIDAS + 1))
    rojo "  #$i [..$POD] -> $ESTADO | ${TIEMPO}ms | $CIRCUITO  <-- FAIL FAST!"
  else
    LENTAS=$((LENTAS + 1))
    ama  "  #$i [..$POD] -> $ESTADO | ${TIEMPO}ms | $CIRCUITO  (timeout 3s)"
  fi
done
echo

azul "[4/5] Estado del circuito DURANTE el fallo:"
curl -s $URL/api/metrics/circuit | jq '.'
echo

# ---------- VEREDICTO HONESTO ----------
# No AFIRMAMOS que se abrio: lo COMPROBAMOS midiendo.
echo "  ---------------------------------------------"
printf "   Fallos por TIMEOUT   (~3000ms) : %s\n" "$LENTAS"
printf "   Fallos por FAIL FAST (<500ms)  : %s\n" "$RAPIDAS"
echo "  ---------------------------------------------"
echo

if [ "$RAPIDAS" -gt 0 ]; then
  verde " EL CIRCUITO SE ABRIO."
  verde " $RAPIDAS peticiones fallaron AL INSTANTE en vez de esperar 3s."
  verde " De ~3000ms a pocos ms: eso es FAIL FAST."
else
  rojo " EL CIRCUITO NO LLEGO A ABRIRSE."
  rojo " Con $REPLICAS replicas las peticiones se repartieron y ningun"
  rojo " pod acumulo fallos suficientes. Sube PETICIONES en el script."
fi
echo
sleep 2

# ---------- RECUPERACION ----------
azul "[5/5] Apagamos el caos. Pagos vuelve a la normalidad..."
kubectl exec -n $NS $PAGOS_POD -- \
  wget -qO- --post-data='{"lento":false}' \
  --header='Content-Type: application/json' \
  http://localhost:3000/chaos > /dev/null
echo "  caos desactivado."
echo
ama "El circuito tarda 10s en pasar a HALF_OPEN. Esperando..."
sleep 12

ama "Compras de prueba (estas 'cierran' los circuitos):"
for i in $(seq 1 4); do
  curl -s -X POST $URL/api/reservations \
    -H 'Content-Type: application/json' \
    -d "{\"eventId\":\"concierto-2026\",\"userId\":\"recuperado-$i\",\"quantity\":1}" \
    | jq -r '"  -> \(.status) en \(.tiempoMs)ms"'
done
echo

verde "Estado FINAL del circuito:"
curl -s $URL/api/metrics/circuit | jq '.'
echo

verde "Logs del circuit breaker (de los $REPLICAS pods):"
kubectl logs -n $NS -l app=reservations --tail=400 2>/dev/null \
  | grep -iE "CIRCUITO" | tail -8 || echo "  (sin eventos)"
echo

verde "=============================================="
verde " QUE ACABA DE PASAR:"
verde " 1. Pagos empezo a tardar 20s (saturado)."
verde " 2. El TIMEOUT de 3s convirtio 'lento' en 'fallo'."
verde " 3. Tras acumular fallos, el CIRCUITO SE ABRIO."
verde " 4. Con el circuito abierto fallamos AL INSTANTE, no en 20s."
verde "    -> error UTIL de inmediato para el usuario."
verde "    -> y AIRE para que Pagos se recupere."
verde " 5. El asiento se DEVOLVIO al inventario (compensacion Saga)."
verde " 6. Al arreglar Pagos, el circuito se cerro SOLO (self-healing)."
verde "=============================================="
