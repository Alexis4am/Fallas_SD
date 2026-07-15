# Sistema de Reservas de Entradas — Tolerancia a Fallos

Arquitectura de microservicios sobre un clúster minikube de 2 nodos con cuatro mecanismos de resiliencia verificados mediante inyección real de fallos.

---

## Requisitos

- Docker
- minikube
- kubectl
- jq

---

## Despliegue

### 1. Crear el clúster de 2 nodos

```bash
minikube start --nodes 2 --driver=docker
```

### 2. Etiquetar los nodos

```bash
kubectl label node minikube     sitio=sitio-a --overwrite
kubectl label node minikube-m02 sitio=sitio-b --overwrite
```

### 3. Construir las imágenes

```bash
docker build -t ticketing/gateway:v1       ./services/gateway
docker build -t ticketing/reservations:v1  ./services/reservations
docker build -t ticketing/inventory:v1     ./services/inventory
docker build -t ticketing/payments:v1      ./services/payments
docker build -t ticketing/notifications:v1 ./services/notifications
```

### 4. Cargar las imágenes en el clúster

```bash
minikube image load ticketing/gateway:v1
minikube image load ticketing/reservations:v1
minikube image load ticketing/inventory:v1
minikube image load ticketing/payments:v1
minikube image load ticketing/notifications:v1
```

### 5. Desplegar

```bash
kubectl apply -f k8s/00-namespace-and-db.yaml
kubectl wait --for=condition=available deploy/postgres -n ticketing --timeout=120s
kubectl apply -f k8s/01-inventory.yaml
kubectl apply -f k8s/02-services.yaml
kubectl wait --for=condition=available deploy --all -n ticketing --timeout=180s
```

### 6. Verificar distribución entre nodos

```bash
kubectl get pods -n ticketing -o wide
```

Las 2 réplicas de `inventory` y las 2 de `reservations` deben estar en nodos distintos.

### 7. Exponer el Gateway

En una terminal aparte (mantenerla abierta):

```bash
kubectl port-forward -n ticketing svc/gateway 30080:3000
```

---

## Demos de fallos

```bash
chmod +x chaos/*.sh

./chaos/fallo-1-inventario-fantasma.sh   # retry con backoff exponencial
./chaos/fallo-2-pasarela-lenta.sh        # circuit breaker
./chaos/fallo-3-correo-perdido.sh        # fallback + DLQ
./chaos/fallo-4-condicion-de-carrera.sh  # bloqueo pesimista
```

---

## Problemas comunes

**ImagePullBackOff**
```bash
minikube image load ticketing/<servicio>:v1
kubectl rollout restart deploy -n ticketing
```

**connection refused en localhost:30080**
```bash
kubectl port-forward -n ticketing svc/gateway 30080:3000
```

**Empezar de cero**
```bash
minikube delete
```