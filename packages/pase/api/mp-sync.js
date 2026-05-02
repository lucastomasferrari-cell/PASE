// mp-sync: cron diario que sincroniza movimientos MP de cada local.
// Hace todo en una pasada: POST report → wait 90s → GET file → parse → upsert
// → calcular saldo legacy → fetch saldo API → UPDATE.
//
// PARTE C de TASK 0.11 + revisión 28/04:
// - REMOVIDO el flow de /v1/payments/search (traía cobros tipo='point'/
//   'payment' que no afectan saldo released).
// - Usa release_report como fuente principal: tiene los eventos de
//   movimiento del saldo (payments liberados, payouts a CBU, refunds,
//   chargebacks, asset_management). Settlement_report (override
//   opcional con ?source=settlement) lista pagos individuales pero
//   omite payouts y eventos de release — descubrimiento del smoke
//   28/04 cuando faltaban Outon -$223.263 y The Good Selection -$903.249.
// - El parser detecta el formato del CSV por las columnas del header.

import { createMpTokenGetter } from './_mp-token.js';
import {
  parseListBody,
  isCsv,
  parseCsv,
  detectarFormatoCsv,
  procesarFilaSettlement,
  procesarFilaRelease,
  SETTLEMENT_TIPOS,
} from './_mp-csv.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars',
      });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Getter de token MP con cache scoped al handler. Llama a la RPC
    // get_mp_token() (SECURITY DEFINER) que desencripta el bytea.
    const getMpToken = createMpTokenGetter(db);

    // Reset opcional: si viene ?reset=1,2 borramos todos los
    // mp_movimientos de esos locales antes de volver a sincronizar.
    // Pensado para re-clasificar filas guardadas con lógica vieja.
    const resetParam =
      (req.query && (req.query.reset || req.query.reset_local)) ||
      (req.body && (req.body.reset || req.body.reset_local));
    const resetIds = (() => {
      if (resetParam == null || resetParam === '') return [];
      return String(resetParam)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
    })();
    const resetSummary = [];
    for (const lid of resetIds) {
      const { error: delErr, count } = await db
        .from('mp_movimientos')
        .delete({ count: 'exact' })
        .eq('local_id', lid);
      if (delErr) {
        console.error('mp-sync: reset delete error', lid, delErr);
        resetSummary.push({ local_id: lid, error: delErr.message });
      } else {
        console.log('[mp-sync] reset deleted mp_movimientos for local_id=' + lid, 'count=', count);
        resetSummary.push({ local_id: lid, deleted: count ?? null });
      }
    }

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('id, local_id, tenant_id, saldo_inicial, saldo_inicial_at, locales(nombre)')
      .eq('activo', true);

    if (credsError) {
      console.error('mp-sync: error fetching credentials', credsError);
      return res.status(500).json({ ok: false, error: credsError.message });
    }
    if (!creds || creds.length === 0) {
      return res.status(200).json({ message: 'Sin credenciales configuradas' });
    }

    // Dedup global: las filas rr-* y set-* son las autoritativas (vienen
    // del reporte oficial). Si existe una fila SIN prefijo (data legacy de
    // payments-API) con el mismo referencia_id, la borramos.
    let cleanupDedupDeleted = null;
    try {
      const { data: allMovs } = await db.from('mp_movimientos').select('id, referencia_id');
      if (allMovs && allMovs.length) {
        const releasedRefIds = new Set();
        for (const m of allMovs) {
          const idStr = m.id ? String(m.id) : '';
          if ((idStr.startsWith('rr-') || idStr.startsWith('set-')) && m.referencia_id) {
            releasedRefIds.add(String(m.referencia_id));
          }
        }
        const dupeIds = [];
        for (const m of allMovs) {
          const idStr = m.id ? String(m.id) : '';
          // pay-* y fee-* (TASK 0.18) son fuentes complementarias por
          // date_created vía payments/search. Conviven con rr-/set- por
          // design — el conciliador dedupea por referencia_id en presentación.
          // NUNCA borramos pay-* ni fee-*.
          const isPrefixed =
            idStr.startsWith('rr-') ||
            idStr.startsWith('set-') ||
            idStr.startsWith('pay-') ||
            idStr.startsWith('fee-');
          if (idStr && !isPrefixed && m.referencia_id && releasedRefIds.has(String(m.referencia_id))) {
            dupeIds.push(idStr);
          }
        }
        if (dupeIds.length) {
          const { count } = await db.from('mp_movimientos').delete({ count: 'exact' }).in('id', dupeIds);
          cleanupDedupDeleted = count ?? dupeIds.length;
          console.log('[mp-sync] dedup cleanup deleted:', cleanupDedupDeleted);
        }
      }
    } catch (e) {
      console.error('mp-sync: dedup cleanup exception', e);
    }

    // Default: release_report. Settlement_report se quedó como override
    // opcional (?source=settlement) tras la investigación del 28/04: el
    // settlement_report no incluye payouts (transferencias salientes a
    // CBU) ni eventos de release del saldo, sólo cobros con TRANSACTION_DATE
    // original. Para conciliar contra el balance MP por movimiento, la
    // fuente correcta es release_report (cubre payments liberados, payouts,
    // refunds, chargebacks, asset_management). Sin fallback automático para
    // no doblar la cuota MP (cada POST cuenta contra el límite de 24/día
    // por endpoint).
    const sourceOverride = (req.query?.source || req.body?.source || '').toLowerCase();
    const sourceDefault = sourceOverride === 'settlement' ? 'settlement' : 'release';

    const resultados = [];
    let balanceTotalMP = 0;
    // Agregado por tenant — la fila legacy de saldos_caja es 1 por tenant
    // (post-multitenant). cred.tenant_id viene de la query de mp_credenciales.
    const balancesPorTenant = new Map();
    let balanceConsultado = false;

    for (const cred of creds) {
      try {
        const token = await getMpToken(cred.id);

        // Rango UTC. begin = hace 7 días 00:00 UTC, end = ahora.
        const pad = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const begin = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const beginIso = `${begin.getUTCFullYear()}-${pad(begin.getUTCMonth() + 1)}-${pad(begin.getUTCDate())}T00:00:00Z`;
        const endIso = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;

        const reportInfo = {
          source: null,
          config_status: null,
          post_status: null,
          post_body: null,
          file_name: null,
          file_date_created: null,
          rows_upserted: 0,
          rows_skipped_unknown_type: 0,
          rows_skipped_other: 0,
          distinct_unknown_types: [],
          error: null,
        };

        // ── 1. PUT /config + POST. Solo el endpoint elegido (settlement
        //     por default, release si ?source=release). SIN fallback
        //     automático: cada POST consume una task del cuenter de MP
        //     (24/día por endpoint), y doblar el intento se come la
        //     cuota cuando MP devuelve 429.
        const baseUrl = sourceDefault === 'release'
          ? 'https://api.mercadopago.com/v1/account/release_report'
          : 'https://api.mercadopago.com/v1/account/settlement_report';
        reportInfo.source = sourceDefault;

        // PUT /config (idempotente, best-effort). No consume "tasks"
        // del cuenter de generación.
        try {
          const cfgRes = await fetch(`${baseUrl}/config`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scheduled: true,
              execute_after_withdrawal: false,
              display_timezone: 'GMT-03',
              frequency: { hour: 23, type: 'daily' },
            }),
          });
          reportInfo.config_status = cfgRes.status;
        } catch {}

        // POST: dispara la generación del CSV. Consume 1 task.
        const prePostTs = Date.now();
        let postRes;
        try {
          postRes = await fetch(baseUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ begin_date: beginIso, end_date: endIso }),
          });
        } catch (eFetch) {
          reportInfo.error = `POST ${sourceDefault} fetch_error: ${eFetch?.message || String(eFetch)}`;
          console.error('[mp-sync]', reportInfo.error, cred.local_id);
          resultados.push({ local: cred.locales?.nombre, local_id: cred.local_id, report: reportInfo });
          continue;
        }
        const postBody = (await postRes.text()).slice(0, 200);
        reportInfo.post_status = postRes.status;
        reportInfo.post_body = postBody;

        if (!postRes.ok) {
          reportInfo.error = `POST ${sourceDefault} ${postRes.status}: ${postBody}`;
          console.warn('[mp-sync]', reportInfo.error, cred.local_id);
          resultados.push({ local: cred.locales?.nombre, local_id: cred.local_id, report: reportInfo });
          continue;
        }

        // ── 2. Esperar 90s para que MP genere el CSV ──
        console.log('[mp-sync] esperando 90s para CSV...', cred.local_id, 'source=' + reportInfo.source);
        await sleep(90000);

        // ── 3. GET /list buscando el CSV recién creado ──
        // baseUrl ya está definido arriba (línea ~156).
        try {
          const listRes = await fetch(`${baseUrl}/list`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!listRes.ok) {
            reportInfo.error = `LIST ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`;
          } else {
            const listBody = await listRes.text();
            const rawFiles = parseListBody(listBody);
            const csvFiles = rawFiles
              .filter(f => isCsv(f))
              .filter(f => new Date(f.date_created || f.date || 0).getTime() >= prePostTs - 5000)
              .sort((a, b) => new Date(b.date_created || b.date || 0) - new Date(a.date_created || a.date || 0));
            const target = csvFiles[0];
            if (!target) {
              reportInfo.error = `CSV no encontrado en ${reportInfo.source}_report después de 90s (disponibles: ${csvFiles.length})`;
              console.warn('[mp-sync]', reportInfo.error);
            } else {
              reportInfo.file_name = target.file_name || target.fileName || target.name || null;
              reportInfo.file_date_created = target.date_created || target.date || null;
              console.log('[mp-sync] CSV encontrado', cred.local_id, reportInfo.file_name);
            }
          }
        } catch (e) {
          reportInfo.error = 'LIST: ' + String(e?.message || e);
        }

        // ── 4. GET file + parse + upsert ──
        if (reportInfo.file_name) {
          try {
            const fileRes = await fetch(
              `${baseUrl}/${encodeURIComponent(reportInfo.file_name)}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!fileRes.ok) {
              reportInfo.error = `FILE ${fileRes.status}: ${(await fileRes.text()).slice(0, 200)}`;
            } else {
              const csvText = await fileRes.text();
              const { header, rows } = parseCsv(csvText);
              const formato = detectarFormatoCsv(header);
              console.log('[mp-sync] CSV cargado', cred.local_id, 'formato=' + formato, 'rows=' + rows.length);

              if (!formato) {
                reportInfo.error = 'formato CSV desconocido (sin TRANSACTION_TYPE ni RECORD_TYPE)';
              } else {
                const unknownTypes = new Map();
                const skippedMotivos = new Map();   // motivo → count, desglose de skips
                // Pre-cargar referencia_ids ya importados para dedup pre-upsert.
                const { data: existing } = await db
                  .from('mp_movimientos')
                  .select('id, referencia_id')
                  .eq('local_id', cred.local_id);
                const refIdToId = new Map();
                for (const m of existing || []) {
                  if (m.referencia_id) refIdToId.set(String(m.referencia_id), String(m.id || ''));
                }

                for (let i = 0; i < rows.length; i++) {
                  const cells = rows[i];
                  const result = formato === 'settlement'
                    ? procesarFilaSettlement(cells, header, cred.local_id)
                    : procesarFilaRelease(cells, header, cred.local_id, i);

                  // Multi-tenant: cada fila hereda tenant_id de la credencial.
                  if (result.row && cred.tenant_id) result.row.tenant_id = cred.tenant_id;

                  if (result.skipped) {
                    if (result.transType && !SETTLEMENT_TIPOS[result.transType]) {
                      unknownTypes.set(result.transType, (unknownTypes.get(result.transType) || 0) + 1);
                      skippedMotivos.set('unknown_settlement_type', (skippedMotivos.get('unknown_settlement_type') || 0) + 1);
                      reportInfo.rows_skipped_unknown_type++;
                    } else {
                      const motivo = result.motivo
                        || (result.recordType && result.recordType !== 'release' ? 'non_release_record' : 'other');
                      skippedMotivos.set(motivo, (skippedMotivos.get(motivo) || 0) + 1);
                      reportInfo.rows_skipped_other++;
                    }
                    continue;
                  }

                  // Dedup: si ya existe rr-{X} o set-{X} con mismo referencia_id, skip.
                  const refId = result.row.referencia_id;
                  const existingId = refIdToId.get(String(refId));
                  if (existingId && existingId !== result.row.id) {
                    if (existingId.startsWith('rr-') || existingId.startsWith('set-')) {
                      reportInfo.rows_skipped_other++;
                      continue;
                    }
                  }

                  await db.from('mp_movimientos').upsert([result.row], { onConflict: 'id' });
                  reportInfo.rows_upserted++;
                }

                if (unknownTypes.size > 0) {
                  reportInfo.distinct_unknown_types = Array.from(unknownTypes.entries())
                    .map(([type, count]) => ({ type, count }))
                    .sort((a, b) => b.count - a.count);
                  console.log('[mp-sync] TRANSACTION_TYPEs ignorados:', reportInfo.distinct_unknown_types);
                }
                if (skippedMotivos.size > 0) {
                  reportInfo.skipped_motivos = Array.from(skippedMotivos.entries())
                    .map(([motivo, count]) => ({ motivo, count }))
                    .sort((a, b) => b.count - a.count);
                  console.log('[mp-sync] skipped por motivo:', reportInfo.skipped_motivos);
                }
              }
            }
          } catch (e) {
            reportInfo.error = 'PARSE: ' + String(e?.message || e);
          }
        }

        // ── 5. Cálculo del saldo legacy (rr-* AND set-* approved post-corte) ──
        const saldoInicialNum = Number.isFinite(Number(cred.saldo_inicial)) ? Number(cred.saldo_inicial) : 0;
        const corte = cred.saldo_inicial_at ? new Date(cred.saldo_inicial_at) : null;

        let saldoAprobado = 0;
        let porAcreditar = 0;
        let movDespuesCount = 0;

        const { data: movLocal, error: movErr } = await db
          .from('mp_movimientos')
          .select('id, monto, estado, fecha')
          .eq('local_id', cred.local_id)
          .or('id.like.rr-%,id.like.set-%')
          .eq('estado', 'approved');
        if (movErr) {
          console.error('mp-sync: sum error', cred.local_id, movErr);
        } else if (corte) {
          for (const m of movLocal || []) {
            const monto = Number(m.monto) || 0;
            if (m.fecha && new Date(m.fecha) >= corte) {
              saldoAprobado += monto;
              movDespuesCount++;
            }
          }
        }

        if (corte) {
          const { data: pendMovs } = await db
            .from('mp_movimientos')
            .select('monto')
            .eq('local_id', cred.local_id)
            .in('estado', ['in_process', 'pending'])
            .gt('monto', 0);
          for (const m of pendMovs || []) {
            porAcreditar += Number(m.monto) || 0;
          }
        }

        const credSaldoDisponible = corte ? saldoInicialNum + saldoAprobado : 0;

        console.log(
          '[mp-sync] saldo legacy local_id=' + cred.local_id,
          'inicial=' + saldoInicialNum,
          'aprobado=' + saldoAprobado,
          'disponible=' + credSaldoDisponible,
          'filas=' + movDespuesCount
        );

        balanceTotalMP += credSaldoDisponible;
        if (cred.tenant_id) {
          balancesPorTenant.set(
            cred.tenant_id,
            (balancesPorTenant.get(cred.tenant_id) || 0) + credSaldoDisponible
          );
        }
        balanceConsultado = true;

        // ── 6. UPDATE saldo legacy ──
        let updErr = null;
        try {
          const { error } = await db
            .from('mp_credenciales')
            .update({
              ultima_sync: new Date().toISOString(),
              saldo_disponible: credSaldoDisponible,
              por_acreditar: porAcreditar,
              balance_at: new Date().toISOString(),
            })
            .eq('id', cred.id);
          if (error) {
            console.error('mp-sync: update error', cred.local_id, error);
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('does not exist') || msg.includes('schema cache') || error.code === 'PGRST204') {
              await db.from('mp_credenciales').update({ ultima_sync: new Date().toISOString() }).eq('id', cred.id);
            }
            updErr = error.message;
          }
        } catch (e) {
          updErr = e.message;
        }

        resultados.push({
          local: cred.locales?.nombre,
          local_id: cred.local_id,
          report: reportInfo,
          saldo_inicial: saldoInicialNum,
          saldo_aprobado: saldoAprobado,
          saldo_disponible: credSaldoDisponible,
          por_acreditar: porAcreditar,
          movs_en_saldo: movDespuesCount,
          upd_error: updErr || undefined,
        });
      } catch (err) {
        console.error('mp-sync: error processing credential', cred?.local_id, err);
        resultados.push({ local: cred.locales?.nombre, error: err.message });
      }
    }

    // Actualizar saldo total en saldos_caja: una fila legacy por TENANT con
    // la suma de saldo_disponible de las creds de ese tenant. Antes hardcodeaba
    // neko; post-multitenant cada cred ya viene con su tenant_id correcto.
    if (balanceConsultado) {
      for (const [tenantId, total] of balancesPorTenant) {
        if (!tenantId) continue;
        const { data: existe } = await db
          .from('saldos_caja')
          .select('cuenta, local_id, tenant_id')
          .eq('cuenta', 'MercadoPago')
          .is('local_id', null)
          .eq('tenant_id', tenantId)
          .maybeSingle();
        if (existe) {
          await db.from('saldos_caja')
            .update({ saldo: total })
            .eq('cuenta', 'MercadoPago')
            .is('local_id', null)
            .eq('tenant_id', tenantId);
        } else {
          await db.from('saldos_caja').insert([{
            cuenta: 'MercadoPago',
            saldo: total,
            tenant_id: tenantId,
          }]);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      reset_summary: resetSummary.length ? resetSummary : undefined,
      resultados,
      balance_mp: balanceConsultado ? balanceTotalMP : null,
      cleanup_dedup_deleted: cleanupDedupDeleted,
    });
  } catch (err) {
    console.error('mp-sync: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
