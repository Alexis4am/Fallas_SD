# Sistema de Reservas de Entradas — Tolerancia a Fallos

Arquitectura de microservicios sobre un clúster **minikube de 2 nodos**, con cuatro mecanismos de resiliencia verificados mediante inyección real de fallos.

---

## Requisitos

- Docker
- minikube
- kubectl
- jq

---

## Despliegue (paso a paso)

### 1. Crear el clúster de 2 nodos

```bash
minikube start --nodes 2 --driver=docker
```

Verificar:

```bash
kubectl get nodes
```

Deben aparecer `minikube` y `minikube-m02`.

### 2. Etiquetar los nodos como dos "sitios"

Simulamos dos sitios de infraestructura. Estas etiquetas son las que usan los manifiestos para repartir las réplicas.

```bash
kubectl label node minikube     sitio=sitio-a --overwrite
kubectl label node minikube-m02 sitio=sitio-b --overwrite
```

Verificar:

```bash
kubectl get nodes -L sitio
```

### 3. Construir las imágenes

```bash
docker build -t ticketing/gateway:v1       ./services/gateway
docker build -t ticketing/reservations:v1  ./services/reservations
docker build -t ticketing/inventory:v1     ./services/inventory
docker build -t ticketing/payments:v1      ./services/payments
docker build -t ticketing/notifications:v1 ./services/notifications
```

### 4. Cargar las imágenes dentro del clúster

Los nodos de minikube tienen su **propio** almacén de imágenes. Aunque la imagen exista en tu Docker local, el nodo no la ve. Hay que copiarla hacia adentro:

```bash
minikube image load ticketing/gateway:v1
minikube image load ticketing/reservations:v1
minikube image load ticketing/inventory:v1
minikube image load ticketing/payments:v1
minikube image load ticketing/notifications:v1
```

Sin este paso, Kubernetes intentaría descargar la imagen de internet, no la encontraría, y daría `ImagePullBackOff`.

### 5. Desplegar

```bash
kubectl apply -f k8s/00-namespace-and-db.yaml
kubectl wait --for=condition=available deploy/postgres -n ticketing --timeout=120s

kubectl apply -f k8s/01-inventory.yaml
kubectl apply -f k8s/02-services.yaml

kubectl wait --for=condition=available deploy --all -n ticketing --timeout=180s
```

### 6. Verificar la distribución entre nodos

```bash
kubectl get pods -n ticketing -o wide
```

**Las 2 réplicas de `inventory` deben estar en nodos DISTINTOS.** Igual las de `reservations`.

### 7. Exponer el Gateway

En una terminal aparte (déjala abierta):

```bash
kubectl port-forward -n ticketing svc/gateway 30080:3000
```

Probar en otra terminal:

```bash
curl http://localhost:30080/healthz
```

---

## Correr las demos

```bash
chmod +x chaos/*.sh

./chaos/fallo-1-inventario-fantasma.sh    # retry con backoff
./chaos/fallo-2-pasarela-lenta.sh         # circuit breaker
./chaos/fallo-3-correo-perdido.sh         # fallback + DLQ
./chaos/fallo-4-condicion-de-carrera.sh   # bloqueo pesimista
```

Guardar evidencia:

```bash
mkdir -p evidencia
./chaos/fallo-1-inventario-fantasma.sh   2>&1 | tee evidencia/fallo-1.txt
./chaos/fallo-2-pasarela-lenta.sh        2>&1 | tee evidencia/fallo-2.txt
./chaos/fallo-3-correo-perdido.sh        2>&1 | tee evidencia/fallo-3.txt
./chaos/fallo-4-condicion-de-carrera.sh  2>&1 | tee evidencia/fallo-4.txt
kubectl get pods -n ticketing -o wide    > evidencia/distribucion-nodos.txt
```

---

## Arquitectura

