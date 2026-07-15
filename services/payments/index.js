/**
 * Servicio de Pagos (Simulador / Stub)
 * Emula el comportamiento de una pasarela de pagos externa (ej. Stripe, PayPal).
 * Diseñado para simular condiciones de red realistas (latencia variable y fallos estocásticos)
 * e incluye un modo de "caos" para probar la resiliencia del sistema (Timeouts y Circuit Breaker).
 */

const express = require('express');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POD_NAME = process.env.POD_NAME || 'payments-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';

const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'payments',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const caos = {
  lento: false,
  latenciaLentaMs: parseInt(process.env.SLOW_LATENCY_MS || '20000', 10),

  latenciaMinMs: 100,
  latenciaMaxMs: 800,
  tasaFalloNormal: 0.10, 
};


app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));


app.get('/chaos', (_req, res) => res.json(caos));

app.post('/chaos', (req, res) => {
  if (typeof req.body.lento === 'boolean') caos.lento = req.body.lento;
  if (typeof req.body.tasaFalloNormal === 'number') caos.tasaFalloNormal = req.body.tasaFalloNormal;
  log('CAOS RECONFIGURADO', caos);
  res.json({ aplicado: caos });
});


app.post('/payments/charge', async (req, res) => {
  const { reservationId, amount, userId } = req.body;

  if (caos.lento) {
    log('CAOS ACTIVO: simulando pasarela saturada', {
      reservationId, tardareMs: caos.latenciaLentaMs,
    });
    await sleep(caos.latenciaLentaMs);
    
    log('respondiendo (pero el cliente ya se fue hace rato)', { reservationId });
    return res.json({ paymentId: randomUUID(), status: 'APPROVED', tardo: caos.latenciaLentaMs });
  }

  const latencia = Math.floor(
    Math.random() * (caos.latenciaMaxMs - caos.latenciaMinMs) + caos.latenciaMinMs
  );
  await sleep(latencia);

  if (Math.random() < caos.tasaFalloNormal) {
    log('pago RECHAZADO (fallo aleatorio realista)', { reservationId, latencia });
    return res.status(502).json({ error: 'La pasarela rechazo la transaccion', reservationId });
  }

  const paymentId = randomUUID();
  log('pago APROBADO', { reservationId, paymentId, amount, userId, latencia });
  res.json({ paymentId, status: 'APPROVED', amount, latencia });
});

app.listen(PORT, () => log(`pagos escuchando en :${PORT}`));