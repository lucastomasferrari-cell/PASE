// Helper compartido para llamar /v1/payments/search con cobertura óptima
// (incluye Point Smart cuando el shard responde) + paginación + reintentos.
//
// Por qué este endpoint y no settlement/release:
//   - settlement_report tiene whitelist de TRANSACTION_TYPE incompleta
//     (falta TIP, ciertos POS, débitos automáticos).
//   - release_report agrupa por release_date — los Point Smart con tarjeta
//     de crédito se liberan T+10, no aparecen en el día calendario.
//   - payments/search (range=date_created) muestra cobros AL MOMENTO DEL
//     COBRO — coincide con la vista del usuario en la UI de MP.
//
// Caveat conocido: payments/search tiene "shard inconsistency" — algunas
// llamadas devuelven Point Smart, otras no, según routing del backend MP.
// Para mitigarlo:
//   1. Hardcodear los params canónicos que MAXIMIZAN la chance del shard
//      bueno (sin sort, sin status, sin operation_type, range=date_created,
//      limit=100). Cualquier param adicional o cambio fuerza un code path
//      MP que excluye POS.
//   2. Append-only en DB: nunca borrar filas pay-* solo porque una llamada
//      no las devolvió. Eventualmente otra llamada las recupera.
//   3. Lotería opcional: reintentar la llamada hasta N veces si el total
//      vino bajo un threshold conocido. En el cron deja threshold=0
//      (no lotería) — la persistencia append-only se encarga.

const PAYMENTS_SEARCH_URL = 'https://api.mercadopago.com/v1/payments/search';

/**
 * Obtiene todos los payments para una ventana de fechas, paginando hasta
 * agotar paging.total. Con lotería opcional contra el shard bug.
 *
 * @param {string} token - Access token MP.
 * @param {string} beginIso - ISO con timezone, ej. '2026-05-01T00:00:00.000-03:00'.
 * @param {string} endIso - ISO con timezone (exclusive).
 * @param {object} options
 *   - threshold {number} default 0. Si >0 y la primera pasada devuelve
 *     menos que threshold, reintenta lotería.
 *   - lotteryMaxAttempts {number} default 8. Cap del loop de lotería.
 *   - fetchRetries {number} default 3. Reintentos exponenciales por call
 *     ante 429/5xx.
 *   - pageLimit {number} default 100. NO subir — el shard bug aparece con
 *     limit > 100.
 *   - maxPages {number} default 50. Cap defensivo contra loop infinito.
 *   - fetchFn {function} default globalThis.fetch. Inyectable para tests.
 *   - log {function} default no-op. Recibe objetos {event, ...}.
 *
 * @returns {Promise<{payments, pages, pagingTotal, lotteryAttempts, firstRequestId}>}
 */
export async function fetchPaymentsByDateCreated(token, beginIso, endIso, options = {}) {
  const {
    threshold = 0,
    lotteryMaxAttempts = 8,
    fetchRetries = 3,
    pageLimit = 100,
    maxPages = 50,
    fetchFn = globalThis.fetch,
    log = () => {},
  } = options;

  if (!token) throw new Error('token requerido');
  if (!beginIso || !endIso) throw new Error('beginIso/endIso requeridos');

  let bestResult = null;
  let attempts = 0;
  let lastError = null;

  for (let i = 1; i <= Math.max(1, lotteryMaxAttempts); i++) {
    attempts++;
    try {
      const result = await fetchSinglePass({
        token, beginIso, endIso, pageLimit, maxPages, fetchRetries, fetchFn, log,
      });
      log({
        event: 'pass_done',
        attempt: i,
        payments: result.payments.length,
        pagingTotal: result.pagingTotal,
        firstRequestId: result.firstRequestId,
      });
      if (!bestResult || result.payments.length > bestResult.payments.length) {
        bestResult = result;
      }
      // Si no hay lotería activa O ya superamos el threshold → cortar.
      if (threshold <= 0) break;
      if (result.payments.length >= threshold) break;
      log({ event: 'below_threshold', attempt: i, threshold, got: result.payments.length });
    } catch (e) {
      lastError = e;
      log({ event: 'pass_failed', attempt: i, error: String(e?.message || e) });
    }
  }

  if (!bestResult) {
    throw lastError || new Error('payments/search: no result tras lotería');
  }
  return { ...bestResult, lotteryAttempts: attempts };
}

