// =============================================================
//  SERVICIO DE RESERVAS  (el CORE del sistema)
// =============================================================
//  Este es el orquestador. Cuando alguien compra una entrada:
//     1. le pide un asiento a INVENTARIO
//     2. le pide el cobro a PAGOS
//     3. le pide el correo a NOTIFICACIONES
//
//  Aqui viven 3 de los 4 mecanismos de resiliencia:
//
//   DEFENSA #1  RETRY con BACKOFF EXPONENCIAL  -> hacia Inventario
//               (protege del fallo "El Inventario Fantasma")
//
//   DEFENSA #2  TIMEOUT + CIRCUIT BREAKER      -> hacia Pagos
//               (protege del fallo "La Pasarela Lenta")
//
//   DEFENSA #3  FALLBACK + DEAD-LETTER QUEUE   -> hacia Notificaciones
//               (protege del fallo "El Correo Perdido")
// =============================================================

const express = require('express');
const axios = require('axios');
const http = require('http');

// =============================================================
//  AGENTE HTTP SIN KEEP-ALIVE  (critico para que el RETRY sirva)
// =============================================================
//  PROBLEMA QUE ESTO RESUELVE:
//
//  El Service de Kubernetes balancea con iptables, y la decision de
//  a que pod ir se toma AL ABRIR LA CONEXION TCP, no en cada peticion.
//
//  Node reutiliza las conexiones (keep-alive) por defecto. Resultado:
//  si el primer intento cayo en la replica ROTA, la conexion queda
//  PEGADA a esa replica... y los 5 reintentos van AL MISMO POD MUERTO.
//  El retry se vuelve inutil: reintenta 5 veces contra el mismo cadaver.
//
//  LA SOLUCION: keepAlive: false -> cada intento abre una conexion
//  NUEVA, asi iptables vuelve a sortear el destino y el reintento
//  tiene la oportunidad de caer en la replica VIVA.
//
//  Es un detalle sutil y muy real: un retry mal configurado a nivel
//  de transporte NO PROTEGE DE NADA, aunque el codigo parezca correcto.
// =============================================================
const agenteSinKeepAlive = new http.Agent({ keepAlive: false });
const CircuitBreaker = require('opossum');
const { Pool } = require('pg');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POD_NAME = process.env.POD_NAME || 'reservations-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory:3000';
const PAYMENTS_URL = process.env.PAYMENTS_URL || 'http://payments:3000';
const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL || 'http://notifications:3000';

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'ticketing',
  connectionTimeoutMillis: 2000,
  max: 10,
});

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'reservations',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =============================================================
//  DEFENSA #1 -> RETRY CON BACKOFF EXPONENCIAL
//  Protege de: "El Inventario Fantasma" (el pod de inventario muere)
// =============================================================
//  Por que RETRY y no Circuit Breaker aqui?
//
//  Porque el fallo es TRANSITORIO y hay REDUNDANCIA. Inventario tiene
//  2 replicas repartidas en 2 nodos. Si matamos una, k8s saca ese pod
//  del Service en segundos y la otra replica sigue viva. El intento
//  que falla es solo el que agarro el pod moribundo: si esperamos un
//  poquito y volvemos a intentar, el Service nos rutea a la replica sana.
//
//  Un Circuit Breaker seria CONTRAPRODUCENTE: abriria el circuito y
//  dejaria de llamar a un servicio que en realidad SI esta disponible
//  (en el otro nodo). Cortariamos el brazo sano.
//
//  El BACKOFF EXPONENCIAL (200ms, 400ms, 800ms, 1600ms) evita que
//  todos los clientes reintenten a la vez y rematen al servicio que
//  se esta recuperando (evita el "retry storm" / efecto manada).
//  El JITTER (ruido aleatorio) desincroniza aun mas los reintentos.
// =============================================================
async function conRetry(fn, { intentos = 5, baseMs = 200, etiqueta = 'op' } = {}) {
  let ultimoError;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const resultado = await fn();
      if (intento > 1) {
        log('RETRY exitoso: se recupero solo', { etiqueta, intento });
      }
      return resultado;
    } catch (err) {
      ultimoError = err;

      // OJO: un 409 (no hay asientos) NO es un fallo transitorio.
      // Es una respuesta legitima del negocio. Reintentar seria absurdo.
      // Solo reintentamos errores de RED o 5xx.
      const status = err.response?.status;
      const esReintentable = !status || status >= 500;
      if (!esReintentable) throw err;

      if (intento === intentos) break; // se acabaron los intentos

      // backoff exponencial: base * 2^(intento-1)
      const espera = baseMs * Math.pow(2, intento - 1);
      const jitter = Math.random() * 100; // ruido para desincronizar
      const total = Math.round(espera + jitter);

      log('RETRY: intento fallido, reintentando', {
        etiqueta, intento, de: intentos,
        esperandoMs: total,
        error: err.message,
      });
      await sleep(total);
    }
  }

  log('RETRY agotado: todos los intentos fallaron', { etiqueta, intentos });
  throw ultimoError;
}

