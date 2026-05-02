// ⚠️ ENDPOINT TEMPORAL — borrar después de validar la pestaña Comisiones del 1/5.
//
// Backfill de filas fee-* para el 1/5/2026 (TASK 0.18 — Fase D).
// Los pay-* del 1/5 ya están en mp_movimientos (commit ad00a50). Los hermanos
// fee-* faltan porque mapPaymentToRows recién emite fees desde Fase A
// (commit 8d65da2). Este endpoint los siembra con append-only ON CONFLICT
// DO NOTHING — NO toca pay-*, NO duplica si ya hay fee-*.
//
// Lotería: igual que mp-debug-stability — payments/search tiene shard
// inconsistency, hasta 12 reintentos para alcanzar ≥20 results con los 9
// IDs POINT presentes. Logs por intento.
//
// GET/POST https://pase-yndx.vercel.app/api/mp-backfill-fees-1mayo
//
// Borrar después: git rm api/mp-backfill-fees-1mayo.js.

import { createMpTokenGetter } from './_mp-token.js';
import { mapPaymentToRows } from './_mp-payments-search.js';

const TARGET_LOCAL_ID = 1;
const BEGIN = '2026-05-01T00:00:00.000-03:00';
const END   = '2026-05-02T00:00:00.000-03:00';