```
                      localhost:30080
                            |
   =========================|===========================
   |          CLUSTER MINIKUBE (2 nodos)               |
   |                        |                          |
   |  +------ SITIO A ------+   +---- SITIO B ------+  |
   |  |     (minikube)      |   |  (minikube-m02)   |  |
   |  |                     |   |                   |  |
   |  |  +---------------+  |   |                   |  |
   |  |  |  API GATEWAY  |  |   |                   |  |
   |  |  |  bulkhead: 20 |  |   |                   |  |
   |  |  +-------+-------+  |   |                   |  |
   |  |          |          |   |                   |  |
   |  |  +-------v-------+  |   |  +-------------+  |  |
   |  |  |   RESERVAS    |  |   |  |  RESERVAS   |  |  |
   |  |  |    (1 de 2)   |  |   |  |  (2 de 2)   |  |  |
   |  |  | retry         |  |   |  |             |  |  |
   |  |  | circuit break.|  |   |  +-------------+  |  |
   |  |  | fallback+DLQ  |  |   |                   |  |
   |  |  +---+-------+---+  |   |                   |  |
   |  |      |       |      |   |                   |  |
   |  |  +---v-----+ |      |   |  +-------------+  |  |
   |  |  |INVENTARIO| |     |   |  | INVENTARIO  |  |  |
   |  |  | (1 de 2) | |     |   |  |  (2 de 2)   |  |  |
   |  |  | FOR      | |     |   |  |             |  |  |
   |  |  | UPDATE   | |     |   |  +-------------+  |  |
   |  |  +----+-----+ |     |   |                   |  |
   |  |       |       |     |   |  +-------------+  |  |
   |  |  +----v----+  +-----|---|->|    PAGOS    |  |  |
   |  |  |POSTGRES |        |   |  |   (stub)    |  |  |
   |  |  | seats   |        |   |  +-------------+  |  |
   |  |  | reserv. |        |   |                   |  |
   |  |  | DLQ     |<-------|---|--+-------------+  |  |
   |  |  +---------+        |   |  |NOTIFICACION.|  |  |
   |  |                     |   |  |   (stub)    |  |  |
   |  +---------------------+   |  +-------------+  |  |
   |                            +-------------------+  |
   =====================================================

  COMPONENTES CRITICOS REPLICADOS ENTRE AMBOS SITIOS:
    - INVENTARIO  (2 replicas: una en A, una en B)
    - RESERVAS    (2 replicas: una en A, una en B)
```

### Los 6 componentes

| # | Componente | Réplicas | Sitio | Rol |
|---|---|---|---|---|
| 1 | API Gateway | 1 | A | Entrada única. Bulkhead. |
| 2 | Reservas (core) | **2** | **A y B** | Orquestador. 3 de los 4 mecanismos. |
| 3 | Inventario | **2** | **A y B** | Recurso escaso. Bloqueo pesimista. |
| 4 | Pagos (stub) | 1 | B | Latencia variable + 10% de fallos. |
| 5 | Notificaciones (stub) | 1 | B | 15% de fallos. El NO crítico. |
| 6 | PostgreSQL | 1 | A | Asientos, reservas y DLQ. |

---

## Parte II — Mapeo de los 6 fallos

| # | Fallo | Mecanismo de inyección | Estado |
|---|---|---|---|
| 1 | El Inventario Fantasma | `kubectl exec ... -- kill 1` (crash del proceso) | **Implementado** |
| 2 | La Pasarela Lenta | `POST /chaos {"lento":true}` → 20 000 ms | **Implementado** |
| 3 | El Diluvio de Peticiones | `k6 run chaos/carga-k6.js` → 200 VUs | Analizado (Parte V) |
| 4 | Base de Datos Intermitente | `NetworkPolicy` bloqueando egress a Postgres | Analizado (Parte V) |
| 5 | El Correo Perdido | `kubectl scale deploy/notifications --replicas=0` | **Implementado** |
| 6 | Condición de Carrera | 20 `curl` en paralelo contra 1 asiento | **Implementado** |

---

## Parte III — Los 4 mecanismos

### 1. Retry con backoff exponencial → El Inventario Fantasma

`services/reservations/index.js`, función `conRetry()`

El fallo es **transitorio** y hay **redundancia** (2 réplicas en 2 nodos). Cuando una muere, Kubernetes la saca del Service en segundos; el retry cubre esa ventana y la petición se rutea a la réplica viva.

Un circuit breaker sería contraproducente: abriría el circuito y dejaría de llamar a un servicio que *sí* está disponible en el otro nodo.

Backoff exponencial (200 → 400 → 800 → 1600 ms) con **jitter** para evitar el *retry storm*.

