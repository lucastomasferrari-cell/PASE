// Job diario fallback: detecta pay-* con money_release_status='pending' y
// money_release_date pasado, hace GET directo a /v1/payments/{id} y refresca
// el estado en DB. Cubre 2 casos:
//
//   1. Crédito tarda T+10 — el cron 30min ventana 7d NO los captura más
//      (salen de ventana por date_created), pero el job diario los rescata
//      buscando los pending con release_date <= today.
//   2. Shard inconsistency de payments/search en el cron 30min: si el shard
//      no devuelve un payment después de N intentos, este job lo pesca con
//      GET directo (más confiable que /payments/search).
//
// Si el payment cambió de status (charged_back, cancelled), marca anulado=true
// automáticamente — mitigación M4.
//
// Mitigación M2: cuando actualiza un pay-X, también actualiza fee-X-* y
// tax-X-* en bloque por referencia_id (heredan release fields).
//
// Mitigación M5: filtra todas las queries por tenant_id de la cred actual.
//
// Mitigación M8: si MP responde 401 en el primer GET, aborta el batch para
// esa cred, log warning y registra en auditoria con tag.
//
// Cron: cron-job.org diario 04:00 ART (07:00 UTC).
// URL: https://pase-yndx.vercel.app/api/mp-update-pending-releases
//
// Backfill mode: ?backfill=N (días back). En vez de filtrar pending, procesa
// TODOS los pay-* del rango (incluso released) para popular columnas en filas
// existentes. Útil pre-deploy del frontend con tabs nuevas.

import { createMpTokenGetter } from './_mp-token.js';
import {
  fetchPaymentsByDateCreated,
  mapPaymentToRows,
  formatArIso,
} from './_mp-payments-search.js';

