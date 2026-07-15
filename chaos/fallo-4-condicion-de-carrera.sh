#!/usr/bin/env bash
# FALLO #4 - "CONDICION DE CARRERA"
# Defensa: BLOQUEO PESIMISTA (SELECT ... FOR UPDATE)
#
# Lanza 20 compradores en paralelo contra 1 solo asiento.
# El FOR UPDATE serializa el acceso: exactamente 1 ganador,
# 19 rechazos limpios (409), cero overselling.

set -e
NS=ticketing
URL=http://localhost:30080
COMPRADORES=20

azul()  { echo -e "\033[1;34m$1\033[0m"; }
verde() { echo -e "\033[1;32m$1\033[0m"; }
rojo()  { echo -e "\033[1;31m$1\033[0m"; }
ama()   { echo -e "\033[1;33m$1\033[0m"; }

azul "=============================================="
azul " FALLO #4: CONDICION DE CARRERA"
azul " Defensa esperada: BLOQUEO PESIMISTA"
azul "=============================================="
echo

curl -s -X POST $URL/api/admin/reset > /dev/null

PAGOS_POD=$(kubectl get pods -n $NS -l app=payments -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0}' \
  --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true

restaurar() {
  kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0.1}' \
    --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
}
trap restaurar EXIT

sleep 12

azul "[1/4] EL ESCENARIO:"
echo
curl -s $URL/api/inventory/ultimo-asiento | jq '{event_id, total_seats, available_seats}'
echo
ama "UN evento. UN asiento. $COMPRADORES personas que lo quieren."
ama "Solo puede quedar uno."
echo
sleep 2

rojo "[2/4] >>> INYECTANDO EL FALLO <<<"
rojo "Lanzando $COMPRADORES compras SIMULTANEAS (en paralelo, no en fila)..."
echo

TMP=$(mktemp -d)

for i in $(seq 1 $COMPRADORES); do
  (
    curl -s -o "$TMP/resp-$i.json" -w "%{http_code}" \
      -X POST $URL/api/reservations \
      -H 'Content-Type: application/json' \
      -d "{\"eventId\":\"ultimo-asiento\",\"userId\":\"comprador-$i\",\"quantity\":1}" \
      > "$TMP/code-$i.txt"
  ) &
done

wait
echo

azul "[3/4] RESULTADOS:"
echo

GANADORES=0
RECHAZADOS=0
ERRORES=0

for i in $(seq 1 $COMPRADORES); do
  CODE=$(cat "$TMP/code-$i.txt" 2>/dev/null || echo "000")
  case "$CODE" in
    201) GANADORES=$((GANADORES+1)); verde "  comprador-$i  -> 201 CONFIRMED   *** GANADOR ***" ;;
    409) RECHAZADOS=$((RECHAZADOS+1)); echo "  comprador-$i  -> 409 sin asientos (rechazo limpio)" ;;
    *)   ERRORES=$((ERRORES+1)); rojo "  comprador-$i  -> $CODE ERROR INESPERADO" ;;
  esac
done
echo

FINAL=$(curl -s $URL/api/inventory/ultimo-asiento | jq -r '.available_seats')

azul "[4/4] EL VEREDICTO:"
echo
echo "  +--------------------------------+----------+----------+"
echo "  | Metrica                        | Esperado | Obtenido |"
echo "  +--------------------------------+----------+----------+"
printf "  | Compras exitosas (201)         |    1     |    %-5s |\n" "$GANADORES"
printf "  | Rechazos limpios (409)         |   %-2s     |   %-5s  |\n" "$((COMPRADORES-1))" "$RECHAZADOS"
printf "  | Errores inesperados            |    0     |    %-5s |\n" "$ERRORES"
printf "  | Asientos restantes             |    0     |    %-5s |\n" "$FINAL"
echo "  +--------------------------------+----------+----------+"
echo

if [ "$GANADORES" -eq 1 ] && [ "$FINAL" -eq 0 ] && [ "$ERRORES" -eq 0 ]; then
  verde "=============================================="
  verde " PRUEBA SUPERADA: CERO OVERSELLING"
  verde "=============================================="
  verde " De $COMPRADORES compradores simultaneos, gano EXACTAMENTE UNO."
  verde " Los otros $((COMPRADORES-1)) recibieron un rechazo limpio (409)."
  verde " Los asientos quedaron en 0. Nunca en negativo."
  verde " El SELECT FOR UPDATE serializo el acceso a la fila."
  verde "=============================================="
else
  rojo "=============================================="
  rojo " PRUEBA FALLIDA - HAY OVERSELLING"
  rojo " Ganadores: $GANADORES (deberia ser 1)"
  rojo " Asientos finales: $FINAL (deberia ser 0)"
  rojo "=============================================="
fi

echo
verde "Logs del inventario (candados tomados en fila):"
kubectl logs -n $NS -l app=inventory --tail=80 2>/dev/null \
  | grep -iE "candado|RECHAZADO|HOLD" | head -12

rm -rf "$TMP"