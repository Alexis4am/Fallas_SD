#!/usr/bin/env bash
# =============================================================
#  FALLO #4 - "CONDICION DE CARRERA"
#  Defensa: BLOQUEO PESIMISTA (SELECT ... FOR UPDATE)
# =============================================================
#
#  QUE VAMOS A HACER:
#  Lanzar 20 COMPRADORES EXACTAMENTE AL MISMO TIEMPO contra un
#  evento que tiene UN SOLO ASIENTO.
#
#  QUE DEBERIA PASAR:
#  Exactamente UN ganador (201). Exactamente 19 perdedores (409).
#  Asientos finales: 0. NUNCA negativos.
#
#  ESTE ES EL FALLO MAS DIFICIL DE CREER SIN VERLO.
#  Sin el bloqueo, los 20 leerian "queda 1" simultaneamente y los
#  20 creerian que ganaron -> venderias 20 entradas para 1 asiento.
#  Eso es OVERSELLING, y le ha costado millones a empresas reales.
#
#  EL TRUCO PARA QUE SEA UNA CARRERA DE VERDAD:
#  no basta con un bucle for (eso es secuencial). Usamos `&` para
#  lanzar los 20 procesos en PARALELO, y esperamos con `wait`.
# =============================================================

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

# Reseteamos para partir de un estado limpio
curl -s -X POST $URL/api/admin/reset > /dev/null

# ---------- AISLAR LA VARIABLE ----------
# Aqui probamos el BLOQUEO PESIMISTA. Si Pagos falla (lo hace un 10%
# a proposito), la compra del ganador se cae y el asiento se devuelve
# por compensacion -> el conteo final saldria mal y pareceria que el
# bloqueo fallo, cuando en realidad fallo el pago.
# Apagamos los fallos de Pagos durante esta demo.
PAGOS_POD=$(kubectl get pods -n $NS -l app=payments -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0}' \
  --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true

restaurar() {
  kubectl exec -n $NS $PAGOS_POD -- wget -qO- --post-data='{"tasaFalloNormal":0.1}' \
    --header='Content-Type: application/json' http://localhost:3000/chaos > /dev/null 2>&1 || true
}
trap restaurar EXIT

# Dejamos que el circuit breaker se cierre si venia contaminado
sleep 12
sleep 1

azul "[1/4] EL ESCENARIO:"
echo
INICIAL=$(curl -s $URL/api/inventory/ultimo-asiento)
echo "$INICIAL" | jq '{event_id, total_seats, available_seats}'
echo
ama "UN evento. UN asiento. $COMPRADORES personas que lo quieren."
ama "Solo puede quedar uno."
echo
sleep 2

# ---------- EL CAOS ----------
rojo "[2/4] >>> INYECTANDO EL FALLO <<<"
rojo "Lanzando $COMPRADORES compras SIMULTANEAS (en paralelo, no en fila)..."
echo

TMP=$(mktemp -d)

# La clave: el `&` al final lanza cada curl como un proceso INDEPENDIENTE.
# Los 20 salen practicamente en el mismo milisegundo.
for i in $(seq 1 $COMPRADORES); do
  (
    curl -s -o "$TMP/resp-$i.json" -w "%{http_code}" \
      -X POST $URL/api/reservations \
      -H 'Content-Type: application/json' \
      -d "{\"eventId\":\"ultimo-asiento\",\"userId\":\"comprador-$i\",\"quantity\":1}" \
      > "$TMP/code-$i.txt"
  ) &
done

wait   # esperamos a que los 20 terminen
echo

# ---------- CONTAMOS ----------
azul "[3/4] RESULTADOS:"
echo

GANADORES=0
RECHAZADOS=0
ERRORES=0

for i in $(seq 1 $COMPRADORES); do
  CODE=$(cat "$TMP/code-$i.txt" 2>/dev/null || echo "000")
  case "$CODE" in
    201)
      GANADORES=$((GANADORES + 1))
      verde "  comprador-$i  -> 201 CONFIRMED   *** GANADOR ***"
      ;;
    409)
      RECHAZADOS=$((RECHAZADOS + 1))
      echo "  comprador-$i  -> 409 sin asientos (rechazo limpio)"
      ;;
    *)
      ERRORES=$((ERRORES + 1))
      rojo "  comprador-$i  -> $CODE ERROR INESPERADO"
      ;;
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

# ---------- VEREDICTO ----------
if [ "$GANADORES" -eq 1 ] && [ "$FINAL" -eq 0 ] && [ "$ERRORES" -eq 0 ]; then
  verde "=============================================="
  verde " PRUEBA SUPERADA: CERO OVERSELLING"
  verde "=============================================="
  verde " De $COMPRADORES compradores simultaneos, gano EXACTAMENTE UNO."
  verde " Los otros $((COMPRADORES-1)) recibieron un rechazo limpio (409)."
  verde " Los asientos quedaron en 0. Nunca en negativo."
  echo
  verde " POR QUE FUNCIONO:"
  verde " El SELECT ... FOR UPDATE puso un CANDADO sobre la fila."
  verde " El primero en llegar lo tomo. Los otros 19 se quedaron"
  verde " ESPERANDO en la fila del candado. Cuando por fin les toco"
  verde " leer, ya vieron available_seats = 0 y se les rechazo."
  verde " La base de datos SERIALIZO lo que llego en paralelo."
  verde "=============================================="
else
  rojo "=============================================="
  rojo " PRUEBA FALLIDA - HAY OVERSELLING"
  rojo " Ganadores: $GANADORES (deberia ser 1)"
  rojo " Asientos finales: $FINAL (deberia ser 0)"
  rojo "=============================================="
fi

echo
verde "Logs del inventario (mira como los candados se toman EN FILA):"
kubectl logs -n $NS -l app=inventory --tail=80 2>/dev/null \
  | grep -iE "candado|RECHAZADO|HOLD" | head -12

rm -rf "$TMP"