// =============================================================
//  DEFENSA #2 -> TIMEOUT + CIRCUIT BREAKER
//  Protege de: "La Pasarela Lenta" (Pagos tarda 20 segundos)
// =============================================================
//  Por que CIRCUIT BREAKER y no Retry aqui?
//
//  Porque el problema NO es que Pagos este caido: es que esta SATURADO.
//  Si reintentamos, le mandamos MAS carga a un servicio que ya se esta
//  ahogando. Lo empeoramos. Es echarle gasolina al fuego.
//
//  El Circuit Breaker hace lo contrario: DEJA DE LLAMARLO.
//  Funciona como el breaker electrico de tu casa. Tres estados:
//
//    CERRADO (closed)     -> todo normal, las llamadas pasan.
//    ABIERTO (open)       -> demasiados fallos. Ya ni intentamos:
//                            fallamos INSTANTANEAMENTE (fail fast).
//                            Asi (a) el usuario no espera 20s colgado
//                            y (b) le damos aire a Pagos para recuperarse.
//    SEMI-ABIERTO (half)  -> tras 10s dejamos pasar una llamada de prueba.
//                            Si funciona -> cerramos. Si no -> abrimos otra vez.
//
//  El TIMEOUT (3s) es lo que convierte "lento" en "fallo". Sin timeout,
//  el breaker nunca se enteraria de nada: las llamadas simplemente se
//  quedarian colgadas para siempre, agotando el pool de conexiones
//  (esto es el fallo en cascada clasico).
// =============================================================
async function llamarPagos({ reservationId, amount, userId }) {
  const { data } = await axios.post(
    `${PAYMENTS_URL}/payments/charge`,
    { reservationId, amount, userId },
    { timeout: 3000 } // <-- 3s y ni uno mas
  );
  return data;
}

const breakerPagos = new CircuitBreaker(llamarPagos, {
  timeout: 3000,                 // mas de 3s = fallo
  errorThresholdPercentage: 50,  // si >50% falla...
  resetTimeout: 10000,           // ...abre 10s antes de probar de nuevo
  volumeThreshold: 3,            // minimo 3 llamadas antes de decidir
  name: 'payments',
});

// Log de cada cambio de estado (esto es ORO en la demo en vivo)
breakerPagos.on('open', () =>
  log('CIRCUITO ABIERTO: dejamos de llamar a Pagos (fail fast)', { estado: 'OPEN' }));
breakerPagos.on('halfOpen', () =>
  log('CIRCUITO SEMI-ABIERTO: probando si Pagos revivio', { estado: 'HALF_OPEN' }));
breakerPagos.on('close', () =>
  log('CIRCUITO CERRADO: Pagos se recupero, volvemos a la normalidad', { estado: 'CLOSED' }));
breakerPagos.on('timeout', () =>
  log('TIMEOUT: Pagos tardo mas de 3s', { estado: breakerPagos.opened ? 'OPEN' : 'CLOSED' }));
breakerPagos.on('reject', () =>
  log('RECHAZADO por el circuito abierto: no se llamo a Pagos', { estado: 'OPEN' }));

