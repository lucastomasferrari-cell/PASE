// mp-process: descarga CSV más reciente, inserta filas rr-*, calcula saldo.
// Se llama DESPUÉS de mp-generate + espera de 2 minutos.

function esPagoPoint(pago) {
  const poi = pago?.point_of_interaction;
  if (!poi) return false;
  const type = (poi.type || '').toUpperCase();
  const subType = (poi.sub_type || '').toUpperCase();
  return (
    type === 'POINT' ||
    type === 'INTEGRATION' ||
    subType === 'PAYMENT_DEVICE' ||
    !!poi?.location
  );
}

const EGRESO_KEYWORDS = [
  'AYSA', 'EDESUR', 'EDENOR', 'METROGAS', 'NATURGY', 'CAMUZZI',
  'DISCO', 'JUMBO', 'VEA', 'COTO', 'CARREFOUR', 'WALMART', 'CENCOSUD',
  'DIA ', 'CHANGOMAS', 'MAKRO',
  'TELECENTRO', 'FIBERTEL', 'CABLEVISION', 'TELECOM', 'MOVISTAR',
  'CLARO', 'PERSONAL', 'DIRECTV', 'FLOW',
  'ABL', 'RENTAS', 'AFIP', 'ARBA', 'MUNICIPALIDAD', 'EXPENSAS',
  'NETFLIX', 'SPOTIFY', 'GOOGLE', 'MICROSOFT', 'AMAZON',
];

function matchEgresoKeyword(pago) {
  const partes = [
    pago?.description || '',
    pago?.statement_descriptor || '',
    pago?.additional_info?.items?.[0]?.title || '',
  ];
  const texto = partes.join(' ').toUpperCase();
  return EGRESO_KEYWORDS.some((k) => texto.includes(k));
}

