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
