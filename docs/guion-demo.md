# Guión de la Demo en Vivo

**Duración objetivo:** 12–14 minutos
**Integrantes:** ambos participan activamente (ver reparto abajo)

---

## Antes de empezar (hazlo 15 min antes de la clase)

```bash
# 1. Levanta todo
./scripts/setup.sh

# 2. Verifica que las réplicas quedaron en nodos distintos
kubectl get pods -n ticketing -o wide

# 3. Verifica que responde
curl http://localhost:30080/healthz

# 4. Deja el estado limpio
curl -X POST http://localhost:30080/api/admin/reset
```

**Prepara 2 terminales lado a lado:**

| Terminal | Para qué |
|---|---|
| **Izquierda** (grande) | Ejecutar los scripts de caos |
| **Derecha** (chica) | Logs en vivo: `kubectl logs -n ticketing -l app=reservations -f --prefix` |

---

## Reparto entre integrantes

| Parte | Quién | Minutos |
|---|---|---|
| Intro + arquitectura | **A** | 0:00 – 2:00 |
| Fallo 1: Inventario Fantasma | **A** | 2:00 – 4:30 |
| Fallo 2: Pasarela Lenta | **B** | 4:30 – 7:30 |
| Fallo 3: Correo Perdido | **A** | 7:30 – 10:00 |
| Fallo 4: Condición de Carrera | **B** | 10:00 – 12:30 |
| Cierre | **ambos** | 12:30 – 13:30 |

---

## 0:00 – 2:00 · Intro y arquitectura *(Integrante A)*

**Comando:**
```bash
kubectl get nodes -L sitio
kubectl get pods -n ticketing -o wide
```

**Qué decir:**

> "Tenemos un clúster de Kubernetes con dos nodos de trabajo, que representan dos sitios de infraestructura: sitio A y sitio B.
>
> Miren la columna NODE. **Inventario tiene dos réplicas: una en cada sitio.** Lo mismo Reservas. Eso no es casualidad — está forzado en el manifiesto con `topologySpreadConstraints` y `podAntiAffinity`. Kubernetes *no tiene opción*: tiene que separarlas.
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

## 2:00 – 4:30 · Fallo 1: El Inventario Fantasma *(Integrante A)*

**El patrón:** Retry con backoff exponencial

**Comando:**
```bash
./chaos/fallo-1-inventario-fantasma.sh
```

**Qué decir ANTES de que corra:**

> "Voy a **matar un pod de Inventario en medio de una compra**. No lo voy a apagar con cuidado — `--grace-period=0 --force`. Es una muerte violenta, como si se cayera el servidor.
>
> La pregunta es: ¿se cae el sistema?"

**Qué señalar MIENTRAS corre:**

> "Ahí está mandando tráfico. Ahora mató el pod... y miren: las peticiones **siguen dando 201**."

**Qué señalar DESPUÉS (los logs de retry):**

> "Aquí está la evidencia. Miren estas líneas: `RETRY: intento fallido, reintentando`, con `esperandoMs: 234`, luego `esperandoMs: 447`, luego `891`. **Ese es el backoff exponencial**: 200, 400, 800 milisegundos, más un jitter aleatorio.
>
> Y luego: `RETRY exitoso: se recupero solo`.
>
> **Por qué funciona:** hay dos réplicas. Kubernetes sacó la muerta del Service en 3 segundos, gracias a la `readinessProbe`. El retry esperó y volvió a intentar — y esta vez el Service lo ruteó a la réplica **viva del otro nodo**.
>
> **Por qué retry y no circuit breaker:** un circuit breaker habría *abierto* el circuito y dejado de llamar a Inventario. Pero Inventario **sí estaba disponible** — en el otro nodo. Le habríamos cortado el brazo sano."

---

## 4:30 – 7:30 · Fallo 2: La Pasarela Lenta *(Integrante B)*

**El patrón:** Timeout + Circuit Breaker

**Comando:**
```bash
./chaos/fallo-2-pasarela-lenta.sh
```

**Qué decir ANTES:**

> "Ahora Pagos se va a saturar: va a tardar **20 segundos** en responder. No está caído — está *lento*, que es peor.
>
> **Peor porque:** un servicio caído te da un error rápido. Un servicio lento te deja *colgado*. Las conexiones se acumulan, el pool se agota, y el problema se propaga hacia arriba. Así es como un microservicio lento tumba un sistema entero."

**LO MÁS IMPORTANTE — señala la columna `tiempoMs`:**

> "Miren esta columna. Las primeras peticiones fallan a los **3000ms** — ese es nuestro timeout. No esperamos los 20 segundos.
>
> Pero ahora miren... el circuito se **ABRIÓ**. Y las siguientes fallan en... **5 milisegundos**.
>
> Pasamos de 20 segundos a 5 milisegundos. Eso es **fail fast**. Ya ni siquiera llamamos a Pagos: sabemos que está roto, así que fallamos de inmediato."

**El doble beneficio:**

> "Esto tiene dos ventajas:
> 1. **El usuario** recibe un error útil al instante en vez de mirar un spinner 20 segundos.
> 2. **Pagos** deja de recibir tráfico y tiene *aire* para recuperarse. Si hubiéramos reintentado, le habríamos echado gasolina al fuego."

**La compensación (menciónala, suma puntos):**

> "Y fíjense: cuando el pago falla, **devolvemos el asiento al inventario**. Eso es un paso de compensación — el patrón **Saga**, que investigamos en la tarea MLR previa. Sin eso, el asiento quedaría bloqueado para siempre por una compra que nunca se completó."

