/**
 * API Gateway
 * Puerta de entrada única del sistema. Enruta el tráfico hacia los microservicios internos.
 * Implementa el patrón Bulkhead para limitar la concurrencia y prevenir el colapso en cascada 
 * bajo picos de alta demanda, rechazando el tráfico excedente de forma rápida (Fail Fast).
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POD_NAME = process.env.POD_NAME || 'gateway-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';
const RESERVATIONS_URL = process.env.RESERVATIONS_URL || 'http://reservations:3000';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory:3000';

const MAX_CONCURRENTES = parseInt(process.env.MAX_CONCURRENT || '20', 10);

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'gateway',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));


let enVuelo = 0;     
let rechazadas = 0;  
let aceptadas = 0;    


function bulkhead(req, res, next) {
  if (enVuelo >= MAX_CONCURRENTES) {
    rechazadas++;
    log('BULKHEAD: capacidad llena -> rechazo rapido (429)', {
      enVuelo, limite: MAX_CONCURRENTES, rechazadasTotal: rechazadas,
    });
    
    return res.status(429).json({
      error: 'Sistema con alta demanda. Por favor intenta de nuevo en unos segundos.',
      retryAfter: 2,
    });
  }

  enVuelo++;
  aceptadas++;
  
  res.on('finish', () => { enVuelo--; });
  next();
}


app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready', pod: POD_NAME, node: NODE_NAME }));


app.get('/metrics/bulkhead', (_req, res) => {
  res.json({
    enVueloAhora: enVuelo,
    limite: MAX_CONCURRENTES,
    aceptadasTotal: aceptadas,
    rechazadasTotal: rechazadas,
    pod: POD_NAME, node: NODE_NAME,
  });
});


app.post('/api/reservations', bulkhead, async (req, res) => {
  try {
    const { data, status } = await axios.post(
      `${RESERVATIONS_URL}/reservations`,
      req.body,
      { timeout: 15000, validateStatus: () => true }
    );
    res.status(status).json(data);
  } catch (err) {
    log('reservas inalcanzable desde el gateway', { error: err.message });
    res.status(503).json({ error: 'Servicio de reservas no disponible' });
  }
});


app.get('/api/inventory/:eventId', bulkhead, async (req, res) => {
  try {
    const { data, status } = await axios.get(
      `${INVENTORY_URL}/inventory/${req.params.eventId}`,
      { timeout: 3000, validateStatus: () => true }
    );
    res.status(status).json(data);
  } catch (err) {
    res.status(503).json({ error: 'Servicio de inventario no disponible' });
  }
});


app.get('/api/metrics/circuit', async (_req, res) => {
  try {
    const { data } = await axios.get(`${RESERVATIONS_URL}/metrics/circuit`, { timeout: 3000 });
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/metrics/dlq', async (_req, res) => {
  try {
    const { data } = await axios.get(`${RESERVATIONS_URL}/metrics/dlq`, { timeout: 3000 });
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post('/api/admin/reset', async (_req, res) => {
  try {
    const { data } = await axios.post(`${INVENTORY_URL}/admin/reset`, {}, { timeout: 5000 });
    rechazadas = 0; aceptadas = 0; 
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.listen(PORT, () =>
  log(`gateway escuchando en :${PORT}`, { bulkheadLimite: MAX_CONCURRENTES }));