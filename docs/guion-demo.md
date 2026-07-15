# Guión de la Demo en Vivo

**Duración objetivo:** 12–14 minutos
**Integrantes:** Kevin Alexis Mendez Pelaez, Christian Naula Illescas

---

## Reparto entre integrantes

| Parte | Quién | Minutos |
|---|---|---|
| Intro + arquitectura | **Kevin** | 0:00 – 2:00 |
| Fallo 1: Inventario Fantasma | **Kevin** | 2:00 – 4:30 |
| Fallo 2: Pasarela Lenta | **Christian** | 4:30 – 7:30 |
| Fallo 3: Correo Perdido | **Kevin** | 7:30 – 10:00 |
| Fallo 4: Condición de Carrera | **Christian** | 10:00 – 12:30 |
| Cierre | **Ambos** | 12:30 – 13:30 |

---

## 0:00 – 2:00 · Intro y arquitectura *(Kevin)*

**Comandos:**
```bash
kubectl get nodes -L sitio
kubectl get pods -n ticketing -o wide
```

**Comportamiento esperado antes del fallo:**
Dos nodos visibles (`minikube` y `minikube-m02`) con etiquetas `sitio-a` y `sitio-b`. Las réplicas de Inventario y Reservas aparecen distribuidas entre ambos nodos.

**Qué decir:**

> "Tenemos un clúster de Kubernetes con dos nodos de trabajo, que representan dos sitios de infraestructura: sitio A y sitio B.
>
> Miren la columna NODE. Inventario tiene dos réplicas: una en cada sitio. Lo mismo Reservas. Eso está forzado en el manifiesto con `topologySpreadConstraints` y `podAntiAffinity`. Kubernetes no tiene opción: tiene que separarlas.
>
> Esa separación es la base de todo lo que van a ver ahora. Si un sitio entero desaparece, el sistema sigue funcionando."

**Muestra el sistema sano:**
```bash
curl -s -X POST http://localhost:30080/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"concierto-2026","userId":"demo","quantity":1}' | jq
```

> "Fíjense en `inventarioAtendidoPor`: nos dice qué pod y qué nodo atendió. Si repito el curl varias veces, van a ver que unas veces responde el sitio A y otras el sitio B. El balanceo entre nodos es real."

---

## 2:00 – 4:30 · Fallo 1: El Inventario Fantasma *(Kevin)*

**Patrón:** Retry con backoff exponencial

**Comando:**
```bash
./chaos/fallo-1-inventario-fantasma.sh
```

**Comportamiento esperado antes del fallo:**
Sistema sano, compras completándose con HTTP 201.

**Comportamiento esperado durante el fallo:**
El pod de Inventario muere. Los logs muestran reintentos con esperas crecientes. Las compras siguen completándose.

**Comportamiento esperado después del fallo:**
19 de 20 compras completadas (95%). 14 peticiones salvadas por el retry. 1 error controlado (503 limpio).

**Qué decir ANTES:**

> "Voy a matar un pod de Inventario en medio de una compra. No lo voy a apagar con cuidado — `--grace-period=0 --force`. Es una muerte violenta, como si se cayera el servidor.
>
> La pregunta es: ¿se cae el sistema?"

**Qué señalar DURANTE:**

> "Ahí está mandando tráfico. Ahora mató el pod... y miren: las peticiones siguen dando 201."

**Qué señalar DESPUÉS:**

> "Aquí está la evidencia. Miren estas líneas: `RETRY: intento fallido, reintentando`, con `esperandoMs: 234`, luego `esperandoMs: 447`, luego `891`. Ese es el backoff exponencial: 200, 400, 800 milisegundos, más un jitter aleatorio.
>
> Y luego: `RETRY exitoso: se recupero solo`.
>
> Por qué funciona: hay dos réplicas. Kubernetes sacó la muerta del Service en 3 segundos gracias a la `readinessProbe`. El retry esperó y volvió a intentar — y esta vez el Service lo ruteó a la réplica viva del otro nodo.
>
> Por qué retry y no circuit breaker: un circuit breaker habría abierto el circuito y dejado de llamar a Inventario. Pero Inventario sí estaba disponible, en el otro nodo. Le habríamos cortado el brazo sano."

---

## 4:30 – 7:30 · Fallo 2: La Pasarela Lenta *(Christian)*

**Patrón:** Timeout + Circuit Breaker

**Comando:**
```bash
./chaos/fallo-2-pasarela-lenta.sh
```

**Comportamiento esperado antes del fallo:**
Circuito en estado CLOSED. Compras normales en ~200ms.

**Comportamiento esperado durante el fallo:**
Las primeras 2 peticiones fallan a los 3000ms (timeout). A partir de la 3ra, el circuito se abre y las peticiones fallan en menos de 10ms (fail fast).

**Comportamiento esperado después del fallo:**
Al desactivar el caos, el circuito pasa a HALF_OPEN, deja pasar una llamada de prueba, y vuelve a CLOSED automáticamente.

**Qué decir ANTES:**

> "Ahora Pagos se va a saturar: va a tardar 20 segundos en responder. No está caído — está lento, que es peor.
>
> Peor porque: un servicio caído te da un error rápido. Un servicio lento te deja colgado. Las conexiones se acumulan, el pool se agota, y el problema se propaga hacia arriba. Así es como un microservicio lento tumba un sistema entero."

**Qué señalar DURANTE:**

