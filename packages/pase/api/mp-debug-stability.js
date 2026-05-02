// ⚠️ ENDPOINT TEMPORAL — borrar después de cerrar la investigación de
// estabilidad de payments/search. Este endpoint NO escribe en DB.
//
// Foco: por qué payments/search bajó de 20 a 11 results del 1/5 entre dos
// llamadas del mismo día. Hipótesis a chequear:
//   1. Los 9 desaparecidos siguen existiendo en MP (GET directo por id).
//   2. Alguna variante de query (sin range, status=all, sort distinto, etc.)
//      los devuelve igual.
//   3. Hay correlación entre money_release_date y desaparición de la búsqueda.
//
// GET https://pase-yndx.vercel.app/api/mp-debug-stability

import { createMpTokenGetter } from './_mp-token.js';

const TARGET_LOCAL_ID = 1;
const BEGIN = '2026-05-01T00:00:00.000-03:00';
const END   = '2026-05-02T00:00:00.000-03:00';

// Los 9 ids POINT que desaparecieron entre el dump de ayer y el de esta tarde.
const DISAPPEARED_IDS = [
  '157335675746', '157334804646', '157327528386',
  '157324874104', '156560126051', '156558506041',
  '156558519199', '157207149362', '156442960967',
];

const enc = encodeURIComponent;

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const getMpToken = createMpTokenGetter(db);
    const { data: cred } = await db.from('mp_credenciales')
      .select('id, local_id, tenant_id')
      .eq('local_id', TARGET_LOCAL_ID).eq('activo', true).maybeSingle();
    if (!cred) return res.status(404).json({ ok: false, error: 'No cred' });
    const token = await getMpToken(cred.id);

    // ─── ?write=1 → backfill de pay-* del 1/5 ────────────────────────────────
    const writeMode = req.query?.write === '1' || req.body?.write === '1';
    if (writeMode) {
      return await handleBackfill({ db, token, cred, res });
    }

    const out = {
      ts: new Date().toISOString(),
      cred: { id: cred.id, local_id: cred.local_id, tenant_id: cred.tenant_id },
    };

    // 0) Verificar identidad del token
    out.users_me = await fetchJson(token, 'https://api.mercadolibre.com/users/me');

    // 1) GET directo a cada uno de los 9 ids desaparecidos
    out.direct_get = {};
    for (const id of DISAPPEARED_IDS) {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      out.direct_get[id] = {
        status: r.status,
        ok: r.ok,
        request_id: r.headers.get('x-request-id') || null,
        summary: r.ok && parsed ? {
          id: parsed.id,
          status: parsed.status,
          status_detail: parsed.status_detail,
          date_created: parsed.date_created,
          date_approved: parsed.date_approved,
          date_last_updated: parsed.date_last_updated,
          money_release_date: parsed.money_release_date,
          transaction_amount: parsed.transaction_amount,
          net_received_amount: parsed.transaction_details?.net_received_amount ?? null,
          payment_type_id: parsed.payment_type_id,
          payment_method_id: parsed.payment_method_id,
          point_of_interaction_type: parsed.point_of_interaction?.type ?? null,
          operation_type: parsed.operation_type,
          collector_id: parsed.collector_id ?? parsed.collector?.id ?? null,
          payer_id: parsed.payer?.id ?? null,
        } : null,
        body_preview: !r.ok ? body.slice(0, 400) : null,
      };
    }

    // 2) Variaciones de payments/search
    const variations = [
      { label: 'baseline (range=date_created, sort desc)',
        url: `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'no range param',
        url: `https://api.mercadopago.com/v1/payments/search?begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'range=date_last_updated',
        url: `https://api.mercadopago.com/v1/payments/search?range=date_last_updated&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'range=date_approved',
        url: `https://api.mercadopago.com/v1/payments/search?range=date_approved&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'range=money_release_date',
        url: `https://api.mercadopago.com/v1/payments/search?range=money_release_date&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'status=approved explicit',
        url: `https://api.mercadopago.com/v1/payments/search?status=approved&range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'status=all',
        url: `https://api.mercadopago.com/v1/payments/search?status=all&range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'sort=date_created asc',
        url: `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=asc&range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'operation_type=regular_payment',
        url: `https://api.mercadopago.com/v1/payments/search?operation_type=regular_payment&range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'no sort/criteria — defaults',
        url: `https://api.mercadopago.com/v1/payments/search?range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=100&offset=0` },
      { label: 'limit=500',
        url: `https://api.mercadopago.com/v1/payments/search?range=date_created&begin_date=${enc(BEGIN)}&end_date=${enc(END)}&limit=500&offset=0` },
      { label: 'ventana ampliada 30/4 → 3/5',
        url: `https://api.mercadopago.com/v1/payments/search?range=date_created&begin_date=${enc('2026-04-30T00:00:00.000-03:00')}&end_date=${enc('2026-05-03T00:00:00.000-03:00')}&limit=500&offset=0` },
    ];

    out.search_variations = {};
    for (const v of variations) {
      const r = await fetch(v.url, { headers: { Authorization: `Bearer ${token}` } });
      const body = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      const ids = results.map(p => String(p.id));
      out.search_variations[v.label] = {
        url: v.url,
        status: r.status,
        ok: r.ok,
        request_id: r.headers.get('x-request-id') || null,
        paging_total: parsed?.paging?.total ?? null,
        results_count: results.length,
        ids,
        disappeared_present: ids.filter(id => DISAPPEARED_IDS.includes(id)),
        // Sample del primero para verificar que el shape es el esperado
        first_result_summary: results[0] ? {
          id: results[0].id,
          date_created: results[0].date_created,
          status: results[0].status,
          point_of_interaction_type: results[0].point_of_interaction?.type ?? null,
        } : null,
        body_preview_if_error: !r.ok ? body.slice(0, 300) : null,
      };
    }

    // 3) Cross-reference: ¿en qué variantes aparece cada uno de los 9 desaparecidos?
    out.disappeared_appears_in = {};
    for (const id of DISAPPEARED_IDS) {
      const matches = [];
      for (const [label, v] of Object.entries(out.search_variations)) {
        if (v.ids?.includes(id)) matches.push(label);
      }
      out.disappeared_appears_in[id] = matches;
    }

    // 4) Resumen
    out.resumen = {
      direct_get_status: Object.fromEntries(
        Object.entries(out.direct_get).map(([id, r]) => [id, r.status])
      ),
      search_totals: Object.fromEntries(
        Object.entries(out.search_variations).map(([label, v]) => [
          label,
          { total: v.paging_total, count: v.results_count, has_disappeared: v.disappeared_present.length },
        ])
      ),
      disappeared_anywhere: Object.fromEntries(
        Object.entries(out.disappeared_appears_in).map(([id, arr]) => [id, arr.length > 0])
      ),
    };

    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    console.error('mp-debug-stability error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── Backfill 1/5 ────────────────────────────────────────────────────────────
// Lotería: la API de MP devuelve a veces 20 (con los 9 POINT) y a veces 11
// (sin los 9 POINT) según routing del backend. Reintenta hasta capturar los 9
// o cap MAX_RETRIES. Append-only: ON CONFLICT (id) DO NOTHING.
async function handleBackfill({ db, token, cred, res }) {
  const MAX_RETRIES = 12;
  const TARGET_TOTAL = 20;

  // Resolver account_id propio para distinguir ingresos vs egresos
  const meRes = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) {
    return res.status(500).json({ ok: false, error: '/users/me failed', status: meRes.status });
  }
  const me = await meRes.json();
  const ourAccountId = me?.id;

  // Lotería: reintenta hasta capturar los 9 POINT o ≥20 results.
  const attempts = [];
  let bestPayments = [];
  let gotAllDisappeared = false;
  const url = `https://api.mercadopago.com/v1/payments/search?` +
    `range=date_created&` +
    `begin_date=${enc(BEGIN)}&end_date=${enc(END)}&` +
    `limit=100&offset=0`;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      attempts.push({ attempt: i, status: r.status, error: 'fetch_not_ok' });
      continue;
    }
    const data = await r.json();
    const payments = Array.isArray(data?.results) ? data.results : [];
    const ids = new Set(payments.map(p => String(p.id)));
    const missing9 = DISAPPEARED_IDS.filter(id => !ids.has(id));
    attempts.push({
      attempt: i,
      total: payments.length,
      paging_total: data?.paging?.total ?? null,
      missing_disappeared: missing9.length,
      request_id: r.headers.get('x-request-id') || null,
    });
    if (payments.length > bestPayments.length) bestPayments = payments;
    if (payments.length >= TARGET_TOTAL && missing9.length === 0) {
      gotAllDisappeared = true;
      break;
    }
  }

  if (bestPayments.length === 0) {
    return res.status(500).json({ ok: false, error: 'No payments fetched after retries', attempts });
  }

  // Pre-count rows pay-* del 1/5 antes del upsert
  const preCount = await countPayRows(db, cred.local_id);

  // Construir filas (skip transferencias internas y status no-approved)
  const rows = [];
  const skippedReasons = {};
  for (const p of bestPayments) {
    const r = buildPayRow(p, cred, ourAccountId);
    if (r.skipped) {
      skippedReasons[r.reason] = (skippedReasons[r.reason] || 0) + 1;
    } else {
      rows.push(r.row);
    }
  }

  // Append-only upsert
  let insertedIds = [];
  let upsertError = null;
  if (rows.length > 0) {
    const { data: ins, error } = await db
      .from('mp_movimientos')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
      .select('id');
    if (error) upsertError = error.message;
    else insertedIds = (ins || []).map(r => r.id);
  }

  const postCount = await countPayRows(db, cred.local_id);

  return res.status(200).json({
    ok: true,
    mode: 'backfill',
    attempts: attempts.length,
    got_all_disappeared: gotAllDisappeared,
    payments_fetched: bestPayments.length,
    rows_built: rows.length,
    rows_skipped: skippedReasons,
    pre_count_pay_rows: preCount,
    inserted_count: insertedIds.length,
    post_count_pay_rows: postCount,
    delta: postCount - preCount,
    inserted_ids: insertedIds,
    attempts_log: attempts,
    upsert_error: upsertError,
  });
}

