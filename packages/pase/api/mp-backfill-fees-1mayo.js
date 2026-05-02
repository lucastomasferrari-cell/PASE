// ⚠️ ENDPOINT TEMPORAL — borrar después de validar la pestaña Comisiones MP.
//
// Backfill de filas fee-*/tax-* desglosadas (TASK 0.18 — Fase D).
//
// Hace 3 cosas en orden:
//   1) DELETE de filas legacy 'fee-{paymentId}' (sin sufijo de charge) que
//      el cron creó entre Fase A vieja (8d65da2) y Fase A nueva (ebe0c42).
//      Esas filas mezclaban comisión MP + retención IIBB en una sola.
//      Patrón: id LIKE 'fee-%' AND id NOT LIKE 'fee-%-%'.
//   2) Llama payments/search con lotería (12 retries contra shard).
//   3) Procesa cada payment vía mapPaymentToRows (Fase A nueva) y upsertea
//      las filas fee-{charge.id} y tax-{charge.id} con ON CONFLICT DO NOTHING.
//      Las filas pay-* existentes NO se tocan (el upsert es no-op para ellas).
//
// Parámetros query / body:
//   - days_back=N (default 7): ventana de [hoy - N días, hoy] AR.
//   - inspect=1: modo read-only — solo dump de charges_details de payments
//     selectos para diagnóstico. NO borra ni inserta nada.
//
// Hardcoded a local_id=1.
//
// Borrar después: git rm api/mp-backfill-fees-1mayo.js.

import { createMpTokenGetter } from './_mp-token.js';
import { mapPaymentToRows, formatArIso } from './_mp-payments-search.js';