const enc = encodeURIComponent;

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const getMpToken = createMpTokenGetter(db);

    // ?backfill=N → modo backfill, procesa TODOS los pay-* del rango.
    const backfillDays = parseInt(String(req.query?.backfill || req.body?.backfill || ''), 10);
    const backfillMode = Number.isFinite(backfillDays) && backfillDays > 0;

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('id, local_id, tenant_id, locales(nombre)')
      .eq('activo', true);
    if (credsError) {
      return res.status(500).json({ ok: false, error: credsError.message });
    }
    if (!creds || creds.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sin credenciales configuradas' });
    }

    const resultados = [];
    for (const cred of creds) {
      try {
        const summary = await processCred({ db, getMpToken, cred, backfillMode, backfillDays });
        resultados.push(summary);
      } catch (e) {
        console.error('[mp-update-pending-releases] cred error', cred.local_id, e?.message);
        resultados.push({
          local: cred.locales?.nombre,
          local_id: cred.local_id,
          error: e?.message || String(e),
        });
      }
    }

    return res.status(200).json({
      ok: true,
      mode: backfillMode ? `backfill_${backfillDays}d` : 'pending_only',
      resultados,
    });
  } catch (err) {
    console.error('[mp-update-pending-releases] unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function processCred({ db, getMpToken, cred, backfillMode, backfillDays }) {
  const token = await getMpToken(cred.id);

  // ─── Pasada DE DESCUBRIMIENTO (solo backfillMode) ──────────────────────────
  // Antes del SELECT, llamamos payments/search con ventana N días y hacemos
  // upsert append-only. Eso descubre payments que NUNCA entraron a DB porque
  // estaban fuera de la ventana 7d del cron 30min. Filas pre-existentes NO
  // se tocan acá (ignoreDuplicates: true) — su update queda para la pasada
  // siguiente, que cubre tanto las nuevas como las viejas.
  let discoveredNew = 0;
  let discoveredErrors = 0;
  let discoveredAccountId = null;
  if (backfillMode) {
    try {
      // Resolver our_account_id necesario para mapPaymentToRows (distingue
      // ingreso/egreso por collector_id == ourAccountId).
      const meRes = await fetch('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meRes.ok) {
        console.warn('[mp-update-pending-releases] /users/me failed for cred', cred.local_id, meRes.status);
      } else {
        const me = await meRes.json();
        discoveredAccountId = Number(me?.id) || null;
      }
    } catch (e) {
      console.warn('[mp-update-pending-releases] /users/me threw', cred.local_id, e?.message);
    }

    if (discoveredAccountId) {
      const beginIso = formatArIso(new Date(Date.now() - backfillDays * 24 * 60 * 60 * 1000));
      const endIso = formatArIso(new Date());
      try {
        const { payments, lotteryAttempts, pagingTotal } = await fetchPaymentsByDateCreated(
          token, beginIso, endIso, {
            threshold: 0,
            fetchRetries: 3,
            pageLimit: 100,
            log: (event) => console.log('[mp-update-pending-releases discovery]', JSON.stringify(event)),
          }
        );
        const newRows = [];
        for (const p of payments) {
          const results = mapPaymentToRows(p, cred, discoveredAccountId);
          for (const r of results) {
            if (!r.skipped) newRows.push(r.row);
          }
        }
        if (newRows.length > 0) {
          // Append-only — preserva campos inmutables de filas pre-existentes.
          const { data: ins, error } = await db
            .from('mp_movimientos')
            .upsert(newRows, { onConflict: 'id', ignoreDuplicates: true })
            .select('id');
          if (error) {
            console.error('[mp-update-pending-releases discovery] upsert error', cred.local_id, error.message);
            discoveredErrors++;
          } else {
            discoveredNew = (ins || []).length;
          }
        }
        console.log('[mp-update-pending-releases discovery] summary', cred.local_id, JSON.stringify({
          window: { begin: beginIso, end: endIso },
          payments_fetched: payments.length,
          paging_total: pagingTotal,
          lottery_attempts: lotteryAttempts,
          rows_built: newRows.length,
          discovered_new: discoveredNew,
        }));
      } catch (e) {
        console.error('[mp-update-pending-releases discovery] failed', cred.local_id, e?.message);
        discoveredErrors++;
      }
    }
  }

  // Query candidatos:
  //   - Backfill mode: TODOS los pay-* del rango N días (incluso released)
  //                    para popular columnas nuevas en filas existentes.
  //   - Modo normal:   solo pay-* con money_release_status='pending' AND
  //                    money_release_date <= now() AND anulado != true.
  //                    Filtra por release_date pasado para no pegar a MP por
  //                    payments que todavía esperan release legítimo.
  let query = db.from('mp_movimientos')
    .select('id, referencia_id, money_release_status, money_release_date, mp_status, anulado')
    .eq('local_id', cred.local_id)
    .eq('tenant_id', cred.tenant_id)  // M5: tenant filter explícito
    .like('id', 'pay-%')
    .not('anulado', 'is', true)
    .limit(500);

  if (backfillMode) {
    // Ventana últimos N días por fecha (= date_created del payment).
    const sinceMs = Date.now() - backfillDays * 24 * 60 * 60 * 1000;
    query = query.gte('fecha', new Date(sinceMs).toISOString());
  } else {
    query = query
      .eq('money_release_status', 'pending')
      .lt('money_release_date', new Date().toISOString());
  }

  const { data: candidatos, error: selErr } = await query;
  if (selErr) throw new Error(`select candidatos: ${selErr.message}`);

  const candidatesCount = (candidatos || []).length;
  if (candidatesCount === 0) {
    return {
      local: cred.locales?.nombre,
      local_id: cred.local_id,
      mode: backfillMode ? `backfill_${backfillDays}d` : 'pending_only',
      discovered_new: discoveredNew,
      discovered_errors: discoveredErrors,
      candidates: 0,
      checked: 0,
      released: 0,
      still_pending: 0,
      marked_anulado: 0,
      errors_401: 0,
      errors_404: 0,
      errors_other: 0,
    };
  }

  // M8: detectar 401 al primer GET → abortar la cred entera.
  let abortedOn401 = false;
  let checked = 0;
  let releasedCount = 0;
  let stillPendingCount = 0;
  let markedAnuladoCount = 0;
  let errors401 = 0;
  let errors404 = 0;
  let errorsOther = 0;

  for (const candidate of candidatos) {
    if (abortedOn401) break;

    const paymentId = String(candidate.referencia_id || '').trim();
    if (!paymentId) continue;

    let r;
    try {
      r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      console.error('[mp-update-pending-releases] fetch threw', paymentId, e?.message);
      errorsOther++;
      continue;
    }
    checked++;

    if (r.status === 401) {
      // M8: token expirado / sin scope. Abortar batch + alertar.
      errors401++;
      abortedOn401 = true;
      try {
        await db.from('auditoria').insert({
          tabla: 'mp_credenciales',
          accion: 'WARN_MP_TOKEN_EXPIRED',
          detalle: JSON.stringify({
            cred_id: cred.id,
            local_id: cred.local_id,
            payment_id: paymentId,
            tag: 'mp_token_expired_check_releases',
          }),
          fecha: new Date().toISOString(),
          tenant_id: cred.tenant_id,
        });
      } catch {}
      console.error('[mp-update-pending-releases] 401 — abort batch for cred', cred.local_id);
      break;
    }

    if (r.status === 404) {
      // Payment desapareció en MP. Marcar anulado=true puntual.
      errors404++;
      const { error: anulErr } = await db.from('mp_movimientos')
        .update({
          anulado: true,
          anulado_motivo: 'mp_not_found_404',
          anulado_at: new Date().toISOString(),
        })
        .eq('id', candidate.id)
        .eq('tenant_id', cred.tenant_id);
      if (!anulErr) markedAnuladoCount++;
      continue;
    }

    if (!r.ok) {
      errorsOther++;
      console.error('[mp-update-pending-releases] non-ok status', paymentId, r.status);
      continue;
    }

    let payment;
    try {
      payment = await r.json();
    } catch (e) {
      errorsOther++;
      continue;
    }

    const newReleaseStatus = payment.money_release_status || null;
    const newReleaseDate = payment.money_release_date || null;
    const newMpStatus = payment.status || null;
    const newMontoBruto = Number.isFinite(Number(payment.transaction_amount))
      ? Math.round(Number(payment.transaction_amount) * 100) / 100
      : null;
    const isApproved = newMpStatus === 'approved';

    // Update del pay-* — incluye monto_bruto para cubrir filas pre-Fase 2
    // que quedaron con NULL en esa columna (Bug 1: total bruto < neto en
    // tab Ventas porque las pay-* viejas tenían monto_bruto NULL y se
    // sumaban como 0).
    const updatePayload = {
      money_release_status: newReleaseStatus,
      money_release_date: newReleaseDate,
      mp_status: newMpStatus,
      monto_bruto: newMontoBruto,
    };
    // Si el status no es approved, marcar anulado=true (M4).
    if (!isApproved && newMpStatus) {
      updatePayload.anulado = true;
      updatePayload.anulado_motivo = 'mp_status_' + newMpStatus;
      updatePayload.anulado_at = new Date().toISOString();
      markedAnuladoCount++;
    }

    const { error: updErr } = await db.from('mp_movimientos')
      .update(updatePayload)
      .eq('id', candidate.id)
      .eq('tenant_id', cred.tenant_id);
    if (updErr) {
      console.error('[mp-update-pending-releases] update pay error', candidate.id, updErr.message);
      errorsOther++;
      continue;
    }

    // M2: actualizar fee-* y tax-* hermanos por referencia_id (mismo payment).
    // Heredan release fields, NO heredan mp_status (siempre 'approved').
    const { error: siblingsErr } = await db.from('mp_movimientos')
      .update({
        money_release_status: newReleaseStatus,
        money_release_date: newReleaseDate,
      })
      .eq('referencia_id', paymentId)
      .eq('local_id', cred.local_id)
      .eq('tenant_id', cred.tenant_id)
      .or('id.like.fee-%,id.like.tax-%');
    if (siblingsErr) {
      console.warn('[mp-update-pending-releases] siblings update error', paymentId, siblingsErr.message);
    }

    if (newReleaseStatus === 'released') releasedCount++;
    else if (newReleaseStatus === 'pending') stillPendingCount++;
  }

  return {
    local: cred.locales?.nombre,
    local_id: cred.local_id,
    mode: backfillMode ? `backfill_${backfillDays}d` : 'pending_only',
    discovered_new: discoveredNew,
    discovered_errors: discoveredErrors,
    discovered_account_id: discoveredAccountId,
    candidates: candidatesCount,
    checked,
    released: releasedCount,
    still_pending: stillPendingCount,
    marked_anulado: markedAnuladoCount,
    errors_401: errors401,
    errors_404: errors404,
    errors_other: errorsOther,
    aborted_on_401: abortedOn401,
  };
}