function clasificarPago(pago, accountId) {
  const opType = (pago?.operation_type || '').toLowerCase();
  const payerId =
    pago?.payer_id != null ? String(pago.payer_id)
    : pago?.payer?.id != null ? String(pago.payer.id) : '';
  const collectorId =
    pago?.collector_id != null ? String(pago.collector_id)
    : pago?.collector?.id != null ? String(pago.collector.id) : '';
  const miId = accountId != null ? String(accountId) : '';
  const monto = Number(pago?.transaction_amount) || 0;

  if (miId && collectorId && collectorId === miId) {
    const payTypeId = (pago?.payment_type_id || '').toLowerCase();
    if (payTypeId === 'bank_transfer') return { direccion: 1, tipo: 'bank_transfer_in' };
    if (esPagoPoint(pago)) return { direccion: 1, tipo: 'point' };
    return { direccion: 1, tipo: 'payment' };
  }
  if (miId && payerId && payerId === miId) return { direccion: -1, tipo: 'payment_out' };
  if (monto < 0) return { direccion: -1, tipo: 'payment_out' };
  if (opType === 'money_transfer') return { direccion: -1, tipo: 'money_transfer' };
  if (opType === 'recurring_payment') return { direccion: -1, tipo: 'recurring' };
  if (opType === 'investment') return { direccion: -1, tipo: 'investment' };
  if (opType === 'cellphone_recharge') return { direccion: -1, tipo: 'recharge' };
  if (opType === 'bank_withdrawal') return { direccion: -1, tipo: 'withdrawal' };
  if (matchEgresoKeyword(pago)) return { direccion: -1, tipo: 'payment_out' };
  if (esPagoPoint(pago)) return { direccion: 1, tipo: 'point' };
  return { direccion: 1, tipo: 'payment' };
}

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // timestamp opcional del POST de mp-generate, para buscar CSV frescos
    const generateTs = Number(req.query?.ts || req.body?.ts) || 0;

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('*, locales(nombre)')
      .eq('activo', true);

    if (credsError) {
      return res.status(500).json({ ok: false, error: credsError.message });
    }
    if (!creds || creds.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sin credenciales configuradas' });
    }

    // Dedup global
    let cleanupDedupDeleted = null;
    try {
      const { data: allMovs } = await db.from('mp_movimientos').select('id, referencia_id');
      if (allMovs && allMovs.length) {
        const rrRefIds = new Set();
        for (const m of allMovs) {
          if (m.id && String(m.id).startsWith('rr-') && m.referencia_id) {
            rrRefIds.add(String(m.referencia_id));
          }
        }
        const dupeIds = [];
        for (const m of allMovs) {
          if (m.id && !String(m.id).startsWith('rr-') && m.referencia_id && rrRefIds.has(String(m.referencia_id))) {
            dupeIds.push(m.id);
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

    const accountIdCache = new Map();
    const resolverAccountId = async (token) => {
      if (accountIdCache.has(token)) return accountIdCache.get(token);
      let id = null;
      try {
        const accRes = await fetch('https://api.mercadopago.com/v1/account', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (accRes.ok) {
          const accData = await accRes.json();
          id = accData?.id != null ? String(accData.id) : accData?.user_id != null ? String(accData.user_id) : null;
        }
      } catch (e) { /* ignore */ }
      if (!id) {
        try {
          const meRes = await fetch('https://api.mercadopago.com/users/me', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (meRes.ok) {
            const meData = await meRes.json();
            id = meData?.id != null ? String(meData.id) : null;
          }
        } catch (e) { /* ignore */ }
      }
      accountIdCache.set(token, id);
      return id;
    };

    const resultados = [];
    let balanceTotalMP = 0;
    let balanceConsultado = false;

    const parseListBody = (body) => {
      let data = null;
      try { data = body ? JSON.parse(body) : null; } catch {}
      return Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
    };
    const isCsv = (f) => (f?.file_name || f?.fileName || f?.name || '').toLowerCase().endsWith('.csv');
    const parseNumero = (raw) => {
      if (raw == null || raw === '') return null;
      const s = String(raw).trim();
      if (!s) return null;
      const normal = s.includes(',') && s.includes('.') ? s.replace(/\./g, '').replace(',', '.')
        : s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s;
      const v = Number(normal);
      return Number.isFinite(v) ? v : null;
    };
    const round2 = (v) => Math.round(v * 100) / 100;

    for (const cred of creds) {
      try {
        const accountId = await resolverAccountId(cred.access_token);

        // ── 1. Payments API (últimos 7 días) ──
        const hasta = new Date();
        const desde = new Date();
        desde.setDate(desde.getDate() - 7);
        const mpUrl =
          `https://api.mercadopago.com/v1/payments/search?` +
          `begin_date=${encodeURIComponent(desde.toISOString())}` +
          `&end_date=${encodeURIComponent(hasta.toISOString())}` +
          `&sort=date_created&criteria=desc&limit=200`;

        const mpRes = await fetch(mpUrl, {
          headers: { Authorization: `Bearer ${cred.access_token}` },
        });
        const mpData = await mpRes.json();

        let cantPagos = 0, cantFees = 0, cantRefunds = 0, cantSkipped = 0;

        // Cargar referencia_ids de filas rr-* existentes para dedup
        const { data: rrExist } = await db
          .from('mp_movimientos')
          .select('referencia_id')
          .eq('local_id', cred.local_id)
          .like('id', 'rr-%');
        const rrRefIds = new Set();
        for (const r of rrExist || []) {
          if (r.referencia_id) rrRefIds.add(String(r.referencia_id));
        }

        if (mpRes.ok && mpData.results) {
          for (const pago of mpData.results) {
            const bruto = Number(pago.transaction_amount) || 0;
            const { direccion, tipo } = clasificarPago(pago, accountId);
            const monto = round2(direccion * Math.abs(bruto));
            const neto = pago?.transaction_details?.net_received_amount != null
              ? round2(Number(pago.transaction_details.net_received_amount) * direccion) : null;
            const fecha = pago.date_approved || pago.date_created;
            const payTypeId = pago.payment_type_id || null;
            const payRefId = String(pago.external_reference || pago.id);
            if (rrRefIds.has(payRefId)) { cantSkipped++; continue; }

            const descripcion = pago.description || pago.statement_descriptor ||
              (payTypeId ? payTypeId : tipo === 'point' ? 'Venta Point' : 'Pago MP');

            await db.from('mp_movimientos').upsert([{
              id: String(pago.id), local_id: cred.local_id, fecha, tipo, descripcion, monto,
              saldo: neto, estado: pago.status,
              referencia_id: String(pago.external_reference || pago.id),
              medio_pago: pago.payment_method_id || payTypeId || null,
            }], { onConflict: 'id' });
            cantPagos++;

            // Fees
            const fees = Array.isArray(pago.fee_details) ? pago.fee_details : [];
            const totalFee = fees.reduce((s, f) => s + (Number(f.amount) || 0), 0);
            if (totalFee > 0 && pago.status === 'approved') {
              await db.from('mp_movimientos').upsert([{
                id: `${pago.id}-fee`, local_id: cred.local_id, fecha, tipo: 'fee',
                descripcion: `Comisión MP · ${payTypeId || ''}`.trim(),
                monto: round2(-Math.abs(totalFee)), saldo: null, estado: pago.status,
                referencia_id: String(pago.id), medio_pago: payTypeId,
                conciliado: true, vinculo_tipo: 'auto', vinculo_id: String(pago.id),
                conciliado_at: new Date().toISOString(), conciliado_por: 'sistema',
              }], { onConflict: 'id' });
              cantFees++;
            }

            // Refunds
            for (const r of (Array.isArray(pago.refunds) ? pago.refunds : [])) {
              const rMonto = Number(r.amount) || 0;
              if (rMonto <= 0) continue;
              await db.from('mp_movimientos').upsert([{
                id: `${pago.id}-ref-${r.id}`, local_id: cred.local_id,
                fecha: r.date_created || fecha, tipo: 'refund',
                descripcion: `Reembolso · ${r.reason || pago.description || ''}`.trim(),
                monto: round2(-rMonto), saldo: null, estado: r.status || 'approved',
                referencia_id: String(pago.id), medio_pago: payTypeId,
              }], { onConflict: 'id' });
              cantRefunds++;
            }
          }
        }

        // ── 2. Release Report CSV (descargar el más reciente) ──
        const releaseReport = { file_name: null, file_date_created: null, release_rows_upserted: null, error: null };
        try {
          const listRes = await fetch(
            'https://api.mercadopago.com/v1/account/release_report/list',
            { headers: { Authorization: `Bearer ${cred.access_token}` } }
          );
          const listBody = await listRes.text();
          const rawFiles = parseListBody(listBody);

          // Si tenemos timestamp de mp-generate, buscar CSV posterior.
          // Si no, tomar el más reciente.
          let target = null;
          const csvFiles = rawFiles
            .filter(f => isCsv(f))
            .sort((a, b) => new Date(b.date_created || 0) - new Date(a.date_created || 0));

          if (generateTs) {
            target = csvFiles.find(f => new Date(f.date_created || 0).getTime() >= generateTs - 5000);
          } else {
            target = csvFiles[0] || null;
          }

          if (target) {
            releaseReport.file_name = target.file_name || target.fileName || target.name || null;
            releaseReport.file_date_created = target.date_created || target.date || null;
            console.log('[mp-process] CSV:', releaseReport.file_name, releaseReport.file_date_created);
          } else if (generateTs) {
            releaseReport.error = 'CSV no encontrado. MP no generó el reporte en el tiempo esperado.';
            console.warn('[mp-process] CSV no encontrado para ts=' + generateTs, 'disponibles:', csvFiles.map(f => f.file_name + ' ' + f.date_created).join(', '));
          }
        } catch (e) {
          releaseReport.error = 'LIST: ' + String(e?.message || e);
        }

        let cantRelease = 0;
        if (releaseReport.file_name) {
          try {
            const fileRes = await fetch(
              `https://api.mercadopago.com/v1/account/release_report/${encodeURIComponent(releaseReport.file_name)}`,
              { headers: { Authorization: `Bearer ${cred.access_token}` } }
            );
            const csvText = await fileRes.text();
            console.log('[mp-process] CSV downloaded', cred.local_id, csvText?.length, 'chars');

            if (fileRes.ok && csvText) {
              const cleanCsv = csvText.replace(/^\uFEFF/, '');
              const lines = cleanCsv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

              if (lines.length >= 2) {
                const sep = lines[0].includes(';') ? ';' : ',';
                const header = lines[0].split(sep).map(h => h.replace(/^"|"$/g, '').trim().toUpperCase());
                const idxRecordType = header.indexOf('RECORD_TYPE');
                const idxNetCredit = header.indexOf('NET_CREDIT_AMOUNT');
                const idxNetDebit = header.indexOf('NET_DEBIT_AMOUNT');
                const idxDate = header.indexOf('DATE');
                const idxSourceId = header.indexOf('SOURCE_ID');
                const idxExternalRef = header.indexOf('EXTERNAL_REFERENCE');
                const idxDescription = header.indexOf('DESCRIPTION');

                if (idxRecordType !== -1 && (idxNetCredit !== -1 || idxNetDebit !== -1)) {
                  for (let i = 1; i < lines.length; i++) {
                    const cells = lines[i].split(sep).map(c => c.replace(/^"|"$/g, '').trim());
                    const tipo = (cells[idxRecordType] || '').toLowerCase();
                    if (tipo !== 'release') continue;
                    const netCredit = idxNetCredit !== -1 ? parseNumero(cells[idxNetCredit]) || 0 : 0;
                    const netDebit = idxNetDebit !== -1 ? parseNumero(cells[idxNetDebit]) || 0 : 0;
                    if (netCredit <= 0 && netDebit <= 0) continue;

                    const sourceId = idxSourceId !== -1 ? cells[idxSourceId] || '' : '';
                    const extRef = idxExternalRef !== -1 ? cells[idxExternalRef] || '' : '';
                    const rawDate = idxDate !== -1 ? cells[idxDate] || '' : '';
                    const descripcionRaw = idxDescription !== -1 ? cells[idxDescription] || '' : '';
                    const uniqueKey = sourceId || `${rawDate}-${extRef || i}`;

                    let monto = 0, rowTipo = null, descripcionDefault = '';
                    if (netDebit > 0) {
                      monto = round2(-netDebit);
                      rowTipo = 'bank_transfer';
                      descripcionDefault = 'Transferencia enviada';
                    } else {
                      monto = round2(netCredit);
                      rowTipo = 'liquidacion';
                      descripcionDefault = 'Liquidación MP';
                    }

                    let fechaIso;
                    const parsed = rawDate ? new Date(rawDate) : null;
                    if (parsed && !Number.isNaN(parsed.getTime())) {
                      fechaIso = parsed.toISOString();
                    } else {
                      fechaIso = new Date().toISOString();
                    }

                    await db.from('mp_movimientos').upsert([{
                      id: `rr-${uniqueKey}`, local_id: cred.local_id, fecha: fechaIso,
                      tipo: rowTipo, descripcion: descripcionRaw || descripcionDefault,
                      monto, saldo: null, estado: 'approved',
                      referencia_id: extRef || sourceId || String(uniqueKey),
                      medio_pago: rowTipo === 'bank_transfer' ? 'bank_transfer' : null,
                    }], { onConflict: 'id' });
                    cantRelease++;
                  }
                }

                // Post-release dedup
                if (cantRelease > 0) {
                  try {
                    const { data: postMovs } = await db
                      .from('mp_movimientos')
                      .select('id, referencia_id')
                      .eq('local_id', cred.local_id);
                    if (postMovs && postMovs.length) {
                      const postRrRefs = new Set();
                      for (const m of postMovs) {
                        if (m.id && String(m.id).startsWith('rr-') && m.referencia_id) {
                          postRrRefs.add(String(m.referencia_id));
                        }
                      }
                      const postDupeIds = [];
                      for (const m of postMovs) {
                        if (m.id && !String(m.id).startsWith('rr-') && m.referencia_id && postRrRefs.has(String(m.referencia_id))) {
                          postDupeIds.push(m.id);
                        }
                      }
                      if (postDupeIds.length) {
                        await db.from('mp_movimientos').delete().in('id', postDupeIds);
                        console.log('[mp-process] post-release dedup:', postDupeIds.length);
                      }
                    }
                  } catch (e) {
                    console.error('mp-process: post-release dedup error', e);
                  }
                }
              }
            }
          } catch (e) {
            releaseReport.error = 'FILE: ' + String(e?.message || e);
          }
        }
        releaseReport.release_rows_upserted = cantRelease;

        // ── 3. Cálculo del saldo (post upsert + dedup) ──
        const saldoInicialRaw = cred.saldo_inicial;
        const saldoInicial = Number(saldoInicialRaw);
        const saldoInicialNum = Number.isFinite(saldoInicial) ? saldoInicial : 0;
        const saldoInicialAt = cred.saldo_inicial_at || null;
        const corte = saldoInicialAt ? new Date(saldoInicialAt) : null;

        let saldoAprobado = 0;
        let porAcreditar = 0;
        let movDespuesCount = 0;

        const { data: movLocal, error: movErr } = await db
          .from('mp_movimientos')
          .select('id, tipo, monto, estado, fecha')
          .eq('local_id', cred.local_id)
          .like('id', 'rr-%')
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
          '[mp-process] saldo local_id=' + cred.local_id,
          'inicial=' + saldoInicialNum,
          'aprobado=' + saldoAprobado,
          'disponible=' + credSaldoDisponible,
          'filas_rr=' + movDespuesCount
        );

        balanceTotalMP += credSaldoDisponible;
        balanceConsultado = true;

        // ── 4. UPDATE mp_credenciales ──
        const fullPayload = {
          ultima_sync: new Date().toISOString(),
          saldo_disponible: credSaldoDisponible,
          por_acreditar: porAcreditar,
          balance_at: new Date().toISOString(),
        };
        let { error: updErr } = await db
          .from('mp_credenciales')
          .update(fullPayload)
          .eq('local_id', cred.local_id);
        if (updErr) {
          console.error('mp-process: update error', cred.local_id, updErr);
          const msg = (updErr.message || '').toLowerCase();
          if (msg.includes('does not exist') || msg.includes('schema cache') || updErr.code === 'PGRST204') {
            await db.from('mp_credenciales').update({ ultima_sync: new Date().toISOString() }).eq('local_id', cred.local_id);
          }
        }

        resultados.push({
          local: cred.locales?.nombre,
          local_id: cred.local_id,
          movimientos: cantPagos,
          comisiones: cantFees,
          reembolsos: cantRefunds,
          skipped_duplicados: cantSkipped,
          release_rows: cantRelease,
          release_file: releaseReport.file_name,
          release_date: releaseReport.file_date_created,
          saldo_inicial: saldoInicialNum,
          saldo_aprobado: saldoAprobado,
          saldo_disponible: credSaldoDisponible,
          por_acreditar: porAcreditar,
          filas_rr_en_saldo: movDespuesCount,
          release_error: releaseReport.error || undefined,
          upd_error: updErr ? updErr.message : undefined,
        });
      } catch (err) {
        console.error('mp-process: error processing credential', cred?.local_id, err);
        resultados.push({ local: cred.locales?.nombre, error: err.message });
      }
    }

    // Actualizar saldo en saldos_caja
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
