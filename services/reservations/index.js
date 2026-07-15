/**
 * Servicio de Reservas (Core/Orquestador)
 * Coordina el flujo principal de compra integrando Inventario, Pagos y Notificaciones.
 * Implementa 3 mecanismos clave de resiliencia:
 * 1. Retry con Backoff Exponencial (hacia Inventario)
 * 2. Timeout + Circuit Breaker (hacia Pagos)
 * 3. Fallback + Dead-Letter Queue (hacia Notificaciones)
 */

const express = require('express');
const axios = require('axios');
const http = require('http');

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
//  MECANISMO 1: Retry con Backoff Exponencial y Jitter
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

      const status = err.response?.status;
      const esReintentable = !status || status >= 500;
      if (!esReintentable) throw err; 

      if (intento === intentos) break;

      const espera = baseMs * Math.pow(2, intento - 1);
      const jitter = Math.random() * 100;
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
//  MECANISMO 2: Circuit Breaker y Timestamps
// =============================================================

async function llamarPagos({ reservationId, amount, userId }) {
  const { data } = await axios.post(
    `${PAYMENTS_URL}/payments/charge`,
    { reservationId, amount, userId },
    { timeout: 3000 }
  );
  return data;
}

const breakerPagos = new CircuitBreaker(llamarPagos, {
  timeout: 3000,                
  errorThresholdPercentage: 50, 
  resetTimeout: 10000,          
  volumeThreshold: 3,    
  name: 'payments',
});


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
//  MECANISMO 3: Degradación Elegante y Dead-Letter Queue (DLQ)
// =============================================================

async function notificarConFallback({ reservationId, userId, eventId }) {
  try {
    await axios.post(
      `${NOTIFICATIONS_URL}/notifications/send`,
      { reservationId, userId, eventId, type: 'confirmation' },
      { timeout: 1000 } 
    );
    log('email enviado', { reservationId });
    return { emailSent: true, queued: false };
  } catch (err) {
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

app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));

app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', pod: POD_NAME, node: NODE_NAME });
  } catch (e) {
    res.status(503).json({ status: 'not-ready' });
  }
});

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

app.get('/metrics/dlq', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, reservation_id, error, created_at FROM dead_letter_queue ORDER BY created_at DESC LIMIT 20'
  );
  const { rows: count } = await pool.query('SELECT COUNT(*) FROM dead_letter_queue');
  res.json({ pendientes: parseInt(count[0].count, 10), mensajes: rows });
});

// =============================================================
//  Flujo Principal de Orquestación (Saga Pattern)
// =============================================================

app.post('/reservations', async (req, res) => {
  const { eventId = 'concierto-2026', userId = 'anon', quantity = 1, amount = 50 } = req.body;
  const reservationId = randomUUID();
  const t0 = Date.now();

  log('--- nueva reserva ---', { reservationId, eventId, userId, quantity });

  // PASO 1: Bloqueo de inventario (Protegido por Retry)
  let hold;
  try {
    hold = await conRetry(
      async () => {
        const { data } = await axios.post(
          `${INVENTORY_URL}/inventory/${eventId}/hold`,
          { quantity, reservationId },
          {
            timeout: 800,
            httpAgent: agenteSinKeepAlive,
          }
        );
        return data;
      },
      { intentos: 5, baseMs: 200, etiqueta: 'inventory.hold' }
    );
  } catch (err) {
    if (err.response?.status === 409) {
      log('sin asientos disponibles', { reservationId });
      return res.status(409).json({
        reservationId,
        status: 'REJECTED',
        reason: 'No quedan asientos disponibles',
      });
    }
    
    log('ERROR CONTROLADO: inventario inalcanzable tras todos los reintentos', { reservationId });
    return res.status(503).json({
      reservationId,
      status: 'FAILED',
      reason: 'Servicio de inventario no disponible. Intenta de nuevo en unos momentos.',
    });
  }

  // PASO 2: Procesamiento de Pago (Protegido por Circuit Breaker)
  let payment;
  try {
    payment = await breakerPagos.fire({ reservationId, amount, userId });
    log('pago aprobado', { reservationId, paymentId: payment.paymentId });
  } catch (err) {
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
      tiempoMs: Date.now() - t0, 
    });
  }

  // PASO 3: Persistencia de datos
  await pool.query(
    `INSERT INTO reservations (id, event_id, user_id, quantity, payment_id, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'CONFIRMED',NOW())`,
    [reservationId, eventId, userId, quantity, payment.paymentId]
  );

  // PASO 4: Notificación (Protegida por Fallback + DLQ)
  const notificacion = await notificarConFallback({ reservationId, userId, eventId });

  const tiempoMs = Date.now() - t0;
  log('RESERVA CONFIRMADA', { reservationId, tiempoMs, ...notificacion });

  res.status(201).json({
    reservationId,
    status: 'CONFIRMED',
    eventId,
    quantity,
    asientosRestantes: hold.remaining,
    paymentId: payment.paymentId,
    notificacion: notificacion.emailSent
      ? 'Correo de confirmacion enviado'
      : 'No pudimos enviar el correo ahora; quedo en cola y se enviara automaticamente. Tu entrada esta confirmada.',
    inventarioAtendidoPor: hold.servedBy,
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
//  Worker: Procesamiento en segundo plano de DLQ
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
        
        // Eliminación de la cola tras éxito
        await pool.query('DELETE FROM dead_letter_queue WHERE id = $1', [msg.id]);
        log('DLQ drenada: correo pendiente enviado con exito', {
          reservationId: msg.reservation_id,
        });
      } catch (e) {
      }
    }
  } catch (e) {
  }
}

// Ejecución periódica cada 15 segundos
setInterval(drenarDLQ, 15000);

app.listen(PORT, () => log(`reservas escuchando en :${PORT}`));