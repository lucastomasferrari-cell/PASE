// Detecta si un pago proviene de un dispositivo Mercado Pago Point (venta presencial)
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

// Clasifica el tipo de movimiento para la columna `tipo` del UI.
// Valores consumidos por TIPO_LABELS en el front: payment, point, fee, refund, withdrawal, money_transfer, tax, payout, dispute.
function clasificarPago(pago) {
  if (esPagoPoint(pago)) return 'point';
  return 'payment';
}

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars',
      });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('*, locales(nombre)')
      .eq('activo', true);

    if (credsError) {
      console.error('mp-sync: error fetching credentials', credsError);
      return res.status(500).json({ ok: false, error: credsError.message });
    }

    if (!creds || creds.length === 0) {
      return res.status(200).json({ message: 'Sin credenciales configuradas' });
    }

    const resultados = [];
    let balanceTotalMP = 0;
    let balanceConsultado = false;

    for (const cred of creds) {
      try {
        const hasta = new Date();
        const desde = new Date();
        desde.setDate(desde.getDate() - 7);
        const beginDate = desde.toISOString();
        const endDate = hasta.toISOString();

        const mpUrl =
          `https://api.mercadopago.com/v1/payments/search?` +
          `begin_date=${encodeURIComponent(beginDate)}` +
          `&end_date=${encodeURIComponent(endDate)}` +
          `&sort=date_created&criteria=desc&limit=200`;

        const mpRes = await fetch(mpUrl, {
          headers: { Authorization: `Bearer ${cred.access_token}` },
        });
        const mpData = await mpRes.json();

        if (!mpRes.ok) {
          resultados.push({
            local: cred.locales?.nombre,
            error: `MP API ${mpRes.status}: ${mpData?.message || 'error'}`,
          });
          continue;
        }

        let cantPagos = 0;
        let cantFees = 0;
        let cantRefunds = 0;

        if (mpData.results) {
          for (const pago of mpData.results) {
            const monto = Number(pago.transaction_amount) || 0;
            const neto =
              pago?.transaction_details?.net_received_amount != null
                ? Number(pago.transaction_details.net_received_amount)
                : null;
            const tipo = clasificarPago(pago);
            const fecha = pago.date_approved || pago.date_created;
            const payTypeId = pago.payment_type_id || null;

            const descripcion =
              pago.description ||
              pago.statement_descriptor ||
              (payTypeId ? payTypeId : tipo === 'point' ? 'Venta Point' : 'Pago MP');

            await db.from('mp_movimientos').upsert(
              [
                {
                  id: String(pago.id),
                  local_id: cred.local_id,
                  fecha,
                  tipo,
                  descripcion,
                  monto,
                  saldo: neto,
                  estado: pago.status,
                  referencia_id: String(pago.external_reference || pago.id),
                  medio_pago: pago.payment_method_id || payTypeId || null,
                },
              ],
              { onConflict: 'id' }
            );
            cantPagos++;

            // Comisiones MP: generan egreso que debe conciliarse.
            const fees = Array.isArray(pago.fee_details) ? pago.fee_details : [];
            const totalFee = fees.reduce(
              (s, f) => s + (Number(f.amount) || 0),
              0
            );
            if (totalFee > 0 && pago.status === 'approved') {
              await db.from('mp_movimientos').upsert(
                [
                  {
                    id: `${pago.id}-fee`,
                    local_id: cred.local_id,
                    fecha,
                    tipo: 'fee',
                    descripcion: `Comisión MP · ${payTypeId || ''}`.trim(),
                    monto: -Math.abs(totalFee),
                    saldo: null,
                    estado: pago.status,
                    referencia_id: String(pago.id),
                    medio_pago: payTypeId,
                  },
                ],
                { onConflict: 'id' }
              );
              cantFees++;
            }

            // Reembolsos: egresos con monto negativo.
            const refunds = Array.isArray(pago.refunds) ? pago.refunds : [];
            for (const r of refunds) {
              const rMonto = Number(r.amount) || 0;
              if (rMonto <= 0) continue;
              await db.from('mp_movimientos').upsert(
                [
                  {
                    id: `${pago.id}-ref-${r.id}`,
                    local_id: cred.local_id,
                    fecha: r.date_created || fecha,
                    tipo: 'refund',
                    descripcion: `Reembolso · ${r.reason || pago.description || ''}`.trim(),
                    monto: -rMonto,
                    saldo: null,
                    estado: r.status || 'approved',
                    referencia_id: String(pago.id),
                    medio_pago: payTypeId,
                  },
                ],
                { onConflict: 'id' }
              );
              cantRefunds++;
            }
          }
        }

        // Saldo real de la cuenta MP — se suma al total global para actualizar saldos_caja.
        try {
          const balRes = await fetch(
            'https://api.mercadopago.com/v1/account/balance',
            { headers: { Authorization: `Bearer ${cred.access_token}` } }
          );
          if (balRes.ok) {
            const balData = await balRes.json();
            const disponible =
              Number(balData.available_balance) ||
              Number(balData.total_amount) ||
              0;
            balanceTotalMP += disponible;
            balanceConsultado = true;
          } else {
            console.warn(
              'mp-sync: balance endpoint returned',
              balRes.status,
              'for local',
              cred.local_id
            );
          }
        } catch (balErr) {
          console.error('mp-sync: balance fetch error', cred.local_id, balErr);
        }

        await db
          .from('mp_credenciales')
          .update({ ultima_sync: new Date().toISOString() })
          .eq('local_id', cred.local_id);

        resultados.push({
          local: cred.locales?.nombre,
          movimientos: cantPagos,
          comisiones: cantFees,
          reembolsos: cantRefunds,
        });
      } catch (err) {
        console.error('mp-sync: error processing credential', cred?.local_id, err);
        resultados.push({ local: cred.locales?.nombre, error: err.message });
      }
    }

    // Actualizar saldo MercadoPago en saldos_caja con el total real sumado de todas las cuentas.
    if (balanceConsultado) {
      const { data: existe } = await db
        .from('saldos_caja')
        .select('cuenta')
        .eq('cuenta', 'MercadoPago')
        .maybeSingle();

      if (existe) {
        await db
          .from('saldos_caja')
          .update({ saldo: balanceTotalMP })
          .eq('cuenta', 'MercadoPago');
      } else {
        await db
          .from('saldos_caja')
          .insert([{ cuenta: 'MercadoPago', saldo: balanceTotalMP }]);
      }
    }

    return res.status(200).json({
      ok: true,
      resultados,
      balance_mp: balanceConsultado ? balanceTotalMP : null,
    });
  } catch (err) {
    console.error('mp-sync: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