// Los 9 ids POINT que el shard a veces no devuelve. La lotería corta cuando
// los 9 están presentes O se agotan retries.
const KNOWN_POINT_IDS = [
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
    if (!cred) return res.status(404).json({ ok: false, error: `No active cred for local_id=${TARGET_LOCAL_ID}` });

    const token = await getMpToken(cred.id);

    // ─── ?inspect=1 → dump read-only de fee_details / charges_details / taxes
    // de 3-4 payments concretos del 1/5. SIN DB writes. Sirve para investigar
    // qué types emite MP y cómo separar comisión MP vs retención IIBB.
    const inspectMode = req.query?.inspect === '1' || req.body?.inspect === '1';
    if (inspectMode) {
      return await handleInspect({ token, res });
    }

    // Resolver our_account_id (necesario para clasificar ingreso/egreso)
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(500).json({ ok: false, error: '/users/me failed', status: meRes.status });
    const me = await meRes.json();
    const ourAccountId = Number(me?.id);
    if (!ourAccountId) return res.status(500).json({ ok: false, error: 'no account_id' });

    // Lotería contra el shard.
    const MAX_RETRIES = 12;
    const TARGET_TOTAL = 20;
    const url = `https://api.mercadopago.com/v1/payments/search?` +
      `range=date_created&` +
      `begin_date=${enc(BEGIN)}&end_date=${enc(END)}&` +
      `limit=100&offset=0`;
    const attempts = [];
    let bestPayments = [];
    let gotAllPoint = false;

    for (let i = 1; i <= MAX_RETRIES; i++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        attempts.push({ attempt: i, status: r.status, error: 'fetch_not_ok' });
        continue;
      }
      const data = await r.json();
      const payments = Array.isArray(data?.results) ? data.results : [];
      const ids = new Set(payments.map(p => String(p.id)));
      const missingPoint = KNOWN_POINT_IDS.filter(id => !ids.has(id));
      attempts.push({
        attempt: i,
        total: payments.length,
        paging_total: data?.paging?.total ?? null,
        missing_point: missingPoint.length,
        request_id: r.headers.get('x-request-id') || null,
      });
      if (payments.length > bestPayments.length) bestPayments = payments;
      if (payments.length >= TARGET_TOTAL && missingPoint.length === 0) {
        gotAllPoint = true;
        break;
      }
    }

    if (bestPayments.length === 0) {
      return res.status(500).json({ ok: false, error: 'No payments fetched after retries', attempts });
    }

    // Pre-count rows fee-* del 1/5 antes del upsert.
    const preCount = await countFeeRows(db, cred.local_id);

    // Construir SOLO las filas fee (descartar las main pay-*: ya están en DB
    // del backfill anterior o del cron, y mapPaymentToRows ya las protege con
    // ON CONFLICT DO NOTHING — pero acá filtramos para minimizar chatter).
    const feeRows = [];
    const skippedReasons = {};
    for (const p of bestPayments) {
      const results = mapPaymentToRows(p, cred, ourAccountId);
      for (const r of results) {
        if (r.skipped) {
          skippedReasons[r.reason] = (skippedReasons[r.reason] || 0) + 1;
          continue;
        }
        if (String(r.row.id).startsWith('fee-')) {
          feeRows.push(r.row);
        }
      }
    }

    // Append-only upsert
    let insertedIds = [];
    let upsertError = null;
    if (feeRows.length > 0) {
      const { data: ins, error } = await db
        .from('mp_movimientos')
        .upsert(feeRows, { onConflict: 'id', ignoreDuplicates: true })
        .select('id');
      if (error) upsertError = error.message;
      else insertedIds = (ins || []).map(r => r.id);
    }

    const postCount = await countFeeRows(db, cred.local_id);

    return res.status(200).json({
      ok: true,
      mode: 'backfill_fees_1mayo',
      cred: { id: cred.id, local_id: cred.local_id, tenant_id: cred.tenant_id },
      our_account_id: ourAccountId,
      attempts: attempts.length,
      got_all_point: gotAllPoint,
      payments_fetched: bestPayments.length,
      fee_rows_built: feeRows.length,
      payments_skipped: skippedReasons,
      pre_count_fee_rows: preCount,
      inserted_count: insertedIds.length,
      post_count_fee_rows: postCount,
      delta: postCount - preCount,
      inserted_ids: insertedIds,
      attempts_log: attempts,
      upsert_error: upsertError,
    });
  } catch (err) {
    console.error('mp-backfill-fees-1mayo error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── Inspect mode (read-only) ────────────────────────────────────────────
// Mix de payments del 1/5 elegidos para representar distintos casos:
//   - POINT credit (visa)         → expecting MP fee + IIBB
//   - CHECKOUT credit (visa)      → expecting MP fee + IIBB (online)
//   - INSTORE debit (debvisa QR)  → expecting MP fee menor, posible IIBB
//   - SUBSCRIPTIONS (Meli+)       → egreso, ver si trae fees del lado payer
//   - account_money CHECKOUT      → cuenta sin fee (control)
const INSPECT_IDS = [
  { id: '157334804646', label: 'POINT credit visa $168.5k' },
  { id: '156528808241', label: 'CHECKOUT credit visa $105.95k' },
  { id: '156568780899', label: 'INSTORE QR debvisa $70k' },
  { id: '157218501854', label: 'SUBSCRIPTIONS Meli+ $8.99k (egreso)' },
];

async function handleInspect({ token, res }) {
  const out = { ts: new Date().toISOString(), payments: {} };
  for (const { id, label } of INSPECT_IDS) {
    try {
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.text();
      let p = null;
      try { p = JSON.parse(body); } catch {}
      if (!r.ok || !p) {
        out.payments[id] = { label, status: r.status, body_preview: body.slice(0, 300) };
        continue;
      }
      // Captura todas las arrays sospechosas de tener cargo MP / impuesto
      out.payments[id] = {
        label,
        status: r.status,
        request_id: r.headers.get('x-request-id') || null,
        // Resumen
        summary: {
          status: p.status,
          status_detail: p.status_detail,
          payment_method_id: p.payment_method_id,
          payment_type_id: p.payment_type_id,
          point_of_interaction_type: p.point_of_interaction?.type ?? null,
          transaction_amount: p.transaction_amount,
          net_received_amount: p.transaction_details?.net_received_amount ?? null,
          taxes_amount: p.taxes_amount ?? null,
          // Diff calculado
          diff_transaction_minus_net: (Number(p.transaction_amount) || 0)
            - (Number(p.transaction_details?.net_received_amount) || 0),
        },
        // Arrays raw — los nombres exactos de fields varían según versión MP API
        fee_details: p.fee_details ?? null,
        charges_details: p.charges_details ?? null,
        taxes: p.taxes ?? null,
        // Algunos endpoints nuevos devuelven 'fee_total' agregado
        fee_total: p.fee_total ?? null,
        // Fields raw que pueden tener data útil sin estructura conocida
        differential_pricing_id: p.differential_pricing_id ?? null,
        installment_amount: p.installment_amount ?? null,
        marketplace_fee: p.marketplace_fee ?? null,
        shipping_amount: p.shipping_amount ?? null,
        // El objeto de tax/comisión completo si MP lo expone
        transaction_details_full: p.transaction_details ?? null,
      };
    } catch (e) {
      out.payments[id] = { label, error: String(e?.message || e) };
    }
  }
  return res.status(200).json({ ok: true, mode: 'inspect_fee_details', ...out });
}

async function countFeeRows(db, localId) {
  const { count } = await db
    .from('mp_movimientos')
    .select('id', { count: 'exact', head: true })
    .eq('local_id', localId)
    .gte('fecha', '2026-05-01T00:00:00')
    .lt('fecha', '2026-05-02T03:00:01')
    .like('id', 'fee-%');
  return count ?? 0;
}