const TARGET_LOCAL_ID = 1;

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

    // ?inspect=1 — read-only dump de charges_details
    const inspectMode = req.query?.inspect === '1' || req.body?.inspect === '1';
    if (inspectMode) {
      return await handleInspect({ token, res });
    }

    // Ventana — default 7 días, configurable
    const daysBack = parseInt(String(req.query?.days_back || req.body?.days_back || '7'), 10) || 7;
    const now = new Date();
    const begin = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const beginIso = formatArIso(begin);
    const endIso = formatArIso(now);

    // Resolver our_account_id
    const meRes = await fetch('https://api.mercadolibre.com/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meRes.ok) return res.status(500).json({ ok: false, error: '/users/me failed', status: meRes.status });
    const me = await meRes.json();
    const ourAccountId = Number(me?.id);
    if (!ourAccountId) return res.status(500).json({ ok: false, error: 'no account_id' });

    // ─── 1) DELETE legacy fees ──────────────────────────────────────────────
    // Filas 'fee-{paymentId}' SIN sufijo de charge (formato viejo Fase A 8d65da2).
    // Filtrar por ventana via fecha. PostgREST no soporta NOT LIKE con doble
    // wildcard fácil, así que usamos la condición alternativa: id LIKE 'fee-%'
    // AND id no contiene un segundo guión después del primer guión y los
    // dígitos. Solución: SELECT ids candidatos + filtrar en JS + DELETE in().
    let deletedLegacy = 0;
    try {
      const { data: legacyRows } = await db.from('mp_movimientos')
        .select('id')
        .eq('local_id', cred.local_id)
        .gte('fecha', beginIso)
        .lt('fecha', endIso)
        .like('id', 'fee-%')
        .limit(5000);
      // Filtra: 'fee-{12+digits}' SIN segundo guión.
      // Patrón: empieza con 'fee-', después solo dígitos, sin más guiones.
      const isLegacyFee = (id) => /^fee-\d+$/.test(String(id));
      const legacyIds = (legacyRows || []).map(r => r.id).filter(isLegacyFee);
      if (legacyIds.length > 0) {
        const { count, error: delErr } = await db.from('mp_movimientos')
          .delete({ count: 'exact' })
          .in('id', legacyIds);
        if (delErr) {
          console.error('[backfill] delete legacy error:', delErr);
        } else {
          deletedLegacy = count ?? legacyIds.length;
        }
      }
    } catch (e) {
      console.error('[backfill] delete legacy threw:', e?.message);
    }

    // ─── 2) Lotería contra el shard ─────────────────────────────────────────
    const MAX_RETRIES = 12;
    const url = `https://api.mercadopago.com/v1/payments/search?` +
      `range=date_created&` +
      `begin_date=${enc(beginIso)}&end_date=${enc(endIso)}&` +
      `limit=100&offset=0`;
    const attempts = [];
    let bestPayments = [];

    for (let i = 1; i <= MAX_RETRIES; i++) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        attempts.push({ attempt: i, status: r.status, error: 'fetch_not_ok' });
        continue;
      }
      const data = await r.json();
      const payments = Array.isArray(data?.results) ? data.results : [];
      const pagingTotal = data?.paging?.total ?? null;
      attempts.push({
        attempt: i,
        total: payments.length,
        paging_total: pagingTotal,
        request_id: r.headers.get('x-request-id') || null,
      });
      if (payments.length > bestPayments.length) bestPayments = payments;
      // Convergencia: si el snapshot tiene paging_total >= bestPayments.length
      // y los results son iguales, asumimos cobertura. La lotería puede salirse
      // antes si llega a un total estable que matchee paging_total.
      if (pagingTotal != null && payments.length >= pagingTotal) break;
    }

    if (bestPayments.length === 0) {
      return res.status(200).json({
        ok: true,
        mode: 'backfill_fee_tax',
        cred: { id: cred.id, local_id: cred.local_id, tenant_id: cred.tenant_id },
        days_back: daysBack,
        window: { begin: beginIso, end: endIso },
        deleted_legacy_fees: deletedLegacy,
        attempts: attempts.length,
        attempts_log: attempts,
        payments_fetched: 0,
        warning: 'no payments fetched — lotería sin éxito',
      });
    }

    // ─── 3) Para cada payment, obtener detalle (con charges_details) ────────
    // payments/search devuelve payments resumidos sin charges_details.
    // Hay que GET /v1/payments/{id} para cada uno. Costo: N requests.
    // Si hay >50 payments, esto puede ser costoso. Limit defensivo.
    const detailedPayments = [];
    const detailErrors = [];
    for (const p of bestPayments) {
      try {
        const dr = await fetch(`https://api.mercadopago.com/v1/payments/${p.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!dr.ok) {
          detailErrors.push({ id: p.id, status: dr.status });
          // Fallback: usar el payment de search aunque sin charges_details.
          detailedPayments.push(p);
          continue;
        }
        const detailed = await dr.json();
        detailedPayments.push(detailed);
      } catch (e) {
        detailErrors.push({ id: p.id, error: String(e?.message || e) });
        detailedPayments.push(p);
      }
    }

    // ─── 4) Mapear y upsert append-only ─────────────────────────────────────
    const allRows = [];
    const skippedReasons = {};
    let feeRowsBuilt = 0, taxRowsBuilt = 0, mainRowsBuilt = 0;
    for (const p of detailedPayments) {
      const results = mapPaymentToRows(p, cred, ourAccountId);
      for (const r of results) {
        if (r.skipped) {
          skippedReasons[r.reason] = (skippedReasons[r.reason] || 0) + 1;
          continue;
        }
        allRows.push(r.row);
        const idStr = String(r.row.id);
        if (idStr.startsWith('fee-')) feeRowsBuilt++;
        else if (idStr.startsWith('tax-')) taxRowsBuilt++;
        else mainRowsBuilt++;
      }
    }

    let insertedIds = [];
    let upsertError = null;
    if (allRows.length > 0) {
      const { data: ins, error } = await db.from('mp_movimientos')
        .upsert(allRows, { onConflict: 'id', ignoreDuplicates: true })
        .select('id');
      if (error) upsertError = error.message;
      else insertedIds = (ins || []).map(r => r.id);
    }

    return res.status(200).json({
      ok: true,
      mode: 'backfill_fee_tax',
      cred: { id: cred.id, local_id: cred.local_id, tenant_id: cred.tenant_id },
      our_account_id: ourAccountId,
      days_back: daysBack,
      window: { begin: beginIso, end: endIso },
      deleted_legacy_fees: deletedLegacy,
      attempts: attempts.length,
      payments_fetched: bestPayments.length,
      detail_errors: detailErrors.length,
      rows_built: { main: mainRowsBuilt, fee: feeRowsBuilt, tax: taxRowsBuilt },
      payments_skipped: skippedReasons,
      inserted_count: insertedIds.length,
      attempts_log: attempts,
      upsert_error: upsertError,
      sample_inserted_ids: insertedIds.slice(0, 30),
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
      out.payments[id] = {
        label,
        status: r.status,
        request_id: r.headers.get('x-request-id') || null,
        summary: {
          status: p.status,
          payment_method_id: p.payment_method_id,
          payment_type_id: p.payment_type_id,
          point_of_interaction_type: p.point_of_interaction?.type ?? null,
          transaction_amount: p.transaction_amount,
          net_received_amount: p.transaction_details?.net_received_amount ?? null,
          diff_transaction_minus_net: (Number(p.transaction_amount) || 0)
            - (Number(p.transaction_details?.net_received_amount) || 0),
        },
        fee_details: p.fee_details ?? null,
        charges_details: p.charges_details ?? null,
        taxes: p.taxes ?? null,
      };
    } catch (e) {
      out.payments[id] = { label, error: String(e?.message || e) };
    }
  }
  return res.status(200).json({ ok: true, mode: 'inspect_fee_details', ...out });
}
