// =============================================================
//  SERVICIO DE INVENTARIO
// =============================================================
//  Responsabilidad: saber cuantos asientos quedan y descontarlos.
//
//  Aqui vive la defensa contra el fallo #6 "Condicion de Carrera":
//  usamos BLOQUEO PESIMISTA (SELECT ... FOR UPDATE) para que dos
//  compradores del ultimo asiento NO puedan leer "queda 1" al mismo
//  tiempo. El segundo se queda esperando en la fila del candado.
//
//  Este servicio corre con 2 REPLICAS, una en cada nodo del cluster.
//  Por eso, si matas un pod (fallo #1 "Inventario Fantasma"), el otro
//  sigue atendiendo y el retry de Reservas lo encuentra.
// =============================================================

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
// Kubernetes nos inyecta el nombre del pod y del nodo (ver el YAML).
// Los devolvemos en cada respuesta para PROBAR en la demo que las
// peticiones se estan repartiendo entre los dos nodos.
const POD_NAME = process.env.POD_NAME || 'inventory-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'ticketing',
  // Timeouts cortos: si la BD desaparece (fallo #4 "BD Intermitente")
  // queremos enterarnos rapido, no quedarnos colgados 30 segundos.
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 10000,
  max: 10,
});

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'inventory',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));

// =============================================================
//  MODO CAOS  (para el fallo #1 "El Inventario Fantasma")
// =============================================================
//  Simula que ESTE pod se rompio, pero sigue en pie.
//
//  Por que asi y no matando el proceso?
//
//  1) No se puede: el kernel de Linux IGNORA las senales dirigidas
//     al PID 1 cuando no tiene handler (proteccion para que un
//     contenedor no se suicide). El `kill -9 1` devuelve exito
//     pero el proceso sigue vivo.
//
//  2) Y aunque se pudiera, `kubectl delete pod` seria una muerte
//     AVISADA: k8s saca el pod del Service ANTES de matarlo, el
//     trafico se redirige limpiamente y el RETRY NUNCA SE DISPARA.
//
//  Este modo simula algo MAS REALISTA que un crash: un servicio
//  "vivo pero roto" (agoto su pool de conexiones, perdio la BD...).
//  Es el fallo mas comun en produccion, y el mas peligroso, porque
//  el servicio sigue ACEPTANDO conexiones y fallandolas.
//
//  Que pasa al activarlo:
//    - /readyz devuelve 503  -> k8s empieza a sacarlo del Service
//      (tarda ~6s: la readinessProbe falla 2 veces cada 3s)
//    - /hold  devuelve 503   -> durante ESA VENTANA, las peticiones
//      que le lleguen FALLAN de verdad
//    - y ahi es donde el RETRY de Reservas hace su trabajo:
//      reintenta con backoff y el Service lo manda a la replica VIVA.
// =============================================================
let caido = false;

app.get('/chaos', (_req, res) => res.json({ caido, pod: POD_NAME, node: NODE_NAME }));

app.post('/chaos', (req, res) => {
  if (typeof req.body.caido === 'boolean') caido = req.body.caido;
  log(caido ? 'CAOS ACTIVADO: este pod se declara CAIDO' : 'CAOS DESACTIVADO: pod sano', { caido });
  res.json({ caido, pod: POD_NAME, node: NODE_NAME });
});

// ---------------- Health checks ----------------
// Kubernetes llama a estos endpoints. /healthz dice "estoy vivo",
// /readyz dice "estoy listo para recibir trafico".
app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));

app.get('/readyz', async (_req, res) => {
  // Si estamos en modo caos, nos declaramos NO LISTOS.
  // k8s lo detectara y nos sacara del Service... pero tarda unos
  // segundos. Esa ventana es la que prueba el retry.
  if (caido) {
    return res.status(503).json({ status: 'not-ready', motivo: 'modo caos', pod: POD_NAME });
  }
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', pod: POD_NAME, node: NODE_NAME });
  } catch (e) {
    // Si no hay BD, nos declaramos NO listos y k8s deja de mandarnos trafico.
    res.status(503).json({ status: 'not-ready', error: e.message });
  }
});

// ---------------- Consultar disponibilidad ----------------
app.get('/inventory/:eventId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT event_id, total_seats, available_seats FROM seats WHERE event_id = $1',
      [req.params.eventId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'evento no encontrado' });
    res.json({ ...rows[0], servedBy: { pod: POD_NAME, node: NODE_NAME } });
  } catch (e) {
    log('error consultando inventario', { error: e.message });
    res.status(503).json({ error: 'base de datos no disponible' });
  }
});

