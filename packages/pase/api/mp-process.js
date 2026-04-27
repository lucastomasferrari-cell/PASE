// mp-process: descarga el CSV más reciente del settlement_report (con
// fallback a release_report), inserta filas en mp_movimientos según el
// formato detectado, calcula saldo legacy y trae saldo desde API MP.
//
// PARTE C de TASK 0.11:
// - REMOVIDO el call a /v1/payments/search. Esa API traía cobros/ventas
//   con tipo='point'/'payment' que NO afectan el saldo released — eran
//   ruido y obligaban a un filter posterior en el frontend.
// - settlement_report es la fuente única de movimientos del saldo
//   released. Sus filas tienen TRANSACTION_TYPE explícito que mapeamos
//   a nuestros tipos PASE (liquidacion, bank_transfer, refund, chargeback).
// - Si settlement_report no está disponible (mp-generate hizo fallback),
//   detectamos el formato por el header del CSV y procesamos como release_report
//   (parser legacy con RECORD_TYPE='release').

import { createMpTokenGetter } from './_mp-token.js';
import { fetchMpBalance } from './_mp-balance.js';
import {
  SETTLEMENT_TIPOS,
  parseListBody,
  isCsv,
  parseCsv,
  detectarFormatoCsv,
  procesarFilaSettlement,
  procesarFilaRelease,
} from './_mp-csv.js';

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const getMpToken = createMpTokenGetter(db);

    // timestamp opcional del POST de mp-generate, para buscar CSV frescos.
    const generateTs = Number(req.query?.ts || req.body?.ts) || 0;
    // Hint del source que mp-generate decidió usar (settlement|release).
    // Si no viene, intentamos settlement y fallback a release.
    const generateSource = (req.query?.source || req.body?.source || '').toLowerCase();

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('id, local_id, saldo_inicial, saldo_inicial_at, locales(nombre)')
      .eq('activo', true);

    if (credsError) {
      return res.status(500).json({ ok: false, error: credsError.message });
    }
    if (!creds || creds.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sin credenciales configuradas' });
    }

    // Dedup global: si quedaron filas viejas sin prefijo (de cuando se usaba
    // payments-API directo) que tienen contraparte rr-* o set-*, las borramos.
    let cleanupDedupDeleted = null;
    try {
      const { data: allMovs } = await db.from('mp_movimientos').select('id, referencia_id');
      if (allMovs && allMovs.length) {
        const releasedRefIds = new Set();
        for (const m of allMovs) {
          if (m.id && (String(m.id).startsWith('rr-') || String(m.id).startsWith('set-')) && m.referencia_id) {
            releasedRefIds.add(String(m.referencia_id));
          }
        }
        const dupeIds = [];
        for (const m of allMovs) {
          const idStr = m.id ? String(m.id) : '';
          const isPrefixed = idStr.startsWith('rr-') || idStr.startsWith('set-');
          if (idStr && !isPrefixed && m.referencia_id && releasedRefIds.has(String(m.referencia_id))) {
            dupeIds.push(idStr);
          }
        }
        if (dupeIds.length) {
          const { count } = await db.from('mp_movimientos').delete({ count: 'exact' }).in('id', dupeIds);
          cleanupDedupDeleted = count ?? dupeIds.length;
          console.log('[mp-process] dedup cleanup deleted:', cleanupDedupDeleted);
        }
      }
    } catch (e) {
      console.error('mp-process: dedup cleanup exception', e);
    }

    const resultados = [];
    let balanceTotalMP = 0;
    let balanceConsultado = false;

    for (const cred of creds) {
      try {
        const token = await getMpToken(cred.id);

        // ── Descargar CSV: intentar settlement_report primero (a menos que
        //    mp-generate haya forzado release), fallback a release_report ──
        const reportInfo = {
          source: null,            // 'settlement' | 'release'
          file_name: null,
          file_date_created: null,
          rows_upserted: 0,
          rows_skipped_unknown_type: 0,
          rows_skipped_other: 0,
          distinct_unknown_types: [],
          error: null,
        };

        const probarReporte = async (sourceTry) => {
          const baseUrl = sourceTry === 'settlement'
            ? 'https://api.mercadopago.com/v1/account/settlement_report'
            : 'https://api.mercadopago.com/v1/account/release_report';
          const listRes = await fetch(`${baseUrl}/list`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!listRes.ok) {
            return { ok: false, status: listRes.status, body: (await listRes.text()).slice(0, 200) };
          }
          const listBody = await listRes.text();
          const rawFiles = parseListBody(listBody);
          const csvFiles = rawFiles
            .filter(f => isCsv(f))
            .sort((a, b) => new Date(b.date_created || 0) - new Date(a.date_created || 0));
          let target = null;
          if (generateTs) {
            target = csvFiles.find(f => new Date(f.date_created || 0).getTime() >= generateTs - 5000);
          } else {
            target = csvFiles[0] || null;
          }
          if (!target) return { ok: false, noFresh: true, available: csvFiles.length };
          return { ok: true, baseUrl, target, fileName: target.file_name || target.fileName || target.name };
        };

        // Si mp-generate eligió release explícitamente, ir directo a release.
        let probe = null;
        if (generateSource === 'release') {
          probe = await probarReporte('release');
          reportInfo.source = 'release';
        } else {
          probe = await probarReporte('settlement');
          if (probe.ok) {
            reportInfo.source = 'settlement';
          } else {
            console.warn('[mp-process] settlement_report sin CSV fresco, fallback a release', probe);
            probe = await probarReporte('release');
            reportInfo.source = 'release';
          }
        }

        if (!probe.ok) {
          reportInfo.error = probe.noFresh
            ? `CSV no encontrado en ${reportInfo.source}_report (disponibles: ${probe.available || 0})`
            : `${reportInfo.source}_report list ${probe.status}: ${probe.body}`;
        } else {
          reportInfo.file_name = probe.fileName;
          reportInfo.file_date_created = probe.target.date_created || probe.target.date || null;
          console.log('[mp-process] CSV', reportInfo.source, reportInfo.file_name, reportInfo.file_date_created);

          // Descargar el CSV.
          const fileRes = await fetch(
            `${probe.baseUrl}/${encodeURIComponent(probe.fileName)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!fileRes.ok) {
            reportInfo.error = `FILE ${fileRes.status}: ${(await fileRes.text()).slice(0, 200)}`;
          } else {
            const csvText = await fileRes.text();
            const { header, rows } = parseCsv(csvText);
            const formato = detectarFormatoCsv(header);
            console.log('[mp-process] CSV cargado', cred.local_id, 'formato=' + formato, 'rows=' + rows.length);

            if (!formato) {
              reportInfo.error = `formato CSV desconocido (header sin TRANSACTION_TYPE ni RECORD_TYPE)`;
            } else {
              const unknownTypes = new Map();
              // Pre-cargar referencia_ids ya importados (rr-* y set-*) para dedup
              // de seguridad antes del upsert.
              const { data: existing } = await db
                .from('mp_movimientos')
                .select('id, referencia_id')
                .eq('local_id', cred.local_id);
              const refIdToId = new Map();
              const idsExistentes = new Set();
              for (const m of existing || []) {
                if (m.id) idsExistentes.add(String(m.id));
                if (m.referencia_id) refIdToId.set(String(m.referencia_id), String(m.id || ''));
              }

              for (let i = 0; i < rows.length; i++) {
                const cells = rows[i];
                const result = formato === 'settlement'
                  ? procesarFilaSettlement(cells, header, cred.local_id)
                  : procesarFilaRelease(cells, header, cred.local_id, i);

                if (result.skipped) {
                  if (result.transType && !SETTLEMENT_TIPOS[result.transType]) {
                    unknownTypes.set(result.transType, (unknownTypes.get(result.transType) || 0) + 1);
                    reportInfo.rows_skipped_unknown_type++;
                  } else {
                    reportInfo.rows_skipped_other++;
                  }
                  continue;
                }

                // Dedup: si ya existe rr-{X} o set-{X} con el mismo referencia_id,
                // skip — el set-* nuevo no debe duplicar la data legacy ni la fila
                // existente.
                const refId = result.row.referencia_id;
                const existingId = refIdToId.get(String(refId));
                if (existingId && existingId !== result.row.id) {
                  // Hay otra fila con el mismo referencia_id. Si es prefijada
                  // (rr- o set-), la respetamos como autoritaria y skipeamos.
                  if (existingId.startsWith('rr-') || existingId.startsWith('set-')) {
                    reportInfo.rows_skipped_other++;
                    continue;
                  }
                  // Si NO es prefijada (data legacy de payments-API), seguirá
                  // existiendo pero quedará oculta por el filter de PARTE A.
                  // El sweep dedup global del inicio del handler la borra
                  // cuando aparece el set-* equivalente.
                }

                await db.from('mp_movimientos').upsert([result.row], { onConflict: 'id' });
                reportInfo.rows_upserted++;
              }

              if (unknownTypes.size > 0) {
                reportInfo.distinct_unknown_types = Array.from(unknownTypes.entries())
                  .map(([type, count]) => ({ type, count }))
                  .sort((a, b) => b.count - a.count);
                console.log('[mp-process] TRANSACTION_TYPEs ignorados:', reportInfo.distinct_unknown_types);
              }
            }
          }
        }

        // ── Cálculo del saldo legacy (post upsert + dedup) ──
        // Mantiene la lógica histórica para no romper la card legacy
        // mientras la card "Saldo MP (API)" no esté disponible. Suma sobre
        // movimientos rr-* AND set-* (ambos son prefijos de filas autoritarias
        // que afectan saldo released).
        const saldoInicialNum = Number.isFinite(Number(cred.saldo_inicial)) ? Number(cred.saldo_inicial) : 0;
        const corte = cred.saldo_inicial_at ? new Date(cred.saldo_inicial_at) : null;

        let saldoAprobado = 0;
        let porAcreditar = 0;
        let movDespuesCount = 0;

        const { data: movLocal, error: movErr } = await db
          .from('mp_movimientos')
          .select('id, tipo, monto, estado, fecha')
          .eq('local_id', cred.local_id)
          .or('id.like.rr-%,id.like.set-%')
          .eq('estado', 'approved');
        if (movErr) {
          console.error('mp-process: sum error', cred.local_id, movErr);
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
          '[mp-process] saldo legacy local_id=' + cred.local_id,
          'inicial=' + saldoInicialNum,
          'aprobado=' + saldoAprobado,
          'disponible=' + credSaldoDisponible,
          'filas=' + movDespuesCount
        );

        balanceTotalMP += credSaldoDisponible;
        balanceConsultado = true;

        // UPDATE saldo legacy.
        let { error: updErr } = await db
          .from('mp_credenciales')
          .update({
            ultima_sync: new Date().toISOString(),
            saldo_disponible: credSaldoDisponible,
            por_acreditar: porAcreditar,
            balance_at: new Date().toISOString(),
          })
          .eq('local_id', cred.local_id);
        if (updErr) {
          console.error('mp-process: update error', cred.local_id, updErr);
          const msg = (updErr.message || '').toLowerCase();
          if (msg.includes('does not exist') || msg.includes('schema cache') || updErr.code === 'PGRST204') {
            await db.from('mp_credenciales').update({ ultima_sync: new Date().toISOString() }).eq('local_id', cred.local_id);
          }
        }

        // ── Saldo REAL desde API MP (PARTE B de TASK 0.11) ──
        // Best-effort: si falla, log + seguir. Las columnas saldo_mp_*
        // quedan NULL hasta el próximo intento.
        let saldoApi = null;
        try {
          const bal = await fetchMpBalance(token);
          saldoApi = { available: bal.available, total: bal.total, unavailable: bal.unavailable };
          await db.from('mp_credenciales').update({
            saldo_mp_actual: bal.available,
            saldo_mp_total: bal.total,
            saldo_mp_unavailable: bal.unavailable,
            saldo_mp_actualizado_at: new Date().toISOString(),
          }).eq('id', cred.id);
        } catch (e) {
          console.error('[mp-process] balance fetch failed', cred.local_id, e?.message);
          saldoApi = { error: e?.message || String(e) };
        }

        resultados.push({
          local: cred.locales?.nombre,
          local_id: cred.local_id,
          report_source: reportInfo.source,
          report_file: reportInfo.file_name,
          report_date: reportInfo.file_date_created,
          rows_upserted: reportInfo.rows_upserted,
          rows_skipped_unknown_type: reportInfo.rows_skipped_unknown_type,
          rows_skipped_other: reportInfo.rows_skipped_other,
          distinct_unknown_types: reportInfo.distinct_unknown_types,
          report_error: reportInfo.error || undefined,
          saldo_inicial: saldoInicialNum,
          saldo_aprobado: saldoAprobado,
          saldo_disponible: credSaldoDisponible,
          por_acreditar: porAcreditar,
          movs_en_saldo: movDespuesCount,
          upd_error: updErr ? updErr.message : undefined,
          saldo_api: saldoApi,
        });
      } catch (err) {
        console.error('mp-process: error processing credential', cred?.local_id, err);
        resultados.push({ local: cred.locales?.nombre, error: err.message });
      }
    }

    // Actualizar saldo en saldos_caja (suma legacy de todos los locales).
    if (balanceConsultado) {
      const { data: existe } = await db
        .from('saldos_caja')
        .select('cuenta')
        .eq('cuenta', 'MercadoPago')
        .maybeSingle();
      if (existe) {
        await db.from('saldos_caja').update({ saldo: balanceTotalMP }).eq('cuenta', 'MercadoPago');
      } else {
        await db.from('saldos_caja').insert([{ cuenta: 'MercadoPago', saldo: balanceTotalMP }]);
      }
    }

    return res.status(200).json({
      ok: true,
      resultados,
      balance_mp: balanceConsultado ? balanceTotalMP : null,
      cleanup_dedup_deleted: cleanupDedupDeleted,
    });
  } catch (err) {
    console.error('mp-process: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
