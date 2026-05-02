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

    // 3) PAYMENTS_SEARCH (sincrónico, paginado)
    out.payments_search = await fetchPaymentsSearch(token, PAYMENTS_BEGIN, PAYMENTS_END);

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

async function fetchPaymentsSearch(token, begin, end) {
  const all = [];
  const limit = 100;
  let offset = 0;
  let pages = 0;
  let total = null;

  while (pages < 30) {
    const url =
      `https://api.mercadopago.com/v1/payments/search?` +
      `sort=date_created&criteria=desc&` +
      `range=date_created&` +
      `begin_date=${encodeURIComponent(begin)}&end_date=${encodeURIComponent(end)}&` +
      `limit=${limit}&offset=${offset}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 400);
      return { error: `payments/search ${r.status}: ${body}`, partial_count: all.length };
    }
    const data = await r.json();
    if (total == null) total = data?.paging?.total ?? null;
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    pages++;
    if (results.length < limit) break;
    offset += limit;
  }

  // Slim a campos relevantes para no inflar el JSON
  const slim = all.map(p => ({
    id: p.id,
    date_created: p.date_created,
    date_approved: p.date_approved,
    date_released: p.money_release_date,
    status: p.status,
    status_detail: p.status_detail,
    transaction_amount: p.transaction_amount,
    net_received_amount: p.transaction_details?.net_received_amount ?? null,
    fee_total: p.fee_details ? p.fee_details.reduce((s, fd) => s + (Number(fd.amount) || 0), 0) : null,
    payment_method_id: p.payment_method_id,
    payment_type_id: p.payment_type_id,
    point_of_interaction_type: p.point_of_interaction?.type ?? null,
    point_of_interaction_subtype: p.point_of_interaction?.sub_type ?? null,
    description: p.description,
    external_reference: p.external_reference,
    operation_type: p.operation_type,
  }));

  const approved = slim.filter(p => p.status === 'approved');
  const sumApprovedTrans = approved.reduce((s, p) => s + (Number(p.transaction_amount) || 0), 0);
  const sumApprovedNeto = approved.reduce((s, p) => s + (Number(p.net_received_amount) || 0), 0);

  return {
    total: total ?? slim.length,
    fetched: slim.length,
    pages,
    approved_count: approved.length,
    suma_approved_transaction: Math.round(sumApprovedTrans * 100) / 100,
    suma_approved_neto: Math.round(sumApprovedNeto * 100) / 100,
    payments: slim,
  };
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
