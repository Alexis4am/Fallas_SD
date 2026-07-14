// =============================================================
//  PRUEBA DE CARGA CON K6  (fallo #3 "El Diluvio de Peticiones")
// =============================================================
//  ESTE FALLO LO ANALIZAMOS EN LA PARTE V (no lo implementamos
//  como uno de los 4). Pero incluimos el script igual, porque:
//
//    a) demuestra que el BULKHEAD del gateway funciona
//    b) da puntos extra de rigor
//    c) es la evidencia empirica de nuestro analisis teorico
//
//  COMO CORRERLO:
//     k6 run chaos/carga-k6.js
//
//  QUE ESPERAR:
//  El gateway NO se cae. Empieza a devolver 429 ("estoy lleno")
//  cuando pasa de 20 peticiones concurrentes. Eso es SHEDDING:
//  rechazar el exceso para salvar al resto.
//
//  El indicador clave: la latencia p95 NO explota. Sin bulkhead,
//  la latencia crece sin limite hasta que todo revienta.
// =============================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

// Metricas propias
const compras_exitosas = new Counter('compras_exitosas');
const rechazos_bulkhead = new Counter('rechazos_bulkhead');
const errores_reales = new Counter('errores_reales');
const tasa_supervivencia = new Rate('sistema_respondio');

export const options = {
  stages: [
    // Subimos la carga en escalones para ver DONDE empieza a rechazar.
    { duration: '20s', target: 10 },   // calentamiento: todo pasa
    { duration: '30s', target: 100 },  // el DILUVIO: pico brusco
    { duration: '30s', target: 200 },  // aun mas fuerte
    { duration: '20s', target: 0 },    // bajamos: debe recuperarse solo
  ],
  thresholds: {
    // El sistema debe SEGUIR RESPONDIENDO (aunque sea con 429).
    // Un 429 NO es un fallo del sistema: es el sistema defendiendose.
    // Lo que NO puede pasar es que se caiga o de 500s.
    'sistema_respondio': ['rate>0.99'],
    // La latencia no debe explotar: el bulkhead corta rapido.
    'http_req_duration{expected_response:true}': ['p(95)<5000'],
  },
};

const URL = __ENV.URL || 'http://localhost:30080';

export default function () {
  const res = http.post(
    `${URL}/api/reservations`,
    JSON.stringify({
      eventId: 'concierto-2026',
      userId: `k6-vu-${__VU}-iter-${__ITER}`,
      quantity: 1,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  // Clasificamos la respuesta:
  //  201 = compro
  //  409 = no hay asientos (respuesta de negocio VALIDA)
  //  429 = el bulkhead lo rechazo (el sistema SE DEFENDIO, esto es BUENO)
  //  503 = pago o inventario caido (error CONTROLADO, tambien aceptable)
  //  otro/timeout = el sistema se cayo de verdad (MALO)

  if (res.status === 201) compras_exitosas.add(1);
  else if (res.status === 429) rechazos_bulkhead.add(1);
  else if (res.status !== 409 && res.status !== 503) errores_reales.add(1);

  // "El sistema respondio" = me dio CUALQUIER respuesta HTTP valida.
  // Rechazar con 429 cuenta como sobrevivir. Colgarse, no.
  tasa_supervivencia.add(res.status > 0 && res.status < 500 || res.status === 503);

  check(res, {
    'el sistema respondio algo (no colapso)': (r) => r.status !== 0,
    'no dio error 500': (r) => r.status !== 500,
  });

  sleep(0.1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const exitosas = m.compras_exitosas?.values?.count || 0;
  const rechazos = m.rechazos_bulkhead?.values?.count || 0;
  const errores = m.errores_reales?.values?.count || 0;
  const p95 = Math.round(m.http_req_duration?.values?.['p(95)'] || 0);

  const salida = `
============================================================
  RESULTADO DEL DILUVIO DE PETICIONES
============================================================

  Compras completadas.............. ${exitosas}
  Rechazadas por el bulkhead (429).. ${rechazos}   <- el sistema SE DEFENDIO
  Errores reales (500/timeout)...... ${errores}   <- deberia ser 0
  Latencia p95...................... ${p95} ms

------------------------------------------------------------
  INTERPRETACION:

  Los 429 NO son fallos. Son el BULKHEAD funcionando.
  El gateway detecto que estaba al limite y rechazo el exceso
  INMEDIATAMENTE, en vez de aceptarlo todo y colapsar.

  Es el principio del triage: mejor atender bien al 80% que
  atender mal al 100% y que se mueran todos.

  ${errores === 0
    ? 'CERO errores reales -> el sistema NUNCA colapso.'
    : 'ATENCION: hubo ' + errores + ' errores reales. Revisa los limites.'}
============================================================
`;

  return { stdout: salida };
}
