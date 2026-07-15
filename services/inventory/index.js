/**
 * Servicio de Inventario
 * Responsabilidad: Gestión de disponibilidad de asientos y prevención de sobreventa.
 * Implementa bloqueo pesimista en base de datos y simulación de fallos para entornos de alta disponibilidad.
 */

const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const POD_NAME = process.env.POD_NAME || 'inventory-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';


const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'ticketing',
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 10000,
  max: 10,
});


const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'inventory',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));


let caido = false;

app.get('/chaos', (_req, res) => res.json({ caido, pod: POD_NAME, node: NODE_NAME }));

app.post('/chaos', (req, res) => {
  if (typeof req.body.caido === 'boolean') caido = req.body.caido;
  log(caido ? 'CAOS ACTIVADO: este pod se declara CAIDO' : 'CAOS DESACTIVADO: pod sano', { caido });
  res.json({ caido, pod: POD_NAME, node: NODE_NAME });
});


app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));

app.get('/readyz', async (_req, res) => {
  if (caido) {
    return res.status(503).json({ status: 'not-ready', motivo: 'modo caos', pod: POD_NAME });
  }
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', pod: POD_NAME, node: NODE_NAME });
  } catch (e) {
    res.status(503).json({ status: 'not-ready', error: e.message });
  }
});


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


app.post('/inventory/:eventId/hold', async (req, res) => {
  const { eventId } = req.params;
  const { quantity = 1, reservationId } = req.body;

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
      await client.query('ROLLBACK');
      log('RECHAZADO por falta de asientos', { eventId, available, quantity, reservationId });
      return res.status(409).json({
        error: 'asientos insuficientes',
        available,
        servedBy: { pod: POD_NAME, node: NODE_NAME },
      });
    }

    const { rows: updated } = await client.query(
      `UPDATE seats SET available_seats = available_seats - $1
       WHERE event_id = $2 RETURNING available_seats`,
      [quantity, eventId]
    );

    await client.query('COMMIT'); 
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
    client.release();
  }
});


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


app.post('/admin/reset', async (_req, res) => {
  await pool.query('UPDATE seats SET available_seats = total_seats');
  await pool.query('DELETE FROM reservations');
  await pool.query('DELETE FROM dead_letter_queue');
  log('inventario reseteado');
  res.json({ reset: true });
});

app.listen(PORT, () => log(`inventario escuchando en :${PORT}`));