async function fetchSinglePass({ token, beginIso, endIso, pageLimit, maxPages, fetchRetries, fetchFn, log }) {
  const all = [];
  let offset = 0;
  let pages = 0;
  let pagingTotal = null;
  let firstRequestId = null;

  while (pages < maxPages) {
    const url = `${PAYMENTS_SEARCH_URL}?` +
      `range=date_created&` +
      `begin_date=${encodeURIComponent(beginIso)}&end_date=${encodeURIComponent(endIso)}&` +
      `limit=${pageLimit}&offset=${offset}`;

    const r = await fetchWithBackoff({ url, token, retries: fetchRetries, fetchFn, log });
    if (firstRequestId == null) {
      firstRequestId = (r.headers?.get?.('x-request-id')) || null;
    }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      throw new Error(`payments/search ${r.status}: ${body}`);
    }
    const data = await r.json();
    if (pagingTotal == null) pagingTotal = data?.paging?.total ?? null;
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    pages++;
    if (results.length < pageLimit) break;
    offset += pageLimit;
  }

  return { payments: all, pages, pagingTotal, firstRequestId };
}

async function fetchWithBackoff({ url, token, retries, fetchFn, log }) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) {
      const delay = Math.pow(2, i - 1) * 1000;
      log({ event: 'backoff_wait', attempt: i, delay });
      await new Promise(r => setTimeout(r, delay));
    }
    let r;
    try {
      r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (e) {
      lastErr = e;
      log({ event: 'fetch_threw', attempt: i, error: String(e?.message || e) });
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      lastErr = new Error(`retryable status ${r.status}`);
      log({ event: 'retryable_status', attempt: i, status: r.status });
      // Drenar body para liberar conexión
      try { await r.text(); } catch {}
      continue;
    }
    return r;
  }
  throw lastErr || new Error('fetchWithBackoff: exhausted');
}

/**
 * Convierte un objeto payment de MP a un array de filas listas para upsert en
 * mp_movimientos. Devuelve:
 *   - 1 fila { skipped: true, reason } cuando el payment se descarta.
 *   - 1 fila main { skipped: false, row: <pay-*> } cuando NO aplica fee.
 *   - 2 filas [main, fee] cuando es un ingreso con comisión MP > 0; fee es
 *     una fila tipo='fee' con id 'fee-{payment.id}', monto negativo igual a
 *     (transaction_amount - net_received_amount), y referencia_id apuntando
 *     al mismo payment.id que el main. Esa estructura permite a la pestaña
 *     "Comisiones MP" linkear el fee con su padre vía referencia_id.
 *
 * Convenciones del main (pay-*):
 *  - id: 'pay-{payment.id}'.
 *  - referencia_id: payment.id (string puro). NO usamos external_reference
 *    para evitar colisión con set-/rr- referencia_id en el dedup retroactivo.
 *  - fecha: date_created tal cual viene de MP (ISO con offset).
 *  - signo: positivo cuando ourAccountId === collector_id (Lucas cobra),
 *    negativo cuando collector_id es otro (Lucas paga).
 *  - Transferencias internas (collector == payer == ourAccountId) se skipean.
 *  - Status != 'approved' se skipea.
 *
 * Convenciones del fee (fee-*):
 *  - Solo se emite para ingresos con commission > 0. En egresos no aplica
 *    (Lucas paga, otro recibe; el fee implícito es del receptor).
 *  - referencia_id == payment.id (igual al main) → permite lookup en pestaña.
 *  - medio_pago heredado del main para conservar la pista POI.
 */
