// ⚠️ ENDPOINT TEMPORAL — borrar después del diagnóstico de Point Smart 1/5/2026.
//
// Compara 3 fuentes de la MP API para el 1/5/2026 lado a lado, sin tocar DB:
//   1. /v1/account/settlement_report  (último CSV, filas con SETTLEMENT_DATE = 1/5)
//   2. /v1/account/release_report     (último CSV, filas con DATE = 1/5)
//   3. /v1/payments/search            (range=date_created, ventana 1/5 AR)
//
// Hardcoded a local_id=1 (Neko Villa Crespo). Ventana 1/5 AR: 2026-05-01T00:00-03 →
// 2026-05-02T00:00-03 (equivalente UTC: 03:00Z → 03:00Z del día siguiente).
//
// Para evitar consumir cuota de generación de MP, NO hace POST a settlement/release;
// reusa los CSVs ya disponibles del último cron, que cubren la ventana del 1/5.
//
// Uso:  GET https://pase-yndx.vercel.app/api/mp-debug-1mayo
//
// Después de leer el output, BORRAR este archivo + git rm.

import { createMpTokenGetter } from './_mp-token.js';
import { parseListBody, isCsv, parseCsv } from './_mp-csv.js';

const TARGET_LOCAL_ID = 1;
const DAY_FILTER = '2026-05-01';                        // prefijo aplicado a columnas DATE del CSV
const PAYMENTS_BEGIN = '2026-05-01T00:00:00.000-03:00'; // 1/5 00:00 AR
const PAYMENTS_END   = '2026-05-02T00:00:00.000-03:00'; // fin del 1/5 AR (exclusive)

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const getMpToken = createMpTokenGetter(db);

    const { data: cred, error: credErr } = await db.from('mp_credenciales')
      .select('id, local_id, tenant_id')
      .eq('local_id', TARGET_LOCAL_ID)
      .eq('activo', true)
      .maybeSingle();
    if (credErr) return res.status(500).json({ ok: false, error: credErr.message });
    if (!cred)   return res.status(404).json({ ok: false, error: `No active cred for local_id=${TARGET_LOCAL_ID}` });

    const token = await getMpToken(cred.id);

    const out = {
      ventana_filtro_csv: DAY_FILTER,
      ventana_payments_search: { begin: PAYMENTS_BEGIN, end: PAYMENTS_END },
      cred: { id: cred.id, local_id: cred.local_id, tenant_id: cred.tenant_id },
      settlement: null,
      release: null,
      payments_search: null,
      resumen: null,
    };

    // 1) SETTLEMENT (CSV existente, filtra filas con SETTLEMENT_DATE = 1/5)
    out.settlement = await fetchAndFilterCsv(token, 'settlement', DAY_FILTER);

    // 2) RELEASE (CSV existente, filtra filas con DATE = 1/5)
    out.release = await fetchAndFilterCsv(token, 'release', DAY_FILTER);

    // 3) PAYMENTS_SEARCH (sincrónico, paginado, range=date_created)
    out.payments_search = await fetchPaymentsSearch(token, PAYMENTS_BEGIN, PAYMENTS_END, 'date_created');

    // 3b) PAYMENTS_SEARCH con range=date_last_updated — para chequear si MP soporta ese range
    out.payments_search_by_updated = await fetchPaymentsSearch(token, PAYMENTS_BEGIN, PAYMENTS_END, 'date_last_updated');

    // 3c) ACCOUNT MOVEMENTS — egresos / withdrawals / outgoing payments
    out.account_movements = await fetchAccountMovements(token, PAYMENTS_BEGIN, PAYMENTS_END);

    // 3d) Probes de endpoints alternativos para Point Smart + egresos
    out.alt_endpoints = await probeAltEndpoints(token, PAYMENTS_BEGIN, PAYMENTS_END);

    // 4) Resumen comparativo
    out.resumen = {
      settlement: {
        filas_filtradas_1mayo: out.settlement?.filas_filtradas?.length ?? 0,
        suma_neto: out.settlement?.suma_neto ?? null,
        error: out.settlement?.error ?? null,
      },
      release: {
        filas_filtradas_1mayo: out.release?.filas_filtradas?.length ?? 0,
        suma_neto: out.release?.suma_neto ?? null,
        error: out.release?.error ?? null,
      },
      payments_search: {
        total: out.payments_search?.total ?? 0,
        approved_count: out.payments_search?.approved_count ?? 0,
        suma_approved_transaction_amount: out.payments_search?.suma_approved_transaction ?? null,
        suma_approved_net_received: out.payments_search?.suma_approved_neto ?? null,
        error: out.payments_search?.error ?? null,
      },
      payments_search_by_updated: {
        supported: out.payments_search_by_updated?.error ? false : true,
        total: out.payments_search_by_updated?.total ?? 0,
        error: out.payments_search_by_updated?.error ?? null,
      },
      account_movements: {
        supported: out.account_movements?.all?.error ? false : true,
        total: out.account_movements?.all?.total ?? 0,
        fetched: out.account_movements?.all?.fetched ?? 0,
        error: out.account_movements?.all?.error ?? null,
      },
    };

    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('mp-debug-1mayo error:', err);
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAndFilterCsv(token, kind, dayFilter) {
  const baseUrl = kind === 'settlement'
    ? 'https://api.mercadopago.com/v1/account/settlement_report'
    : 'https://api.mercadopago.com/v1/account/release_report';

  // 1. LIST: sort + tomar el más reciente
  const listRes = await fetch(`${baseUrl}/list`, { headers: { Authorization: `Bearer ${token}` } });
  if (!listRes.ok) {
    return { error: `LIST ${listRes.status}: ${(await listRes.text()).slice(0, 300)}` };
  }
  const csvFiles = parseListBody(await listRes.text())
    .filter(f => isCsv(f))
    .sort((a, b) => new Date(b.date_created || b.date || 0) - new Date(a.date_created || a.date || 0));
  const target = csvFiles[0];
  if (!target) return { error: 'No CSV files in /list' };
  const fileName = target.file_name || target.fileName || target.name;

  // 2. GET file
  const fileRes = await fetch(`${baseUrl}/${encodeURIComponent(fileName)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) {
    return { error: `FILE ${fileRes.status}: ${(await fileRes.text()).slice(0, 300)}` };
  }
  const csvText = await fileRes.text();
  const { header, rows } = parseCsv(csvText);

  // 3. Filtrar por columnas de fecha (cualquier match contra dayFilter)
  const dateCols = kind === 'settlement'
    ? ['SETTLEMENT_DATE', 'TRANSACTION_DATE']
    : ['DATE', 'TRANSACTION_DATE', 'EFFECTIVE_DATE', 'INITIATING_DATE'];
  const idxDateCols = dateCols.map(c => header.indexOf(c)).filter(i => i >= 0);

  const matched = [];
  for (const row of rows) {
    for (const idx of idxDateCols) {
      const v = (row[idx] || '').trim();
      if (v.startsWith(dayFilter)) {
        matched.push(row);
        break;
      }
    }
  }

  // 4. Suma neto del día (signed). Convertimos a objetos {col: val} para el dump.
  const filasObj = matched.map(r =>
    Object.fromEntries(header.map((h, i) => [h, r[i] || '']))
  );

  let suma = 0;
  for (const f of filasObj) {
    if (kind === 'settlement') {
      const n = parseAmount(f.SETTLEMENT_NET_AMOUNT || f.TRANSACTION_AMOUNT);
      if (n != null) suma += n;
    } else {
      const cred = parseAmount(f.NET_CREDIT_AMOUNT) || 0;
      const debit = parseAmount(f.NET_DEBIT_AMOUNT) || 0;
      if (debit > 0) suma -= debit;
      else if (cred > 0) suma += cred;
    }
  }

  return {
    csv_file: fileName,
    csv_file_date_created: target.date_created || target.date || null,
    header,
    total_filas_csv: rows.length,
    filas_filtradas: filasObj,
    suma_neto: Math.round(suma * 100) / 100,
  };
}

async function fetchPaymentsSearch(token, begin, end, rangeField = 'date_created') {
  const all = [];
  const limit = 100;
  let offset = 0;
  let pages = 0;
  let total = null;
  let rateLimitHeaders = null;

  while (pages < 30) {
    const url =
      `https://api.mercadopago.com/v1/payments/search?` +
      `sort=${rangeField}&criteria=desc&` +
      `range=${rangeField}&` +
      `begin_date=${encodeURIComponent(begin)}&end_date=${encodeURIComponent(end)}&` +
      `limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    // Capturar headers de rate limit en la primera respuesta
    if (rateLimitHeaders == null) {
      rateLimitHeaders = {};
      for (const [k, v] of r.headers.entries()) {
        if (/limit|ratelimit|x-/i.test(k)) rateLimitHeaders[k] = v;
      }
    }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 400);
      return { error: `payments/search range=${rangeField} ${r.status}: ${body}`, partial_count: all.length, rate_limit_headers: rateLimitHeaders };
    }
    const data = await r.json();
    if (total == null) total = data?.paging?.total ?? null;
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    pages++;
    if (results.length < limit) break;
    offset += limit;
  }

  // Slim a campos relevantes (incluye campos para tracking de mutación / refunds)
  const slim = all.map(p => ({
    id: p.id,
    date_created: p.date_created,
    date_approved: p.date_approved,
    date_last_updated: p.date_last_updated,
    money_release_date: p.money_release_date,
    status: p.status,
    status_detail: p.status_detail,
    transaction_amount: p.transaction_amount,
    transaction_amount_refunded: p.transaction_amount_refunded ?? 0,
    net_received_amount: p.transaction_details?.net_received_amount ?? null,
    refunds_count: Array.isArray(p.refunds) ? p.refunds.length : 0,
    refunds_total: Array.isArray(p.refunds) ? p.refunds.reduce((s, r) => s + (Number(r.amount) || 0), 0) : 0,
    fee_total: p.fee_details ? p.fee_details.reduce((s, fd) => s + (Number(fd.amount) || 0), 0) : null,
    payment_method_id: p.payment_method_id,
    payment_type_id: p.payment_type_id,
    point_of_interaction_type: p.point_of_interaction?.type ?? null,
    point_of_interaction_subtype: p.point_of_interaction?.sub_type ?? null,
    description: p.description,
    external_reference: p.external_reference,
    operation_type: p.operation_type,
    payer_id: p.payer?.id ?? null,
    collector_id: p.collector_id ?? p.collector?.id ?? null,
  }));

  const approved = slim.filter(p => p.status === 'approved');
  const sumApprovedTrans = approved.reduce((s, p) => s + (Number(p.transaction_amount) || 0), 0);
  const sumApprovedNeto = approved.reduce((s, p) => s + (Number(p.net_received_amount) || 0), 0);

  return {
    range_field: rangeField,
    total: total ?? slim.length,
    fetched: slim.length,
    pages,
    approved_count: approved.length,
    suma_approved_transaction: Math.round(sumApprovedTrans * 100) / 100,
    suma_approved_neto: Math.round(sumApprovedNeto * 100) / 100,
    rate_limit_headers: rateLimitHeaders,
    payments: slim,
  };
}

// Probe del endpoint /v1/account/movements/search (egresos / withdrawals / etc).
// Histórico: este endpoint apareció en commit f1ee254 como diagnóstico, después
// el equipo se movió a release_report. Revivimos solo para descubrir si
// los egresos (compra ML, retiros a CBU) viven acá.
async function fetchAccountMovements(token, begin, end) {
  const tries = [
    {
      label: 'all',
      url: `https://api.mercadopago.com/v1/account/movements/search?` +
        `filters.type=all&sort=date_created&criteria=desc&` +
        `begin_date=${encodeURIComponent(begin)}&end_date=${encodeURIComponent(end)}&` +
        `limit=50`,
    },
  ];

  const results = {};
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { headers: { Authorization: `Bearer ${token}` } });
      const headers = {};
      for (const [k, v] of r.headers.entries()) {
        if (/limit|ratelimit|x-/i.test(k)) headers[k] = v;
      }
      if (!r.ok) {
        const body = (await r.text()).slice(0, 400);
        results[t.label] = { error: `${r.status}: ${body}`, rate_limit_headers: headers };
        continue;
      }
      const data = await r.json();
      results[t.label] = {
        total: data?.paging?.total ?? null,
        fetched: Array.isArray(data?.results) ? data.results.length : 0,
        rate_limit_headers: headers,
        // Devolvemos los primeros 30 raw para poder explorar campos.
        raw_first_30: Array.isArray(data?.results) ? data.results.slice(0, 30) : [],
      };
    } catch (e) {
      results[t.label] = { error: String(e?.message || e) };
    }
  }
  return results;
}