async function countPayRows(db, localId) {
  const { count } = await db
    .from('mp_movimientos')
    .select('id', { count: 'exact', head: true })
    .eq('local_id', localId)
    .gte('fecha', '2026-05-01T00:00:00')
    .lt('fecha', '2026-05-02T03:00:01')
    .like('id', 'pay-%');
  return count ?? 0;
}

function buildPayRow(p, cred, ourAccountId) {
  if (p.status !== 'approved') return { skipped: true, reason: 'not_approved' };

  const collectorId = Number(p.collector_id ?? p.collector?.id ?? 0);
  const payerId = Number(p.payer?.id ?? 0);

  // Transferencias internas (collector == payer == nosotros) → skip por ahora.
  if (collectorId === ourAccountId && payerId === ourAccountId) {
    return { skipped: true, reason: 'internal_transfer' };
  }

  const isIngress = collectorId === ourAccountId;
  const transactionAmount = Number(p.transaction_amount) || 0;
  const netReceived = Number(p.transaction_details?.net_received_amount) || 0;
  const poi = p.point_of_interaction?.type || null;
  const method = p.payment_method_id || null;

  let monto, tipo, descripcion, medioPago;
  if (isIngress) {
    monto = netReceived;
    tipo = 'liquidacion';
    if (poi === 'POINT') {
      descripcion = `Point Smart — ${method}`;
      medioPago = `point_smart_${method}`;
    } else if (poi === 'INSTORE') {
      descripcion = p.description || `QR — ${method}`;
      medioPago = `qr_${method}`;
    } else if (poi === 'CHECKOUT') {
      descripcion = p.description || `Checkout — ${method}`;
      medioPago = method;
    } else if (poi === 'SUBSCRIPTIONS') {
      descripcion = p.description || `Suscripción — ${method}`;
      medioPago = method;
    } else {
      descripcion = p.description || `${poi || 'MP'} — ${method}`;
      medioPago = method;
    }
  } else {
    // Egreso: Lucas pagó (collector es alguien más)
    monto = -transactionAmount;
    tipo = 'bank_transfer';
    descripcion = p.description || `Egreso MP — ${method}`;
    medioPago = method;
  }

  if (monto === 0) return { skipped: true, reason: 'monto_cero' };

  return {
    skipped: false,
    row: {
      id: `pay-${p.id}`,
      local_id: cred.local_id,
      tenant_id: cred.tenant_id,
      fecha: p.date_created,
      tipo,
      descripcion: (descripcion || '').slice(0, 200),
      monto: Math.round(monto * 100) / 100,
      saldo: null,
      estado: 'approved',
      // referencia_id distinta del payment.id que use rr-/set-: usamos el
      // payment.id como string puro para evitar el cleanup retroactivo del
      // cron (que matchea por external_reference de set-/rr-).
      referencia_id: String(p.id),
      medio_pago: medioPago,
    },
  };
}

async function fetchJson(token, url) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    return {
      url, status: r.status, ok: r.ok,
      request_id: r.headers.get('x-request-id') || null,
      body_keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : null,
      summary: parsed ? {
        id: parsed.id,
        nickname: parsed.nickname,
        site_id: parsed.site_id,
        seller_experience: parsed.seller_experience,
        user_type: parsed.user_type,
        country_id: parsed.country_id,
      } : null,
    };
  } catch (e) {
    return { url, error: String(e?.message || e) };
  }
}