export function mapPaymentToRows(payment, cred, ourAccountId) {
  if (!payment || payment.status !== 'approved') {
    return [{ skipped: true, reason: 'not_approved' }];
  }

  const collectorId = Number(payment.collector_id ?? payment.collector?.id ?? 0);
  const payerId = Number(payment.payer?.id ?? 0);
  const ourId = Number(ourAccountId);

  if (collectorId === ourId && payerId === ourId) {
    return [{ skipped: true, reason: 'internal_transfer' }];
  }

  const isIngress = collectorId === ourId;
  const transactionAmount = Number(payment.transaction_amount) || 0;
  const netReceived = Number(payment.transaction_details?.net_received_amount) || 0;
  const poi = payment.point_of_interaction?.type || null;
  const method = payment.payment_method_id || null;

  let monto, tipo, descripcion, medioPago;
  if (isIngress) {
    monto = netReceived;
    tipo = 'liquidacion';
    if (poi === 'POINT') {
      descripcion = `Point Smart — ${method}`;
      medioPago = `point_smart_${method}`;
    } else if (poi === 'INSTORE') {
      descripcion = payment.description || `QR — ${method}`;
      medioPago = `qr_${method}`;
    } else if (poi === 'CHECKOUT') {
      descripcion = payment.description || `Checkout — ${method}`;
      medioPago = method;
    } else if (poi === 'SUBSCRIPTIONS') {
      descripcion = payment.description || `Suscripción — ${method}`;
      medioPago = method;
    } else {
      descripcion = payment.description || `${poi || 'MP'} — ${method}`;
      medioPago = method;
    }
  } else {
    monto = -transactionAmount;
    tipo = 'bank_transfer';
    descripcion = payment.description || `Egreso MP — ${method}`;
    medioPago = method;
  }

  if (monto === 0) return [{ skipped: true, reason: 'monto_cero' }];

  const mainRow = {
    id: `pay-${payment.id}`,
    local_id: cred.local_id,
    tenant_id: cred.tenant_id,
    fecha: payment.date_created,
    tipo,
    descripcion: (descripcion || '').slice(0, 200),
    monto: Math.round(monto * 100) / 100,
    saldo: null,
    estado: 'approved',
    referencia_id: String(payment.id),
    medio_pago: medioPago,
  };

  // Fila fee solo para ingresos con comisión real (> 1 centavo).
  // En egresos no aplica (Lucas paga el bruto, no recibe nada → no hay fee
  // del lado de Lucas). Tampoco si transaction == net (cuenta saldo MP).
  const commission = transactionAmount - netReceived;
  if (!isIngress || !(commission > 0.01)) {
    return [{ skipped: false, row: mainRow }];
  }

  const feeRow = {
    id: `fee-${payment.id}`,
    local_id: cred.local_id,
    tenant_id: cred.tenant_id,
    fecha: payment.date_created,
    tipo: 'fee',
    descripcion: `Comisión ${descripcion || 'MP'}`.slice(0, 200),
    monto: -Math.round(commission * 100) / 100,
    saldo: null,
    estado: 'approved',
    referencia_id: String(payment.id),  // mismo que el main → permite lookup
    medio_pago: medioPago,
  };

  return [
    { skipped: false, row: mainRow },
    { skipped: false, row: feeRow },
  ];
}

/**
 * Formato ISO con offset -03:00 para una Date interpretada como UTC.
 * Útil para construir begin_date/end_date de la API MP en horario AR.
 */
export function formatArIso(date) {
  const arTime = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const yyyy = arTime.getUTCFullYear();
  const mm = pad(arTime.getUTCMonth() + 1);
  const dd = pad(arTime.getUTCDate());
  const HH = pad(arTime.getUTCHours());
  const MM = pad(arTime.getUTCMinutes());
  const SS = pad(arTime.getUTCSeconds());
  const ms = pad(arTime.getUTCMilliseconds(), 3);
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}.${ms}-03:00`;
}