// =============================================================
//  DEFENSA #3 -> FALLBACK + DEAD-LETTER QUEUE
//  Protege de: "El Correo Perdido" (Notificaciones esta caido)
// =============================================================
//  Por que FALLBACK + DLQ y no un retry bloqueante?
//
//  Porque enviar el email NO ES CRITICO. El usuario ya pago y ya tiene
//  su asiento. Que el correo falle no debe tumbar la compra.
//
//  El principio se llama DEGRADACION ELEGANTE: cuando algo secundario
//  se rompe, el sistema pierde una funcionalidad, no el servicio entero.
//
//  Pero tampoco queremos PERDER el correo. Entonces:
//    - Timeout muy corto (1s): no dejamos que el camino critico espere.
//    - Si falla -> guardamos el mensaje en la DEAD-LETTER QUEUE (una
//      tabla en la BD). Es un buzon de "esto hay que reintentarlo despues".
//    - Devolvemos 201 CREATED igual. La compra fue un exito.
//    - Un worker aparte drena la DLQ cuando Notificaciones revive.
//
//  Lo que NO hacemos: propagar el error al usuario. Seria absurdo
//  decirle "tu compra fallo" cuando en realidad si tiene su entrada.
// =============================================================
async function notificarConFallback({ reservationId, userId, eventId }) {
  try {
    await axios.post(
      `${NOTIFICATIONS_URL}/notifications/send`,
      { reservationId, userId, eventId, type: 'confirmation' },
      { timeout: 1000 } // 1s: el camino critico no espera por un email
    );
    log('email enviado', { reservationId });
    return { emailSent: true, queued: false };
  } catch (err) {
    // ---- FALLBACK ----
    // No explotamos. Guardamos el mensaje para reintentarlo luego.
    await pool.query(
      `INSERT INTO dead_letter_queue (id, reservation_id, payload, error, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [
        randomUUID(),
        reservationId,
        JSON.stringify({ userId, eventId, type: 'confirmation' }),
        err.message,
      ]
    );
    log('FALLBACK: Notificaciones caido -> mensaje guardado en la DLQ. La compra CONTINUA.', {
      reservationId, error: err.message,
    });
    return { emailSent: false, queued: true };
  }
}

// ---------------- Health checks ----------------
app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));
app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', pod: POD_NAME, node: NODE_NAME });
  } catch (e) {
    res.status(503).json({ status: 'not-ready' });
  }
});

// Endpoint para ver el estado del circuito en vivo durante la demo
app.get('/metrics/circuit', (_req, res) => {
  const s = breakerPagos.stats;
  res.json({
    estado: breakerPagos.opened ? 'OPEN' : breakerPagos.halfOpen ? 'HALF_OPEN' : 'CLOSED',
    exitos: s.successes,
    fallos: s.failures,
    timeouts: s.timeouts,
    rechazadosPorCircuitoAbierto: s.rejects,
    pod: POD_NAME, node: NODE_NAME,
  });
});

// Endpoint para ver que hay en la DLQ durante la demo
app.get('/metrics/dlq', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, reservation_id, error, created_at FROM dead_letter_queue ORDER BY created_at DESC LIMIT 20'
  );
  const { rows: count } = await pool.query('SELECT COUNT(*) FROM dead_letter_queue');
  res.json({ pendientes: parseInt(count[0].count, 10), mensajes: rows });
});

// =============================================================
//  EL ENDPOINT PRINCIPAL: COMPRAR UNA ENTRADA
// =============================================================
//  Aqui se ve el flujo completo con las 3 defensas en accion.
// =============================================================
app.post('/reservations', async (req, res) => {
  const { eventId = 'concierto-2026', userId = 'anon', quantity = 1, amount = 50 } = req.body;
  const reservationId = randomUUID();
  const t0 = Date.now();

  log('--- nueva reserva ---', { reservationId, eventId, userId, quantity });

  // ---------- PASO 1: pedir el asiento (protegido por RETRY) ----------
  let hold;
  try {
    hold = await conRetry(
      async () => {
        const { data } = await axios.post(
          `${INVENTORY_URL}/inventory/${eventId}/hold`,
          { quantity, reservationId },
          {
            // 800ms: un pod SANO en la misma red responde en ~50ms.
            // Si tarda mas, esta muerto. No vale la pena esperarlo 2s.
            timeout: 800,
            // SIN keep-alive: cada reintento abre conexion NUEVA, para
            // que el Service pueda ruteallo a la OTRA replica. Sin esto,
            // los 5 reintentos van al mismo pod roto y el retry no sirve.
            httpAgent: agenteSinKeepAlive,
          }
        );
        return data;
      },
      { intentos: 5, baseMs: 200, etiqueta: 'inventory.hold' }
    );
  } catch (err) {
    // Si es 409, es que se acabaron los asientos: respuesta de negocio normal.
    if (err.response?.status === 409) {
      log('sin asientos disponibles', { reservationId });
      return res.status(409).json({
        reservationId,
        status: 'REJECTED',
        reason: 'No quedan asientos disponibles',
      });
    }
    // Si llegamos aqui, ni siquiera con 5 reintentos pudimos hablar con Inventario.
    log('ERROR CONTROLADO: inventario inalcanzable tras todos los reintentos', { reservationId });
    return res.status(503).json({
      reservationId,
      status: 'FAILED',
      reason: 'Servicio de inventario no disponible. Intenta de nuevo en unos momentos.',
    });
  }

  // ---------- PASO 2: cobrar (protegido por CIRCUIT BREAKER) ----------
  let payment;
  try {
    payment = await breakerPagos.fire({ reservationId, amount, userId });
    log('pago aprobado', { reservationId, paymentId: payment.paymentId });
  } catch (err) {
    // El pago fallo (timeout, error, o circuito abierto).
    // ---- COMPENSACION estilo SAGA ----
    // Ya habiamos apartado el asiento. Hay que DEVOLVERLO, o quedaria
    // bloqueado para siempre por una compra que nunca se completo.
    log('pago fallido -> COMPENSANDO: devolvemos el asiento al inventario', {
      reservationId, error: err.message,
    });

    await conRetry(
      () => axios.post(
        `${INVENTORY_URL}/inventory/${eventId}/release`,
        { quantity, reservationId },
        { timeout: 2000 }
      ),
      { intentos: 3, baseMs: 200, etiqueta: 'inventory.release' }
    ).catch((e) => log('ALERTA: fallo la compensacion', { reservationId, error: e.message }));

    const circuitoAbierto = breakerPagos.opened;
    return res.status(503).json({
      reservationId,
      status: 'FAILED',
      reason: circuitoAbierto
        ? 'La pasarela de pagos no responde (circuito abierto). Asiento liberado. Reintenta en unos segundos.'
        : 'El pago no pudo procesarse. Asiento liberado.',
      circuitBreaker: circuitoAbierto ? 'OPEN' : 'CLOSED',
      tiempoMs: Date.now() - t0, // <- fijate: falla RAPIDO, no en 20s
    });
  }

  // ---------- PASO 3: persistir la reserva ----------
  await pool.query(
    `INSERT INTO reservations (id, event_id, user_id, quantity, payment_id, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'CONFIRMED',NOW())`,
    [reservationId, eventId, userId, quantity, payment.paymentId]
  );

  // ---------- PASO 4: notificar (protegido por FALLBACK + DLQ) ----------
  const notificacion = await notificarConFallback({ reservationId, userId, eventId });

  // ---------- LISTO ----------
  const tiempoMs = Date.now() - t0;
  log('RESERVA CONFIRMADA', { reservationId, tiempoMs, ...notificacion });

  res.status(201).json({
    reservationId,
    status: 'CONFIRMED',
    eventId,
    quantity,
    asientosRestantes: hold.remaining,
    paymentId: payment.paymentId,
    // Si el email fallo, lo decimos, pero la compra SIGUE SIENDO EXITOSA.
    notificacion: notificacion.emailSent
      ? 'Correo de confirmacion enviado'
      : 'No pudimos enviar el correo ahora; quedo en cola y se enviara automaticamente. Tu entrada esta confirmada.',
    inventarioAtendidoPor: hold.servedBy, // prueba de que se reparte entre nodos
    servedBy: { pod: POD_NAME, node: NODE_NAME },
    tiempoMs,
  });
});

app.get('/reservations/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM reservations WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'no encontrada' });
  res.json(rows[0]);
});

// =============================================================
//  WORKER DE LA DLQ
// =============================================================
//  Cada 15 segundos revisa si hay correos pendientes y trata de
//  enviarlos. Cuando Notificaciones revive, la cola se drena sola.
//  Esto cierra el ciclo del patron: nada se pierde, solo se retrasa.
// =============================================================
async function drenarDLQ() {
  try {
    const { rows } = await pool.query(
      'SELECT id, reservation_id, payload FROM dead_letter_queue ORDER BY created_at LIMIT 10'
    );
    if (!rows.length) return;

    log('worker DLQ: intentando drenar mensajes pendientes', { pendientes: rows.length });

    for (const msg of rows) {
      try {
        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        await axios.post(
          `${NOTIFICATIONS_URL}/notifications/send`,
          { reservationId: msg.reservation_id, ...payload },
          { timeout: 2000 }
        );
        await pool.query('DELETE FROM dead_letter_queue WHERE id = $1', [msg.id]);
        log('DLQ drenada: correo pendiente enviado con exito', {
          reservationId: msg.reservation_id,
        });
      } catch (e) {
        // Sigue caido. Lo dejamos en la cola y probamos en el proximo ciclo.
      }
    }
  } catch (e) {
    // La BD puede estar caida (fallo #4). No pasa nada, reintentamos luego.
  }
}
setInterval(drenarDLQ, 15000);

app.listen(PORT, () => log(`reservas escuchando en :${PORT}`));
