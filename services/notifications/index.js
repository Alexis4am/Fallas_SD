/**
 * Servicio de Notificaciones (Simulador / Stub)
 * Servicio no crítico responsable del envío de correos de confirmación.
 * Diseñado para simular fallos e interrupciones, permitiendo evaluar la 
 * degradación elegante del sistema y el comportamiento de la Dead Letter Queue (DLQ).
 */

const express = require('express');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const POD_NAME = process.env.POD_NAME || 'notifications-local';
const NODE_NAME = process.env.NODE_NAME || 'node-local';


const log = (msg, extra = {}) =>
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: 'notifications',
    pod: POD_NAME, node: NODE_NAME, msg, ...extra,
  }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const caos = {
  tasaFallo: parseFloat(process.env.FAILURE_RATE || '0.15'),
  latenciaMinMs: 50,
  latenciaMaxMs: 400,
};


app.get('/healthz', (_req, res) => res.json({ status: 'ok', pod: POD_NAME, node: NODE_NAME }));
app.get('/readyz', (_req, res) => res.json({ status: 'ready' }));

app.get('/chaos', (_req, res) => res.json(caos));

app.post('/chaos', (req, res) => {
  if (typeof req.body.tasaFallo === 'number') caos.tasaFallo = req.body.tasaFallo;
  log('CAOS RECONFIGURADO', caos);
  res.json({ aplicado: caos });
});


let enviados = 0;


app.get('/metrics', (_req, res) => res.json({ correosEnviados: enviados, pod: POD_NAME }));


app.post('/notifications/send', async (req, res) => {
  const { reservationId, userId, type } = req.body;

  const latencia = Math.floor(
    Math.random() * (caos.latenciaMaxMs - caos.latenciaMinMs) + caos.latenciaMinMs
  );
  await sleep(latencia);

  if (Math.random() < caos.tasaFallo) {
    log('fallo al enviar el correo (aleatorio realista)', { reservationId });
    return res.status(500).json({ error: 'El servidor SMTP rechazo el mensaje', reservationId });
  }

  enviados++;
  const messageId = randomUUID();
  log('correo ENVIADO', { reservationId, userId, type, messageId, totalEnviados: enviados });
  res.json({ messageId, status: 'SENT', reservationId });
});

app.listen(PORT, () => log(`notificaciones escuchando en :${PORT}`));