> "Miren esta columna. Las primeras peticiones fallan a los 3000ms — ese es nuestro timeout. No esperamos los 20 segundos.
>
> Pero ahora miren... el circuito se ABRIÓ. Y las siguientes fallan en 5 milisegundos.
>
> Pasamos de 20 segundos a 5 milisegundos. Eso es fail fast. Ya ni siquiera llamamos a Pagos: sabemos que está roto, así que fallamos de inmediato.
>
> Esto tiene dos ventajas: el usuario recibe un error útil al instante, y Pagos deja de recibir tráfico y tiene aire para recuperarse."

**Qué señalar DESPUÉS:**

> "Y fíjense: cuando el pago falla, devolvemos el asiento al inventario. Eso es un paso de compensación — el patrón Saga. Sin eso, el asiento quedaría bloqueado para siempre por una compra que nunca se completó.
>
> Ahora apago el caos... y el circuito pasa a HALF_OPEN. Deja pasar una llamada de prueba. Funciona — se cierra solo. Nadie tuvo que intervenir. Eso es self-healing."

---

## 7:30 – 10:00 · Fallo 3: El Correo Perdido *(Kevin)*

**Patrón:** Fallback + Dead-Letter Queue

**Comando:**
```bash
./chaos/fallo-3-correo-perdido.sh
```

**Comportamiento esperado antes del fallo:**
Notificaciones activo. DLQ vacía.

**Comportamiento esperado durante el fallo:**
Notificaciones escalado a 0 réplicas. Las 4 compras devuelven HTTP 201 con mensaje de cola. La DLQ acumula 4 mensajes pendientes.

**Comportamiento esperado después del fallo:**
Al restaurar Notificaciones, el worker drena la DLQ automáticamente en el siguiente ciclo de 15 segundos. Cola en 0.

**Qué decir ANTES:**

> "Ahora voy a apagar Notificaciones por completo. `--replicas=0`. Cero pods. El servicio deja de existir.
>
> La pregunta clave: ¿puede la gente seguir comprando?"

**Qué señalar DURANTE:**

> "HTTP 201. CONFIRMED. Las compras funcionaron.
>
> Y esto es lo correcto. El usuario ya pagó, ya tiene su asiento. Sería absurdo decirle que su compra falló solo porque no le pudimos mandar un email.
>
> Eso se llama degradación elegante: cuando algo secundario se rompe, el sistema pierde una funcionalidad, no el servicio."

**Qué señalar DESPUÉS:**

> "¿Y los correos? No se perdieron. Están aquí, en la Dead-Letter Queue. Cuatro mensajes esperando.
>
> Ahora revivo Notificaciones... y miren el contador: 4... 4... 0.
>
> La cola se drenó sola. Un worker corre cada 15 segundos, encontró los mensajes pendientes, los reenvió, y los borró.
>
> Nada se perdió. Solo se retrasó."

---

## 10:00 – 12:30 · Fallo 4: Condición de Carrera *(Christian)*

**Patrón:** Bloqueo pesimista

**Comando:**
```bash
./chaos/fallo-4-condicion-de-carrera.sh
```

**Comportamiento esperado antes del fallo:**
Un evento con exactamente 1 asiento disponible.

**Comportamiento esperado durante el fallo:**
20 peticiones lanzadas en paralelo simultáneamente.

**Comportamiento esperado después del fallo:**
1 compra exitosa (HTTP 201). 19 rechazos limpios (HTTP 409). 0 errores inesperados. 0 asientos restantes. Cero overselling.

**Qué decir ANTES:**

> "Un evento. Un solo asiento. Veinte personas que lo quieren.
>
> Y no van a comprar en fila — van a comprar exactamente al mismo tiempo. Veinte procesos en paralelo, lanzados en el mismo milisegundo.
>
> ¿Cuántas entradas vamos a vender?"

**Qué señalar DURANTE:**

> "Un ganador. Diecinueve rechazos limpios. Cero asientos restantes. Cero errores."

**Qué señalar DESPUÉS:**

> "Sin protección, esto sería un desastre. Los veinte harían SELECT al mismo tiempo, los veinte leerían 'queda 1', y los veinte harían UPDATE. Venderíamos veinte entradas para un asiento. Eso es overselling, y le ha costado millones a empresas reales.
>
> Lo que lo evita es esta línea:
>
> `SELECT available_seats FROM seats WHERE event_id = $1 FOR UPDATE;`
>
> El FOR UPDATE pone un candado sobre la fila. El primero en llegar lo toma. Los otros diecinueve se quedan esperando en la fila del candado — bloqueados dentro del SELECT. Cuando por fin les toca leer, ya ven available_seats = 0, y se les rechaza.
>
> La base de datos serializó lo que llegó en paralelo."

**Muestra los logs del candado:**
```bash
kubectl logs -n ticketing -l app=inventory --tail=50 | grep -i candado
```

> "Miren: `candado adquirido, available: 1`... y luego todos los demás: `available: 0`, RECHAZADO. Se tomaron el candado uno por uno."

---

## 12:30 – 13:30 · Cierre *(Ambos)*

**Comando:**
```bash
kubectl get pods -n ticketing -o wide
```

**Qué decir:**

> "Después de matar pods, saturar servicios, apagar componentes enteros y lanzar veinte compradores simultáneos contra un solo asiento — el sistema sigue en pie. Todos los pods Running.
>
> Cuatro fallos. Cuatro patrones distintos. Y la lección de fondo es que no hay un patrón universal:
>
> - Contra un fallo transitorio con redundancia: retry.
> - Contra un servicio saturado: circuit breaker (reintentar lo empeoraría).
> - Contra un fallo no crítico: fallback y degradar.
> - Contra una carrera por un recurso escaso: bloqueo pesimista.
>
> Elegir mal el patrón no solo no ayuda — puede empeorar el fallo."