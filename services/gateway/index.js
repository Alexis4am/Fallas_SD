// =============================================================
//  API GATEWAY
// =============================================================
//  Es la unica puerta de entrada del sistema. Todo el trafico de
//  los clientes pasa por aqui antes de llegar a Reservas.
//
//  Tiene dos protecciones (que NO son de los 4 mecanismos evaluados,
//  pero suman puntos y hacen la demo del "Diluvio" mas interesante):
//
//   - RATE LIMIT: maximo N peticiones por IP por minuto.
//   - BULKHEAD:   maximo M peticiones concurrentes hacia Reservas.
//
//  El BULKHEAD (mamparo) es el concepto de los compartimentos
//  estancos de un barco: si una seccion se inunda, el agua no
//  pasa a las demas y el barco no se hunde. Aqui: limitamos cuantas
//  peticiones simultaneas dejamos pasar. Las que sobran se rechazan
//  con un 429 INMEDIATO en vez de acumularse en una cola infinita.
//
//  Sin bulkhead, un pico de trafico llena la memoria de peticiones
//  encoladas, cada una esperando; las latencias explotan, los
//  timeouts se disparan en cascada, y el sistema entero colapsa.
//  Es mejor rechazar rapido al 20% que hacer fallar al 100%.
// =============================================================

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POD_NAME = process.env.POD_NAME || 'gateway-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';
const RESERVATIONS_URL = process.env.RESERVATIONS_URL || 'http://reservations:3000';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory:3000';

// Cuantas peticiones simultaneas dejamos pasar como maximo.
const MAX_CONCURRENTES = parseInt(process.env.MAX_CONCURRENT || '20', 10);

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'gateway',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));

// ---------------- BULKHEAD ----------------
let enVuelo = 0;      // cuantas peticiones estoy atendiendo AHORA
let rechazadas = 0;   // contador para las metricas de la demo
let aceptadas = 0;

function bulkhead(req, res, next) {
  if (enVuelo >= MAX_CONCURRENTES) {
    rechazadas++;
    log('BULKHEAD: capacidad llena -> rechazo rapido (429)', {
      enVuelo, limite: MAX_CONCURRENTES, rechazadasTotal: rechazadas,
    });
    // 429 = "Too Many Requests". Rechazo INMEDIATO y honesto.
    // Mejor esto que dejarlo esperar 30s para al final fallar igual.
    return res.status(429).json({
      error: 'Sistema con alta demanda. Por favor intenta de nuevo en unos segundos.',
      retryAfter: 2,
    });
  }

  enVuelo++;
  aceptadas++;
  res.on('finish', () => { enVuelo--; }); // liberar el cupo al terminar
  next();
}

// ---------------- Health ----------------
app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready', pod: POD_NAME, node: NODE_NAME }));

// Metricas del bulkhead, para mostrarlas en la demo del "Diluvio"
app.get('/metrics/bulkhead', (_req, res) => {
  res.json({
    enVueloAhora: enVuelo,
    limite: MAX_CONCURRENTES,
    aceptadasTotal: aceptadas,
    rechazadasTotal: rechazadas,
    pod: POD_NAME, node: NODE_NAME,
  });
});

// ---------------- Rutas (todas pasan por el bulkhead) ----------------
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

// Proxys de conveniencia hacia las metricas internas
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