// Probe genérico — hit URL + capturar status, headers relevantes, body preview.
// Devuelve estructura compacta para no inflar el JSON. body_parsed se incluye solo
// si el response es JSON pequeño (<8KB serializado).
async function probeAltEndpoints(token, begin, end) {
  const enc = encodeURIComponent;
  // Para Point integration-api algunas APIs prefieren un formato distinto de fechas.
  const beginShort = '2026-05-01T00:00:00.000-03:00';
  const endShort   = '2026-05-02T00:00:00.000-03:00';
  // Ventana corta también en formato YYYY-MM-DD por si algun endpoint la prefiere.
  const beginDay = '2026-05-01';
  const endDay   = '2026-05-02';

  const urls = [
    // ── ORDERS API ────────────────────────────────────────────────────────────
    { label: 'orders/search v1 by date_created', url:
      `https://api.mercadopago.com/v1/orders/search?range=date_created&begin_date=${enc(begin)}&end_date=${enc(end)}&limit=50` },
    { label: 'orders/search v2 by date_created', url:
      `https://api.mercadopago.com/v2/orders/search?range=date_created&begin_date=${enc(begin)}&end_date=${enc(end)}&limit=50` },
    { label: 'merchant_orders/search', url:
      `https://api.mercadopago.com/merchant_orders/search?range=date_created&begin_date=${enc(begin)}&end_date=${enc(end)}&limit=50` },

    // ── WITHDRAWALS / RETIROS A CBU ────────────────────────────────────────────
    { label: 'withdrawals (no search)', url: 'https://api.mercadopago.com/v1/withdrawals' },
    { label: 'withdrawals/search', url:
      `https://api.mercadopago.com/v1/withdrawals/search?begin_date=${enc(begin)}&end_date=${enc(end)}` },
    { label: 'account/withdrawals', url: 'https://api.mercadopago.com/v1/account/withdrawals' },
    { label: 'payments?operation_type=money_withdrawal', url:
      `https://api.mercadopago.com/v1/payments/search?operation_type=money_withdrawal&range=date_created&begin_date=${enc(begin)}&end_date=${enc(end)}&limit=100` },

    // ── POINT INTEGRATION API ─────────────────────────────────────────────────
    { label: 'point v2 devices', url: 'https://api.mercadopago.com/v2/point/integration-api/devices' },
    { label: 'point v1 devices', url: 'https://api.mercadopago.com/v1/point/integration-api/devices' },
    { label: 'point payment-intents events', url:
      `https://api.mercadopago.com/v1/point/integration-api/payment-intents/events?startDate=${enc(beginShort)}&endDate=${enc(endShort)}` },
    { label: 'point v2 payment-intents events', url:
      `https://api.mercadopago.com/v2/point/integration-api/payment-intents/events?startDate=${enc(beginShort)}&endDate=${enc(endShort)}` },
    { label: 'point operations search', url:
      `https://api.mercadopago.com/point/integration-api/operations/search?begin_date=${enc(beginDay)}&end_date=${enc(endDay)}` },

    // ── BAJO-LEVEL (acaso devuelve algún index) ───────────────────────────────
    { label: 'point root', url: 'https://api.mercadopago.com/point/integration-api' },
  ];

  const results = [];
  for (const { label, url } of urls) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const headers = {};
      for (const [k, v] of r.headers.entries()) {
        if (/x-|legacy|api-version|server-segment/i.test(k)) headers[k] = v;
      }
      const bodyText = await r.text();
      let bodyParsed = null;
      try { bodyParsed = JSON.parse(bodyText); } catch {}

      const slim = {
        label,
        url: url.split('?')[0],
        query_params: url.includes('?') ? '?' + url.split('?')[1] : null,
        status: r.status,
        ok: r.ok,
        headers,
      };

      if (bodyParsed) {
        slim.body_keys = bodyParsed && typeof bodyParsed === 'object' && !Array.isArray(bodyParsed)
          ? Object.keys(bodyParsed) : null;
        slim.body_is_array = Array.isArray(bodyParsed);
        slim.body_paging_total = bodyParsed?.paging?.total ?? bodyParsed?.total ?? null;
        slim.body_results_count = Array.isArray(bodyParsed?.results) ? bodyParsed.results.length
          : Array.isArray(bodyParsed?.devices) ? bodyParsed.devices.length
          : Array.isArray(bodyParsed) ? bodyParsed.length
          : null;
        // Sample primeros 3 results / devices
        const arr = Array.isArray(bodyParsed?.results) ? bodyParsed.results
          : Array.isArray(bodyParsed?.devices) ? bodyParsed.devices
          : Array.isArray(bodyParsed?.events) ? bodyParsed.events
          : Array.isArray(bodyParsed) ? bodyParsed
          : null;
        slim.body_first_3_items = arr ? arr.slice(0, 3) : null;
        // Para errores: los errores de MP son JSON con error/message
        slim.error_field = bodyParsed?.error ?? null;
        slim.message_field = bodyParsed?.message ?? null;
      } else {
        slim.body_preview = bodyText.slice(0, 400);
      }

      results.push(slim);
    } catch (e) {
      results.push({ label, url: url.split('?')[0], error: String(e?.message || e) });
    }
  }

  return results;
}

function parseAmount(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Formato MP: punto decimal anglosajón ("123.45") o coma decimal AR ("123,45").
  const norm = s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.')
             : s.includes(',') && !s.includes('.') ? s.replace(',', '.')
             : s;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}
