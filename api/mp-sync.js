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
//  1. collector_id === miId → INGRESO (nos pagaron: somos el receptor).
//  2. payer.id === miId → EGRESO (nosotros pagamos a alguien).
//  3. transaction_amount < 0 → EGRESO.
//  4. operation_type money_transfer / recurring_payment / investment /
//     cellphone_recharge / bank_withdrawal → EGRESO con tipo específico.
//  5. Keyword de proveedor/servicio conocido → EGRESO (payment_out).
//  6. Fallback: ingreso (point si es POS físico, payment si es online).
function clasificarPago(pago, accountId) {
  const opType = (pago?.operation_type || '').toLowerCase();
  // payer id viene a veces como `payer_id` (top-level) y a veces como
  // `payer.id` (objeto anidado). Lo mismo con collector.
  const payerId =
    pago?.payer_id != null
      ? String(pago.payer_id)
      : pago?.payer?.id != null
      ? String(pago.payer.id)
      : '';
  const collectorId =
    pago?.collector_id != null
      ? String(pago.collector_id)
      : pago?.collector?.id != null
      ? String(pago.collector.id)
      : '';
  const miId = accountId != null ? String(accountId) : '';
  const monto = Number(pago?.transaction_amount) || 0;

  // 1. collector somos nosotros → ingreso.
  if (miId && collectorId && collectorId === miId) {
    if (esPagoPoint(pago)) return { direccion: 1, tipo: 'point' };
    return { direccion: 1, tipo: 'payment' };
  }

  // 2. payer somos nosotros → egreso.
  if (miId && payerId && payerId === miId) {
    return { direccion: -1, tipo: 'payment_out' };
  }

  // 3. transaction_amount negativo → egreso.
  if (monto < 0) {
    return { direccion: -1, tipo: 'payment_out' };
  }

  // 4. operation_types que son siempre egresos.
  if (opType === 'money_transfer') return { direccion: -1, tipo: 'money_transfer' };
  if (opType === 'recurring_payment') return { direccion: -1, tipo: 'recurring' };
  if (opType === 'investment') return { direccion: -1, tipo: 'investment' };
  if (opType === 'cellphone_recharge') return { direccion: -1, tipo: 'recharge' };
  if (opType === 'bank_withdrawal') return { direccion: -1, tipo: 'withdrawal' };

  // 5. Keyword de proveedor conocido.
  if (matchEgresoKeyword(pago)) {
    return { direccion: -1, tipo: 'payment_out' };
  }

  // 6. Fallback final: ingreso.
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

    // Reset opcional: si viene ?reset=1,2 borramos todos los
    // mp_movimientos de esos locales antes de volver a sincronizar.
    // Pensado para re-clasificar filas guardadas con lógica vieja.
    const resetParam =
      (req.query && (req.query.reset || req.query.reset_local)) ||
      (req.body && (req.body.reset || req.body.reset_local));
    const resetIds = (() => {
      if (resetParam == null || resetParam === '') return [];
      const arr = String(resetParam)
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
      return arr;
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
        console.log(
          '[mp-sync] reset deleted mp_movimientos for local_id=' + lid,
          'count=',
          count
        );
        resetSummary.push({ local_id: lid, deleted: count ?? null });
      }
    }

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

    // One-time cleanup: las filas con id 'mt-*' eran los duplicados que
    // generaba el probe anterior de money_transfer. Se borran antes de
    // cada sync hasta confirmar que no vuelven a generarse.
    let cleanupMtDeleted = null;
    try {
      const { error: delMtErr, count: delMtCount } = await db
        .from('mp_movimientos')
        .delete({ count: 'exact' })
        .like('id', 'mt-%');
      if (delMtErr) {
        console.error('mp-sync: cleanup mt-% error', delMtErr);
      } else {
        cleanupMtDeleted = delMtCount ?? null;
        console.log(
          '[mp-sync] cleanup mt-% rows deleted:',
          cleanupMtDeleted
        );
      }
    } catch (e) {
      console.error('mp-sync: cleanup mt-% exception', e);
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
        // Si saldo_inicial_at aún no fue fijado, NO sumamos nada y
        // saldo_disponible queda igual a saldo_inicial.
        const saldoInicialRaw = cred.saldo_inicial;
        const saldoInicial = Number(saldoInicialRaw);
        const saldoInicialNum = Number.isFinite(saldoInicial) ? saldoInicial : 0;
        const saldoInicialAt = cred.saldo_inicial_at || null;
        const corte = saldoInicialAt ? new Date(saldoInicialAt) : null;

        let saldoAprobado = 0;
        let porAcreditar = 0;
        let movTotalCount = 0;
        let movDespuesCount = 0;
        let movMinFecha = null;
        let movMaxFecha = null;
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
            movTotalCount++;
            if (m.fecha) {
              if (!movMinFecha || m.fecha < movMinFecha) movMinFecha = m.fecha;
              if (!movMaxFecha || m.fecha > movMaxFecha) movMaxFecha = m.fecha;
            }
            const monto = Number(m.monto) || 0;
            const estado = (m.estado || '').toLowerCase();
            if (estado === 'approved') {
              if (corte && m.fecha && new Date(m.fecha) >= corte) {
                saldoAprobado += monto;
                movDespuesCount++;
              }
              // Sin corte: saldo_aprobado queda en 0, disponible = inicial.
            } else if (
              (estado === 'in_process' || estado === 'pending') &&
              monto > 0
            ) {
              porAcreditar += monto;
            }
          }
        }

        let credSaldoDisponible = saldoInicialNum + saldoAprobado;
        let balanceFuente = 'saldo_inicial+movimientos';

        // Release report (settlement) — saldo real de MP.
        // Flujo: POST para generar un reporte con el rango, GET /list para
        // obtener el nombre de archivo, GET /<file_name> para bajar el CSV,
        // y parsear la última fila en busca de BALANCE_AMOUNT o
        // SETTLEMENT_NET_CREDIT_AMOUNT como "closing balance".
        const releaseReport = {
          config_status: null,
          config_body: null,
          post_status: null,
          post_body: null,
          list_status: null,
          list_body: null,
          list_attempts: 0,
          file_name: null,
          file_date_created: null,
          created_from: null,
          file_status: null,
          file_snippet: null,
          csv_rows: null,
          initial_balance: null,
          total_credit: null,
          total_debit: null,
          mov_rows: null,
          release_rows_upserted: null,
          parsed_balance: null,
          parse_method: null,
          first_time_message: null,
          error: null,
        };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
          // ISO 8601 en UTC, sin milisegundos. begin_date al inicio del día
          // de hace 3 días, end_date al segundo actual — lo que MP acepta.
          const pad = (n) => String(n).padStart(2, '0');
          const now = new Date();
          const begin = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
          const beginIso =
            `${begin.getUTCFullYear()}-${pad(begin.getUTCMonth() + 1)}-${pad(
              begin.getUTCDate()
            )}T00:00:00Z`;
          const endIso =
            `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(
              now.getUTCDate()
            )}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(
              now.getUTCSeconds()
            )}Z`;

          // 1) PUT /config — garantiza que el reporte diario automático
          //    esté activo. Es idempotente, se ejecuta en cada sync.
          try {
            const configRes = await fetch(
              'https://api.mercadopago.com/v1/account/release_report/config',
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${cred.access_token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  scheduled: true,
                  execute_after_withdrawal: false,
                  display_timezone: 'GMT-03',
                  frequency: { hour: 23, type: 'daily' },
                }),
              }
            );
            releaseReport.config_status = configRes.status;
            releaseReport.config_body =
              (await configRes.text())?.slice(0, 200) || null;
            console.log(
              '[mp-sync] release_report PUT /config',
              cred.local_id,
              configRes.status,
              releaseReport.config_body
            );
          } catch (e) {
            releaseReport.error =
              (releaseReport.error ? releaseReport.error + ' | ' : '') +
              'CONFIG: ' + String(e?.message || e);
          }

          // 2) GET /list — buscamos primero el reporte programado más
          //    reciente (created_from='schedule'). Si existe lo usamos;
          //    ya trae el closing_balance del día cerrado.
          const parseListBody = (body) => {
            let data = null;
            try { data = body ? JSON.parse(body) : null; } catch {}
            return Array.isArray(data)
              ? data
              : Array.isArray(data?.results)
              ? data.results
              : [];
          };
          const sortByDateDesc = (arr) =>
            arr.slice().sort((a, b) => {
              const da = new Date(a?.date_created || a?.date || 0).getTime();
              const db_ = new Date(b?.date_created || b?.date || 0).getTime();
              return db_ - da;
            });
          const isCsv = (f) =>
            (f?.file_name || f?.fileName || f?.name || '').toLowerCase().endsWith('.csv');

          let scheduledFile = null;
          try {
            const listRes = await fetch(
              'https://api.mercadopago.com/v1/account/release_report/list',
              { headers: { Authorization: `Bearer ${cred.access_token}` } }
            );
            releaseReport.list_status = listRes.status;
            releaseReport.list_attempts = 1;
            const listBody = await listRes.text();
            releaseReport.list_body = listBody?.slice(0, 300) || null;
            console.log(
              '[mp-sync] release_report /list',
              cred.local_id,
              listRes.status,
              releaseReport.list_body
            );
            const rawFiles = parseListBody(listBody);
            const scheduledCsvs = sortByDateDesc(
              rawFiles.filter(
                (f) =>
                  isCsv(f) &&
                  (f?.created_from || '').toLowerCase() === 'schedule'
              )
            );
            scheduledFile = scheduledCsvs[0] || null;
          } catch (e) {
            releaseReport.error =
              (releaseReport.error ? releaseReport.error + ' | ' : '') +
              'LIST: ' + String(e?.message || e);
          }

          if (scheduledFile) {
            releaseReport.file_name =
              scheduledFile.file_name ||
              scheduledFile.fileName ||
              scheduledFile.name ||
              null;
            releaseReport.file_date_created =
              scheduledFile.date_created || scheduledFile.date || null;
            releaseReport.created_from = 'schedule';
          } else {
            // 3) No hay reporte programado todavía — pedimos uno manual
            //    como fallback y mostramos el mensaje de primera vez.
            releaseReport.first_time_message =
              'El primer reporte automático estará disponible mañana';
            try {
              const postRes = await fetch(
                'https://api.mercadopago.com/v1/account/release_report',
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${cred.access_token}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    begin_date: beginIso,
                    end_date: endIso,
                  }),
                }
              );
              releaseReport.post_status = postRes.status;
              releaseReport.post_body =
                (await postRes.text())?.slice(0, 200) || null;
              console.log(
                '[mp-sync] release_report POST',
                cred.local_id,
                postRes.status,
                releaseReport.post_body
              );
            } catch (e) {
              releaseReport.error =
                (releaseReport.error ? releaseReport.error + ' | ' : '') +
                'POST: ' + String(e?.message || e);
            }

            // Poll /list buscando el manual recién creado (hoy).
            const todayStart = new Date();
            todayStart.setUTCHours(0, 0, 0, 0);
            const todayMs = todayStart.getTime();
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) await sleep(2000);
              releaseReport.list_attempts =
                (releaseReport.list_attempts || 0) + 1;
              try {
                const listRes = await fetch(
                  'https://api.mercadopago.com/v1/account/release_report/list',
                  { headers: { Authorization: `Bearer ${cred.access_token}` } }
                );
                releaseReport.list_status = listRes.status;
                const listBody = await listRes.text();
                releaseReport.list_body = listBody?.slice(0, 300) || null;
                const rawFiles = parseListBody(listBody);
                const manualToday = sortByDateDesc(
                  rawFiles.filter((f) => {
                    if (!isCsv(f)) return false;
                    const dc = new Date(
                      f?.date_created || f?.date || 0
                    ).getTime();
                    return dc >= todayMs;
                  })
                );
                const latest = manualToday[0];
                if (latest) {
                  releaseReport.file_name =
                    latest.file_name || latest.fileName || latest.name || null;
                  releaseReport.file_date_created =
                    latest.date_created || latest.date || null;
                  releaseReport.created_from =
                    (latest?.created_from || 'manual').toLowerCase();
                  break;
                }
              } catch (e) {
                releaseReport.error =
                  (releaseReport.error ? releaseReport.error + ' | ' : '') +
                  'LIST poll ' +
                  (attempt + 1) +
                  ': ' +
                  String(e?.message || e);
              }
            }
          }

          // 3) GET /<file_name> — descarga el CSV del reporte.
          if (releaseReport.file_name) {
            try {
              const fileRes = await fetch(
                `https://api.mercadopago.com/v1/account/release_report/${encodeURIComponent(
                  releaseReport.file_name
                )}`,
                { headers: { Authorization: `Bearer ${cred.access_token}` } }
              );
              releaseReport.file_status = fileRes.status;
              const csvText = await fileRes.text();
              releaseReport.file_snippet = csvText?.slice(0, 200) || null;
              console.log(
                '[mp-sync] release_report file',
                cred.local_id,
                fileRes.status,
                csvText?.length,
                'chars'
              );

              if (fileRes.ok && csvText) {
                // Parseo del CSV del release_report.
                //   - Si es un reporte programado (día cerrado), trae la
                //     fila closing_balance: esa es la fuente preferida.
                //   - Si es un reporte manual del día en curso, usamos
                //     initial_available_balance + SUM(NET_CREDIT) −
                //     SUM(NET_DEBIT) como reconstrucción.
                const parseNumero = (raw) => {
                  if (raw == null || raw === '') return null;
                  const s = String(raw).trim();
                  if (!s) return null;
                  const normal =
                    s.includes(',') && s.includes('.')
                      ? s.replace(/\./g, '').replace(',', '.')
                      : s.includes(',') && !s.includes('.')
                      ? s.replace(',', '.')
                      : s;
                  const v = Number(normal);
                  return Number.isFinite(v) ? v : null;
                };

                const cleanCsv = csvText.replace(/^\uFEFF/, '');
                const lines = cleanCsv
                  .split(/\r?\n/)
                  .map((l) => l.trim())
                  .filter(Boolean);
                releaseReport.csv_rows = lines.length;

                if (lines.length >= 2) {
                  const sep = lines[0].includes(';') ? ';' : ',';
                  const header = lines[0]
                    .split(sep)
                    .map((h) => h.replace(/^"|"$/g, '').trim().toUpperCase());
                  const idxRecordType = header.indexOf('RECORD_TYPE');
                  const idxBalance = header.indexOf('BALANCE_AMOUNT');
                  const idxNetCredit = header.indexOf('NET_CREDIT_AMOUNT');
                  const idxNetDebit = header.indexOf('NET_DEBIT_AMOUNT');
                  const FILAS_ESPECIALES = new Set([
                    'initial_available_balance',
                    'closing_balance',
                    'total',
                  ]);

                  // Procesar filas RECORD_TYPE='release': capturan las
                  // liberaciones del release_report, que incluyen las
                  // transferencias bancarias (CBU) a proveedores.
                  //   NET_DEBIT_AMOUNT  > 0 → transferencia saliente
                  //   NET_CREDIT_AMOUNT > 0 → liquidación entrante
                  const idxDate = header.indexOf('DATE');
                  const idxSourceId = header.indexOf('SOURCE_ID');
                  const idxExternalRef = header.indexOf('EXTERNAL_REFERENCE');
                  const idxDescription = header.indexOf('DESCRIPTION');
                  let cantRelease = 0;
                  if (
                    idxRecordType !== -1 &&
                    (idxNetCredit !== -1 || idxNetDebit !== -1)
                  ) {
                    for (let i = 1; i < lines.length; i++) {
                      const cells = lines[i]
                        .split(sep)
                        .map((c) => c.replace(/^"|"$/g, '').trim());
                      const tipo = (cells[idxRecordType] || '').toLowerCase();
                      if (tipo !== 'release') continue;
                      const netCredit =
                        idxNetCredit !== -1
                          ? parseNumero(cells[idxNetCredit]) || 0
                          : 0;
                      const netDebit =
                        idxNetDebit !== -1
                          ? parseNumero(cells[idxNetDebit]) || 0
                          : 0;
                      if (netCredit <= 0 && netDebit <= 0) continue;

                      const sourceId =
                        idxSourceId !== -1 ? cells[idxSourceId] || '' : '';
                      const extRef =
                        idxExternalRef !== -1
                          ? cells[idxExternalRef] || ''
                          : '';
                      const rawDate =
                        idxDate !== -1 ? cells[idxDate] || '' : '';
                      const descripcionRaw =
                        idxDescription !== -1
                          ? cells[idxDescription] || ''
                          : '';
                      const uniqueKey =
                        sourceId || `${rawDate}-${extRef || i}`;

                      let monto = 0;
                      let rowTipo = null;
                      let descripcionDefault = '';
                      if (netDebit > 0) {
                        monto = -netDebit;
                        rowTipo = 'bank_transfer';
                        descripcionDefault = 'Transferencia enviada';
                      } else {
                        monto = netCredit;
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

                      await db.from('mp_movimientos').upsert(
                        [
                          {
                            id: `rr-${uniqueKey}`,
                            local_id: cred.local_id,
                            fecha: fechaIso,
                            tipo: rowTipo,
                            descripcion: descripcionRaw || descripcionDefault,
                            monto,
                            saldo: null,
                            estado: 'approved',
                            referencia_id:
                              extRef || sourceId || String(uniqueKey),
                            medio_pago:
                              rowTipo === 'bank_transfer'
                                ? 'bank_transfer'
                                : null,
                          },
                        ],
                        { onConflict: 'id' }
                      );
                      cantRelease++;
                    }
                  }
                  releaseReport.release_rows_upserted = cantRelease;

                  // Método 1: closing_balance (sólo existe en reportes
                  // programados del día cerrado).
                  let closingBalance = null;
                  if (idxRecordType !== -1 && idxBalance !== -1) {
                    for (let i = lines.length - 1; i >= 1; i--) {
                      const cells = lines[i]
                        .split(sep)
                        .map((c) => c.replace(/^"|"$/g, '').trim());
                      const tipo = (cells[idxRecordType] || '').toLowerCase();
                      if (tipo === 'closing_balance') {
                        const v = parseNumero(cells[idxBalance]);
                        if (v != null) {
                          closingBalance = v;
                          break;
                        }
                      }
                    }
                  }

                  if (closingBalance != null) {
                    releaseReport.parsed_balance = closingBalance;
                    releaseReport.parse_method = 'closing_balance';
                  } else {
                    // Método 2: initial_available_balance + créditos − débitos.
                    let initialBalance = null;
                    if (idxRecordType !== -1 && idxBalance !== -1) {
                      for (let i = 1; i < lines.length; i++) {
                        const cells = lines[i]
                          .split(sep)
                          .map((c) => c.replace(/^"|"$/g, '').trim());
                        const tipo = (cells[idxRecordType] || '').toLowerCase();
                        if (tipo === 'initial_available_balance') {
                          const v = parseNumero(cells[idxBalance]);
                          if (v != null) initialBalance = v;
                          break;
                        }
                      }
                    }

                    let totalCredit = 0;
                    let totalDebit = 0;
                    let movRows = 0;
                    if (
                      idxRecordType !== -1 &&
                      idxNetCredit !== -1 &&
                      idxNetDebit !== -1
                    ) {
                      for (let i = 1; i < lines.length; i++) {
                        const cells = lines[i]
                          .split(sep)
                          .map((c) => c.replace(/^"|"$/g, '').trim());
                        const tipo = (cells[idxRecordType] || '').toLowerCase();
                        if (!tipo || FILAS_ESPECIALES.has(tipo)) continue;
                        const c = parseNumero(cells[idxNetCredit]) || 0;
                        const d = parseNumero(cells[idxNetDebit]) || 0;
                        totalCredit += c;
                        totalDebit += d;
                        movRows++;
                      }
                    }

                    if (initialBalance != null) {
                      releaseReport.parsed_balance =
                        initialBalance + totalCredit - totalDebit;
                      releaseReport.parse_method =
                        'initial_balance_plus_movements';
                      releaseReport.initial_balance = initialBalance;
                      releaseReport.total_credit = totalCredit;
                      releaseReport.total_debit = totalDebit;
                      releaseReport.mov_rows = movRows;
                    }
                  }
                }
              }
            } catch (e) {
              releaseReport.error =
                (releaseReport.error ? releaseReport.error + ' | ' : '') +
                'FILE: ' + String(e?.message || e);
            }
          }
        } catch (e) {
          releaseReport.error =
            (releaseReport.error ? releaseReport.error + ' | ' : '') +
            String(e?.message || e);
        }

        // Saldo real de la cuenta MP — lo pedimos explícitamente al
        // endpoint /v1/account/balance. Si devuelve 200 con
        // available_balance, esa es la fuente de verdad y reemplaza al
        // cálculo manual (saldo_inicial + aprobados). Si no, queda el
        // fallback manual.
        const balanceApiProbe = {
          url: 'https://api.mercadopago.com/v1/account/balance',
          status: null,
          snippet: null,
          error: null,
          available_balance: null,
        };
        try {
          const apiRes = await fetch(balanceApiProbe.url, {
            headers: {
              Authorization: `Bearer ${cred.access_token}`,
              Accept: 'application/json',
            },
          });
          balanceApiProbe.status = apiRes.status;
          const body = await apiRes.text();
          balanceApiProbe.snippet = (body || '').slice(0, 300);
          console.log(
            '[mp-sync] /v1/account/balance',
            cred.local_id,
            apiRes.status,
            balanceApiProbe.snippet
          );
          if (apiRes.ok) {
            let parsed = null;
            try {
              parsed = body ? JSON.parse(body) : null;
            } catch {
              parsed = null;
            }
            // Busca available_balance en distintos niveles (por si MP
            // lo devuelve dentro de un objeto anidado).
            const walk = (obj, depth = 0) => {
              if (!obj || typeof obj !== 'object' || depth > 4) return null;
              if (
                obj.available_balance != null &&
                !Number.isNaN(Number(obj.available_balance))
              ) {
                return Number(obj.available_balance);
              }
              for (const v of Object.values(obj)) {
                if (v && typeof v === 'object') {
                  const found = walk(v, depth + 1);
                  if (found != null) return found;
                }
              }
              return null;
            };
            const detected = walk(parsed);
            if (detected != null) {
              balanceApiProbe.available_balance = detected;
              credSaldoDisponible = detected;
              balanceFuente = 'v1/account/balance';
            }
          } else {
            balanceApiProbe.error = (body || '').slice(0, 200);
          }
        } catch (e) {
          balanceApiProbe.error = String(e?.message || e);
          console.error(
            '[mp-sync] /v1/account/balance fetch error',
            cred.local_id,
            e
          );
        }

        balanceTotalMP += credSaldoDisponible;
        balanceConsultado = true;

        console.log(
          '[mp-sync] balance debug local_id=' + cred.local_id,
          {
            saldo_inicial_raw: saldoInicialRaw,
            saldo_inicial_num: saldoInicialNum,
            saldo_inicial_at: saldoInicialAt,
            mov_total: movTotalCount,
            mov_despues_corte: movDespuesCount,
            saldo_aprobado: saldoAprobado,
            saldo_disponible: credSaldoDisponible,
            por_acreditar: porAcreditar,
            release_report_balance: releaseReport.parsed_balance,
            balance_fuente: balanceFuente,
          }
        );

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
          local_id: cred.local_id,
          account_id: accountId,
          movimientos: cantPagos,
          comisiones: cantFees,
          reembolsos: cantRefunds,
          saldo_debug: {
            saldo_inicial_raw: saldoInicialRaw,
            saldo_inicial_num: saldoInicialNum,
            saldo_inicial_at: saldoInicialAt,
            mov_total: movTotalCount,
            mov_despues_corte: movDespuesCount,
            mov_min_fecha: movMinFecha,
            mov_max_fecha: movMaxFecha,
            saldo_aprobado: saldoAprobado,
            saldo_disponible: credSaldoDisponible,
            por_acreditar: porAcreditar,
          },
          release_report: releaseReport,
          balance_api_probe: balanceApiProbe,
          balance_fuente: balanceFuente,
          saldo_inicial: saldoInicialNum,
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
      reset: resetSummary.length ? resetSummary : undefined,
      cleanup_mt_deleted: cleanupMtDeleted,
    });
  } catch (err) {
    console.error('mp-sync: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
