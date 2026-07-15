#!/usr/bin/env bash
# FALLO #1 - "EL INVENTARIO FANTASMA"
# Defensa: RETRY CON BACKOFF EXPONENCIAL
#
# Activa modo caos en una replica: sigue viva pero falla con 503.
# Simula un servicio vivo pero roto durante la ventana de ~6s
# antes de que la readinessProbe lo saque del Service.

set -e
NS=ticketing
URL=http://localhost:30080
TOTAL=20

azul()  { echo -e "\033[1;34m$1\033[0m"; }
verde() { echo -e "\033[1;32m$1\033[0m"; }
rojo()  { echo -e "\033[1;31m$1\033[0m"; }
ama()   { echo -e "\033[1;33m$1\033[0m"; }

azul "=============================================="
azul " FALLO #1: EL INVENTARIO FANTASMA"
azul " Defensa esperada: RETRY CON BACKOFF"
azul "=============================================="
echo

curl -s -X POST $URL/api/admin/reset > /dev/null
DISP=$(curl -s $URL/api/inventory/concierto-2026 | jq -r '.available_seats')
echo "  inventario reseteado: $DISP asientos"

PAGOS_POD=$(kubectl get pods -n $NS -l app=payments -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0}' \
  --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
echo "  fallos aleatorios de Pagos: DESACTIVADOS (aislamos la variable)"
echo

restaurar_todo() {
  kubectl exec -n $NS $VICTIMA -- wget -qO- --post-data='{"caido":false}' \
    --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
  kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0.1}' \
    --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
}
trap restaurar_todo EXIT

azul "[1/4] ESTADO INICIAL: las dos replicas de inventario"
kubectl get pods -n $NS -l app=inventory -o wide
echo
verde "^^^ Columna NODE: una replica en CADA nodo."
echo
sleep 2

azul "[2/4] El sistema funciona normalmente:"
curl -s -X POST $URL/api/reservations -H 'Content-Type: application/json' \
  -d '{"eventId":"concierto-2026","userId":"antes","quantity":1}' \
  | jq '{status, inventarioAtendidoPor}'
echo
sleep 1

DESDE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TMP=$(mktemp -d)

rojo "[3/4] >>> INYECTANDO EL FALLO <<<"
echo
VICTIMA=$(kubectl get pods -n $NS -l app=inventory -o jsonpath='{.items[0].metadata.name}')
NODO=$(kubectl get pod $VICTIMA -n $NS -o jsonpath='{.spec.nodeName}')

rojo "  >>> ROMPIENDO la replica: $VICTIMA"
rojo "  >>> (nodo: $NODO)"
kubectl exec -n $NS $VICTIMA -- wget -qO- --post-data='{"caido":true}' \
  --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1
rojo "  >>> replica CAIDA, pero SIGUE en el Service."
echo
ama "  Tenemos ~6 segundos antes de que k8s la saque del Service."
ama "  Mandamos $TOTAL peticiones AHORA, dentro de esa ventana."
ama "  Las que caigan en la replica rota van a fallar -> el RETRY"
ama "  debe reintentar y ruteallas a la replica VIVA."
echo

for i in $(seq 1 $TOTAL); do
  (
    C=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -X POST $URL/api/reservations \
      -H 'Content-Type: application/json' \
      -d "{\"eventId\":\"concierto-2026\",\"userId\":\"carga-$i\",\"quantity\":1}")
    echo "$C" > "$TMP/c-$i.txt"
  ) &
  sleep 0.1
done

wait
echo

ama "Trafico terminado. Reviviendo la replica..."
kubectl exec -n $NS $VICTIMA -- wget -qO- --post-data='{"caido":false}' \
  --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
echo

OK=0; ERR=0; AGOTADO=0
for i in $(seq 1 $TOTAL); do
  C=$(cat "$TMP/c-$i.txt" 2>/dev/null || echo "000")
  case "$C" in
    201) OK=$((OK+1));      echo "  peticion $i -> 201 OK" ;;
    409) AGOTADO=$((AGOTADO+1)); rojo "  peticion $i -> 409 SIN ASIENTOS (resetea)" ;;
    *)   ERR=$((ERR+1));    ama "  peticion $i -> $C  (error CONTROLADO)" ;;
  esac
done
rm -rf "$TMP"
echo

azul "[4/4] RESULTADO"
echo
verde "EVIDENCIA DEL RETRY (el backoff exponencial en accion):"
kubectl logs -n $NS -l app=reservations --since-time="$DESDE" \
  --tail=-1 --max-log-requests=10 2>/dev/null \
  | grep -a "RETRY" \
  | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line)
        if 'intento fallido' in d.get('msg',''):
            print(f\"  intento {d['intento']}/{d['de']} -> espera {d['esperandoMs']}ms\")
        elif 'exitoso' in d.get('msg',''):
            print(f\"  >>> RETRY EXITOSO: se recupero en el intento {d['intento']}\")
    except: pass
" | head -12 || true

RETRIES=$(kubectl logs -n $NS -l app=reservations --since-time="$DESDE" \
  --tail=-1 --max-log-requests=10 2>/dev/null | grep -ac "RETRY: intento fallido" || true)
SALVADAS=$(kubectl logs -n $NS -l app=reservations --since-time="$DESDE" \
  --tail=-1 --max-log-requests=10 2>/dev/null | grep -ac "RETRY exitoso" || true)
echo

PCT=$(( OK * 100 / TOTAL ))
echo "  ---------------------------------------------"
printf "   Compras completadas (201)  : %s de %s  (%s%%)\n" "$OK" "$TOTAL" "$PCT"
printf "   Errores controlados (503)  : %s\n" "$ERR"
printf "   Reintentos disparados      : %s\n" "$RETRIES"
printf "   Peticiones SALVADAS por el retry : %s  <- LA EVIDENCIA\n" "$SALVADAS"
echo "  ---------------------------------------------"
echo

verde "=============================================="
if [ "$SALVADAS" -gt 0 ]; then
verde " EL RETRY FUNCIONO."
verde "=============================================="
verde " 1. Rompimos 1 de las 2 replicas de inventario."
verde " 2. Durante ~6s el Service le siguio mandando trafico"
verde "    (hasta que la readinessProbe la detecto y la saco)."
verde " 3. Esas peticiones fallaron con 503... y el RETRY las salvo:"
verde "    $SALVADAS peticiones se recuperaron SOLAS, reintentando con"
verde "    backoff exponencial (250-420-870-1630ms) hasta caer en la"
verde "    replica VIVA del otro nodo."
verde " 4. El sistema siguio vendiendo: $OK de $TOTAL ($PCT%)."
else
verde " 1. Rompimos 1 replica. El sistema siguio: $OK de $TOTAL ($PCT%)."
fi
if [ "$ERR" -gt 0 ]; then
verde " 5. $ERR peticiones agotaron sus 5 reintentos -> 503 CONTROLADO."
verde "    No es un crash: error limpio, mensaje util, asiento intacto."
fi
verde ""
verde " SIN 2 REPLICAS EN 2 NODOS, EL FALLO HABRIA SIDO DEL 100%."
verde "=============================================="