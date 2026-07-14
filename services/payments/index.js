// =============================================================
//  SERVICIO DE PAGOS  (STUB / SIMULADO)
// =============================================================
//  Simula una pasarela de pagos externa (tipo Stripe / PayPal).
//
//  IMPORTANTE para la rubrica: el enunciado exige que los stubs
//  simulen "comportamiento realista (latencia variable, fallos
//  aleatorios), no respuestas instantaneas siempre exitosas".
//
//  Por eso, INCLUSO EN MODO NORMAL este servicio:
//    - tarda entre 100ms y 800ms (latencia variable)
//    - falla aleatoriamente el 10% de las veces
//
//  Y ademas tiene un "modo caos" que activamos en la demo para
//  provocar el fallo #2 "La Pasarela Lenta": responde en 20 segundos.
// =============================================================

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

// ---------------- Configuracion del caos ----------------
const caos = {
  // modo "slow": responde en 20 segundos (el fallo de la practica)
  lento: false,
  latenciaLentaMs: parseInt(process.env.SLOW_LATENCY_MS || '20000', 10),

  // comportamiento normal (pero realista, NO perfecto)
  latenciaMinMs: 100,
  latenciaMaxMs: 800,
  tasaFalloNormal: 0.10, // 10% de fallos aleatorios incluso en modo normal
};

app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));

// ---------------- Panel de caos ----------------
// Lo usamos EN VIVO durante la demo:
//   curl -X POST .../chaos -d '{"lento":true}'   -> activa los 20s
//   curl -X POST .../chaos -d '{"lento":false}'  -> vuelve a la normalidad
app.get('/chaos', (_req, res) => res.json(caos));

app.post('/chaos', (req, res) => {
  if (typeof req.body.lento === 'boolean') caos.lento = req.body.lento;
  if (typeof req.body.tasaFalloNormal === 'number') caos.tasaFalloNormal = req.body.tasaFalloNormal;
  log('CAOS RECONFIGURADO', caos);
  res.json({ aplicado: caos });
});

// ---------------- El cobro ----------------
app.post('/payments/charge', async (req, res) => {
  const { reservationId, amount, userId } = req.body;

  if (caos.lento) {
    // ===== FALLO #2: "LA PASARELA LENTA" =====
    // Estamos "saturados". Vamos a tardar 20 segundos.
    // Reservas tiene un timeout de 3s, asi que NUNCA vera esta respuesta:
    // va a cortar la llamada y el Circuit Breaker contara un fallo.
    // Tras 3 fallos con >50% de error, el circuito se ABRE.
    log('CAOS ACTIVO: simulando pasarela saturada', {
      reservationId, tardareMs: caos.latenciaLentaMs,
    });
    await sleep(caos.latenciaLentaMs);
    log('respondiendo (pero el cliente ya se fue hace rato)', { reservationId });
    return res.json({ paymentId: randomUUID(), status: 'APPROVED', tardo: caos.latenciaLentaMs });
  }

  // ---- Comportamiento normal, pero REALISTA ----
  const latencia = Math.floor(
    Math.random() * (caos.latenciaMaxMs - caos.latenciaMinMs) + caos.latenciaMinMs
  );
  await sleep(latencia);

  // Fallos aleatorios: las pasarelas reales fallan a veces.
  if (Math.random() < caos.tasaFalloNormal) {
    log('pago RECHAZADO (fallo aleatorio realista)', { reservationId, latencia });
    return res.status(502).json({ error: 'La pasarela rechazo la transaccion', reservationId });
  }

  const paymentId = randomUUID();
  log('pago APROBADO', { reservationId, paymentId, amount, userId, latencia });
  res.json({ paymentId, status: 'APPROVED', amount, latencia });
});

app.listen(PORT, () => log(`pagos escuchando en :${PORT}`));
