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

// Palabras clave en descripción / statement_descriptor que identifican
// proveedores y servicios que SIEMPRE son egresos, aunque la dirección
// por ids no sea concluyente. Se evalúa en upper-case.
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

// Clasifica un pago como ingreso (+) o egreso (-) y devuelve el tipo de UI.
// Orden de reglas (primera que matchee gana):
//  1. Keyword de proveedor/servicio conocido → egreso (payment_out).
//  2. operation_type money_transfer / recurring_payment / investment /
//     cellphone_recharge / bank_withdrawal → egreso con tipo específico.
//  3. operation_type regular_payment + payer.id === miId → egreso (le pagamos a alguien).
//  4. operation_type regular_payment + collector.id === miId → ingreso (nos pagaron).
//  5. Fallback: ingreso (point si es POS físico, payment si es online).
function clasificarPago(pago, accountId) {
  const opType = pago?.operation_type || '';
  const payerId = pago?.payer?.id != null ? String(pago.payer.id) : '';
  const collectorId =
    pago?.collector_id != null
      ? String(pago.collector_id)
      : pago?.collector?.id != null
      ? String(pago.collector.id)
      : '';
  const miId = accountId != null ? String(accountId) : '';

  if (matchEgresoKeyword(pago)) {
    return { direccion: -1, tipo: 'payment_out' };
  }

  if (opType === 'money_transfer') return { direccion: -1, tipo: 'money_transfer' };
  if (opType === 'recurring_payment') return { direccion: -1, tipo: 'recurring' };
  if (opType === 'investment') return { direccion: -1, tipo: 'investment' };
  if (opType === 'cellphone_recharge') return { direccion: -1, tipo: 'recharge' };
  if (opType === 'bank_withdrawal') return { direccion: -1, tipo: 'withdrawal' };

  if (opType === 'regular_payment') {
    if (miId && payerId && payerId === miId) {
      return { direccion: -1, tipo: 'payment_out' };
    }
    if (miId && collectorId && collectorId === miId) {
      if (esPagoPoint(pago)) return { direccion: 1, tipo: 'point' };
      return { direccion: 1, tipo: 'payment' };
    }
  }

  if (esPagoPoint(pago)) return { direccion: 1, tipo: 'point' };
  return { direccion: 1, tipo: 'payment' };
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

    // Cache de ids de cuenta por access_token — se resuelve una sola vez
    // por sync y se reutiliza al clasificar cada pago.
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
          id =
            accData?.id != null
              ? String(accData.id)
              : accData?.user_id != null
              ? String(accData.user_id)
              : null;
        }
      } catch (e) {
        console.error('mp-sync: /v1/account fetch error', e);
      }
      if (!id) {
        // Fallback a /users/me si /v1/account no devuelve id.
        try {
          const meRes = await fetch('https://api.mercadopago.com/users/me', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (meRes.ok) {
            const meData = await meRes.json();
            id = meData?.id != null ? String(meData.id) : null;
          }
        } catch (e) {
          console.error('mp-sync: /users/me fetch error', e);
        }
      }
      accountIdCache.set(token, id);
      return id;
    };

    for (const cred of creds) {
      try {
        const accountId = await resolverAccountId(cred.access_token);

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
            const bruto = Number(pago.transaction_amount) || 0;
            const { direccion, tipo } = clasificarPago(pago, accountId);
            const monto = direccion * Math.abs(bruto);
            const neto =
              pago?.transaction_details?.net_received_amount != null
                ? Number(pago.transaction_details.net_received_amount) * direccion
                : null;
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

            // Comisiones MP: egreso automático, se marca conciliado=true
            // porque no requiere justificación manual (son costos fijos MP
            // que se agregan solos en la pestaña "Comisiones MP").
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
                    conciliado: true,
                    vinculo_tipo: 'auto',
                    vinculo_id: String(pago.id),
                    conciliado_at: new Date().toISOString(),
                    conciliado_por: 'sistema',
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

        // Saldo real = saldo_inicial (ingresado por el usuario) + suma
        // neta de movimientos aprobados con fecha >= saldo_inicial_at.
        // Si saldo_inicial_at aún no fue fijado, NO sumamos nada para
        // evitar arrastrar el histórico completo y mostramos saldo_inicial
        // tal cual. por_acreditar cuenta pending/in_process sin importar
        // el corte (ya que son plata futura).
        const saldoInicial = Number(cred.saldo_inicial) || 0;
        const saldoInicialAt = cred.saldo_inicial_at || null;
        const corte = saldoInicialAt ? new Date(saldoInicialAt) : null;

        let saldoAprobado = 0;
        let porAcreditar = 0;
        const { data: movLocal, error: movErr } = await db
          .from('mp_movimientos')
          .select('monto, estado, fecha')
          .eq('local_id', cred.local_id);
        if (movErr) {
          console.error(
            'mp-sync: sum mp_movimientos error',
            cred.local_id,
            movErr
          );
        } else {
          for (const m of movLocal || []) {
            const monto = Number(m.monto) || 0;
            const estado = (m.estado || '').toLowerCase();
            if (estado === 'approved') {
              if (corte && m.fecha && new Date(m.fecha) >= corte) {
                saldoAprobado += monto;
              }
              // Si no hay corte fijado, saldo_aprobado queda en 0 y el
              // disponible es simplemente saldo_inicial.
            } else if (
              (estado === 'in_process' || estado === 'pending') &&
              monto > 0
            ) {
              porAcreditar += monto;
            }
          }
        }

        const credSaldoDisponible = saldoInicial + saldoAprobado;
        balanceTotalMP += credSaldoDisponible;
        balanceConsultado = true;

        // Guardar el saldo calculado en mp_credenciales. Si las columnas
        // nuevas aún no existen, reintentamos sólo con ultima_sync.
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
          console.error(
            'mp-sync: mp_credenciales full update error',
            cred.local_id,
            updErr
          );
          const msg = (updErr.message || '').toLowerCase();
          const faltaColumna =
            msg.includes('does not exist') ||
            msg.includes('schema cache') ||
            updErr.code === 'PGRST204';
          if (faltaColumna) {
            const { error: fallbackErr } = await db
              .from('mp_credenciales')
              .update({ ultima_sync: new Date().toISOString() })
              .eq('local_id', cred.local_id);
            if (fallbackErr) {
              console.error(
                'mp-sync: mp_credenciales fallback update error',
                cred.local_id,
                fallbackErr
              );
            } else {
              updErr = {
                message:
                  'migration pendiente: aplicar 20260410_mp_balance_liquidaciones.sql para guardar el saldo',
              };
            }
          }
        }

        resultados.push({
          local: cred.locales?.nombre,
          movimientos: cantPagos,
          comisiones: cantFees,
          reembolsos: cantRefunds,
          saldo_inicial: saldoInicial,
          saldo_aprobado: saldoAprobado,
          saldo_disponible: credSaldoDisponible,
          por_acreditar: porAcreditar,
          upd_error: updErr ? updErr.message : undefined,
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