**La recuperación automática:**

> "Ahora apago el caos... y el circuito pasa a HALF_OPEN. Deja pasar *una* llamada de prueba. Funciona - se **cierra solo**. Nadie tuvo que intervenir. Eso es *self-healing*."

---

## 7:30 – 10:00 · Fallo 3: El Correo Perdido *(Integrante A)*

**El patrón:** Fallback + Dead-Letter Queue

**Comando:**
```bash
./chaos/fallo-3-correo-perdido.sh
```

**Qué decir ANTES:**

> "Ahora voy a apagar Notificaciones **por completo**. `--replicas=0`. Cero pods. El servicio deja de existir.
>
> La pregunta clave: **¿puede la gente seguir comprando?**"

**El momento clave — cuando salen los 201:**

> "**HTTP 201. CONFIRMED.** Las compras funcionaron.
>
> Y esto es *lo correcto*. Piénsenlo: el usuario ya pagó, ya tiene su asiento. Sería absurdo decirle *'tu compra falló'* solo porque no le pudimos mandar un email.
>
> Eso se llama **degradación elegante**: cuando algo secundario se rompe, el sistema pierde una *funcionalidad*, no el *servicio*."

**Muestra la DLQ:**

> "¿Y los correos? **No se perdieron.** Están aquí, en la Dead-Letter Queue. Cuatro mensajes esperando.
>
> El fallback no fue *ignorar* el problema — fue *guardarlo para después*."

**El drenado automático:**

> "Ahora revivo Notificaciones... y miren el contador: 4... 4... **0**.
>
> **La cola se drenó sola.** Un worker corre cada 15 segundos, encontró los mensajes pendientes, los reenvió, y los borró.
>
> **Nada se perdió. Solo se retrasó.**"

---

## 10:00 – 12:30 · Fallo 4: Condición de Carrera *(Integrante B)*

**El patrón:** Bloqueo pesimista

**Este es el más impresionante. Guárdalo para el final.**

**Comando:**
```bash
./chaos/fallo-4-condicion-de-carrera.sh
```

**Qué decir ANTES (construye la tensión):**

> "Un evento. **Un solo asiento.** Veinte personas que lo quieren.
>
> Y no van a comprar en fila — van a comprar **exactamente al mismo tiempo**. Veinte procesos en paralelo, lanzados en el mismo milisegundo.
>
> ¿Cuántas entradas vamos a vender?"

**El resultado:**

> "**Un ganador. Diecinueve rechazos limpios. Cero asientos restantes. Cero errores.**"

**Explica POR QUÉ (esto es lo que evalúan):**

> "Sin protección, esto sería un desastre. Los veinte harían `SELECT` al mismo tiempo, los veinte leerían *'queda 1'*, y los veinte harían `UPDATE`. **Venderíamos veinte entradas para un asiento.** Eso es *overselling*, y le ha costado millones a empresas reales.
>
> Lo que lo evita es esta línea:
>
> ```sql
> SELECT available_seats FROM seats WHERE event_id = $1 FOR UPDATE;
> ```
>
> El `FOR UPDATE` pone un **candado** sobre la fila. El primero en llegar lo toma. **Los otros diecinueve se quedan esperando en la fila del candado** — bloqueados dentro del `SELECT`. Cuando por fin les toca leer, ya ven `available_seats = 0`, y se les rechaza.
>
> **La base de datos serializó lo que llegó en paralelo.**"

**Por qué pesimista (si preguntan):**

> "El bloqueo *optimista* funciona cuando la contención es baja. Aquí es lo contrario: veinte usuarios peleando por *la misma fila*. Con optimista, diecinueve transacciones abortarían y reintentarían — una tormenta de reintentos. El pesimista los hace **esperar ordenadamente en fila**."

**Muestra los logs del candado:**
```bash
kubectl logs -n ticketing -l app=inventory --tail=50 | grep -i candado
```

> "Miren: `candado adquirido, available: 1`... y luego todos los demás: `available: 0`, `RECHAZADO`. **Se tomaron el candado uno por uno.**"

---

## 12:30 – 13:30 · Cierre *(ambos)*

**Comando:**
```bash
kubectl get pods -n ticketing -o wide
```

**Qué decir:**

> "Después de matar pods, saturar servicios, apagar componentes enteros y lanzar veinte compradores simultáneos contra un solo asiento — **el sistema sigue en pie**. Todos los pods `Running`.
>
> Cuatro fallos. Cuatro patrones distintos. Y la lección de fondo es que **no hay un patrón universal**:
>
> - Contra un fallo **transitorio con redundancia** - *retry*.
> - Contra un servicio **saturado** - *circuit breaker* (reintentar lo empeoraría).
> - Contra un fallo **no crítico** - *fallback y degradar*.
> - Contra una **carrera por un recurso escaso** - *bloqueo pesimista*.
>
> Elegir mal el patrón no solo no ayuda — **puede empeorar el fallo**."

---

## Plan B (si algo se rompe en vivo)

| Problema | Solución rápida |
|---|---|
| El clúster no responde | Ten los **logs y capturas de una corrida previa** listos en una carpeta. Enséñalos. |
| Un script falla a mitad | `curl -X POST http://localhost:30080/api/admin/reset` y vuelve a correrlo. |
| Se acabaron los asientos | El reset los devuelve a 100. |
| Te quedas sin tiempo | **Salta el fallo 1** (el retry es el menos vistoso). Nunca saltes el 4. |

**Consejo:** graba un video de respaldo de la demo completa la noche anterior. Si algo falla en clase, lo pones y sigues explicando encima.