Solo se reintentan errores de red y 5xx. Un 409 (sin asientos) es una respuesta legítima de negocio — reintentarla sería absurdo.

### 2. Timeout + Circuit Breaker → La Pasarela Lenta

`services/reservations/index.js`, objeto `breakerPagos` (librería `opossum`)

El problema no es que Pagos esté caído: está **saturado**. Reintentar le mandaría *más* carga. El circuit breaker hace lo contrario: **deja de llamarlo**.

| Estado | Qué hace |
|---|---|
| CLOSED | Normal, las llamadas pasan |
| OPEN | Falla instantáneamente sin llamar (fail fast) |
| HALF_OPEN | Tras 10s, deja pasar una llamada de prueba |

El **timeout de 3s** es lo que convierte "lento" en "fallo". Sin él, las llamadas se quedarían colgadas agotando el pool de conexiones — el fallo en cascada clásico.

Cuando el pago falla, se **devuelve el asiento** al inventario: una compensación estilo **Saga** (el patrón de la tarea MLR).

### 3. Fallback + Dead-Letter Queue → El Correo Perdido

`services/reservations/index.js`, `notificarConFallback()` + worker `drenarDLQ()`

El email **no es crítico**. El usuario ya pagó y tiene su asiento. Que el correo falle no debe tumbar la compra: **degradación elegante**.

Timeout corto (1s), y si falla → el mensaje va a la DLQ. Se devuelve **201 CREATED igual**. Un worker drena la cola cada 15s. Nada se pierde, solo se retrasa.

### 4. Bloqueo pesimista → Condición de Carrera

`services/inventory/index.js`, `POST /inventory/:eventId/hold`

```sql
BEGIN;
SELECT available_seats FROM seats WHERE event_id = $1 FOR UPDATE;  -- CANDADO
UPDATE seats SET available_seats = available_seats - $2 WHERE event_id = $1;
COMMIT;
```

El primero toma el candado. Los demás **se bloquean** en el SELECT hasta el COMMIT. Cuando leen, ven 0 y se les rechaza con 409. **Nunca hay dos ganadores.**

Pesimista y no optimista porque la **contención es alta** (20 usuarios, la misma fila). Con optimista, 19 de 20 abortarían y reintentarían: una tormenta de reintentos.

---

## Problemas comunes

**Las réplicas quedaron en el mismo nodo**
```bash
kubectl get nodes -L sitio          # ¿tienen la etiqueta?
kubectl label node minikube     sitio=sitio-a --overwrite
kubectl label node minikube-m02 sitio=sitio-b --overwrite
kubectl rollout restart deploy/inventory -n ticketing
```

**ImagePullBackOff**
```bash
minikube image load ticketing/inventory:v1    # (y las demás)
kubectl rollout restart deploy -n ticketing
```

**connection refused en localhost:30080**
El `port-forward` se cayó. Relánzalo:
```bash
kubectl port-forward -n ticketing svc/gateway 30080:3000
```

**Empezar de cero**
```bash
minikube delete
```

---

## Nota sobre los rolling updates

Los deployments de `inventory` y `reservations` usan:

```yaml
strategy:
  rollingUpdate:
    maxSurge: 0
    maxUnavailable: 1
```

**Por qué:** el `podAntiAffinity` y el `topologySpreadConstraints` (con `DoNotSchedule`) prohíben dos réplicas del mismo servicio en un mismo nodo. Con 2 réplicas y 2 nodos, la estrategia por defecto (`maxSurge: 25%`, que crea el pod nuevo *antes* de matar el viejo) **no encuentra dónde colocarlo** y el rollout se queda colgado en `Pending` para siempre.

Con `maxSurge: 0` reemplaza en sitio, sin crear pods de más.

**Trade-off real:** ganamos tolerancia a fallos (las réplicas nunca coinciden de nodo) a costa de capacidad reducida *durante* el despliegue. En producción tendrías más nodos que réplicas.

---

## Si cambias código de un servicio

```bash
docker build -t ticketing/reservations:v1 ./services/reservations
minikube image load ticketing/reservations:v1
kubectl rollout restart deploy/reservations -n ticketing
kubectl rollout status deploy/reservations -n ticketing
```