// =============================================================
//  DEFENSA #4 -> BLOQUEO PESIMISTA (fallo "Condicion de Carrera")
// =============================================================
//  El bug clasico seria hacer esto en DOS pasos:
//      1) SELECT available_seats  -> los dos leen "1"
//      2) UPDATE available = 0    -> los dos creen que ganaron  (OVERSELLING)
//
//  La solucion: una sola TRANSACCION con FOR UPDATE.
//  El primero en llegar toma el candado sobre la fila. El segundo
//  se BLOQUEA en el SELECT hasta que el primero hace COMMIT, y
//  cuando por fin lee, ve available_seats = 0 y se le rechaza.
//  Nunca hay dos ganadores.
// =============================================================
app.post('/inventory/:eventId/hold', async (req, res) => {
  const { eventId } = req.params;
  const { quantity = 1, reservationId } = req.body;

  // ---- MODO CAOS ----
  // Este pod esta "roto": sigue aceptando conexiones pero las falla.
  // Devolvemos 503 (error de servidor) -> Reservas lo considera
  // REINTENTABLE y dispara el retry con backoff.
  if (caido) {
    log('CAOS: rechazando peticion (este pod esta caido)', { reservationId, eventId });
    return res.status(503).json({
      error: 'inventario no disponible',
      pod: POD_NAME,
      node: NODE_NAME,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- EL CANDADO ----
    // FOR UPDATE = "nadie mas puede tocar esta fila hasta que yo termine".
    const { rows } = await client.query(
      'SELECT available_seats FROM seats WHERE event_id = $1 FOR UPDATE',
      [eventId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'evento no encontrado' });
    }

    const available = rows[0].available_seats;
    log('candado adquirido', { eventId, available, reservationId });

    if (available < quantity) {
      // Perdio la carrera. Rechazo limpio, sin overselling.
      await client.query('ROLLBACK');
      log('RECHAZADO por falta de asientos', { eventId, available, quantity, reservationId });
      return res.status(409).json({
        error: 'asientos insuficientes',
        available,
        servedBy: { pod: POD_NAME, node: NODE_NAME },
      });
    }

    // Gano la carrera. Descuenta.
    const { rows: updated } = await client.query(
      `UPDATE seats SET available_seats = available_seats - $1
       WHERE event_id = $2 RETURNING available_seats`,
      [quantity, eventId]
    );

    await client.query('COMMIT'); // <- aqui se suelta el candado
    log('HOLD confirmado', {
      eventId, quantity, reservationId, remaining: updated[0].available_seats,
    });

    res.json({
      held: quantity,
      remaining: updated[0].available_seats,
      servedBy: { pod: POD_NAME, node: NODE_NAME },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    log('error en hold', { error: e.message, eventId });
    res.status(503).json({ error: 'inventario no disponible', detail: e.message });
  } finally {
    client.release(); // devolver la conexion al pool SIEMPRE
  }
});

// ---------------- Liberar asientos (compensacion) ----------------
// Si el pago falla, Reservas nos llama aqui para devolver el asiento.
// Esto es, en pequeno, un paso de COMPENSACION del patron Saga.
app.post('/inventory/:eventId/release', async (req, res) => {
  const { eventId } = req.params;
  const { quantity = 1, reservationId } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE seats SET available_seats = available_seats + $1
       WHERE event_id = $2 RETURNING available_seats`,
      [quantity, eventId]
    );
    log('RELEASE (compensacion Saga)', {
      eventId, quantity, reservationId, remaining: rows[0]?.available_seats,
    });
    res.json({ released: quantity, remaining: rows[0]?.available_seats });
  } catch (e) {
    log('error en release', { error: e.message });
    res.status(503).json({ error: 'no se pudo liberar' });
  }
});

// ---------------- Reset (solo para las demos) ----------------
app.post('/admin/reset', async (_req, res) => {
  await pool.query('UPDATE seats SET available_seats = total_seats');
  await pool.query('DELETE FROM reservations');
  await pool.query('DELETE FROM dead_letter_queue');
  log('inventario reseteado');
  res.json({ reset: true });
});

app.listen(PORT, () => log(`inventario escuchando en :${PORT}`));
