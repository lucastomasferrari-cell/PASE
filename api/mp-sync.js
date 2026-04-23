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
    const payTypeId = (pago?.payment_type_id || '').toLowerCase();
    // Transferencias entrantes de persona a persona (CBU / alias) —
    // van directo al saldo disponible, no pasan por liquidación.
    if (payTypeId === 'bank_transfer') {
      return { direccion: 1, tipo: 'bank_transfer_in' };
    }
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

    // Dedup cleanup por referencia_id: las filas rr-* (release_report)
    // son la fuente autoritativa. Si existe una fila de la payments API
    // (id sin prefijo rr-) cuyo referencia_id coincide con el de una
    // fila rr-*, se borra la de payments API. Esto limpia duplicados
    // históricos de forma determinista, sin heurísticas de monto/día.
    let cleanupDedupDeleted = null;
    try {
      const { data: allMovs } = await db
        .from('mp_movimientos')
        .select('id, referencia_id');
      if (allMovs && allMovs.length) {
        const rrRefIds = new Set();
        for (const m of allMovs) {
          if (m.id && String(m.id).startsWith('rr-') && m.referencia_id) {
            rrRefIds.add(String(m.referencia_id));
          }
        }
        const dupeIds = [];
        for (const m of allMovs) {
          if (
            m.id &&
            !String(m.id).startsWith('rr-') &&
            m.referencia_id &&
            rrRefIds.has(String(m.referencia_id))
          ) {
            dupeIds.push(m.id);
          }
        }
        if (dupeIds.length) {
          const { error: delErr, count } = await db
            .from('mp_movimientos')
            .delete({ count: 'exact' })
            .in('id', dupeIds);
          if (delErr) {
            console.error('mp-sync: dedup cleanup error', delErr);
          } else {
            cleanupDedupDeleted = count ?? dupeIds.length;
            console.log(
              '[mp-sync] dedup cleanup deleted:',
              cleanupDedupDeleted
            );
          }
        }
      }
    } catch (e) {
      console.error('mp-sync: dedup cleanup exception', e);
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
        let cantSkipped = 0;

        const round2 = (v) => Math.round(v * 100) / 100;

        // Cargar referencia_ids de las filas rr-* (release_report) de este
        // local. Si un pago de la API tiene la misma referencia_id, el
        // release_report ya lo tiene cubierto → no insertar el duplicado.
        const { data: rrExist } = await db
          .from('mp_movimientos')
          .select('referencia_id')
          .eq('local_id', cred.local_id)
          .like('id', 'rr-%');
        const rrRefIds = new Set();
        for (const r of rrExist || []) {
          if (r.referencia_id) rrRefIds.add(String(r.referencia_id));
        }

        if (mpData.results) {
          for (const pago of mpData.results) {
            const bruto = Number(pago.transaction_amount) || 0;
            const { direccion, tipo } = clasificarPago(pago, accountId);
            const monto = round2(direccion * Math.abs(bruto));
            const neto =
              pago?.transaction_details?.net_received_amount != null
                ? round2(Number(pago.transaction_details.net_received_amount) * direccion)
                : null;
            const fecha = pago.date_approved || pago.date_created;
            const payTypeId = pago.payment_type_id || null;

            // Dedup: si ya existe una fila rr-* con el mismo referencia_id,
            // el release_report ya tiene este movimiento → no duplicar.
            const payRefId = String(pago.external_reference || pago.id);
            if (rrRefIds.has(payRefId)) {
              cantSkipped++;
              continue;
            }

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
                    monto: round2(-Math.abs(totalFee)),
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
                    monto: round2(-rMonto),
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


        // Saldo = saldo_inicial + SUM(monto) de filas rr-* approved
        // posteriores al corte. Si no hay saldo_inicial_at → $0.
        const saldoInicialRaw = cred.saldo_inicial;
        const saldoInicial = Number(saldoInicialRaw);
        const saldoInicialNum = Number.isFinite(saldoInicial) ? saldoInicial : 0;
        const saldoInicialAt = cred.saldo_inicial_at || null;
        const corte = saldoInicialAt ? new Date(saldoInicialAt) : null;

        let saldoAprobado = 0;
        let porAcreditar = 0;
        let movTotalCount = 0;
        let movDespuesCount = 0;
        const saldoTrace = {
          saldo_inicial_at_raw: saldoInicialAt,
          corte_iso: corte ? corte.toISOString() : null,
          counted_rows: [],
        };

        // Sin corte seteado, saldo_disponible = 0 (no hay referencia).
        if (!corte) {
          console.log(
            '[mp-sync] saldo local_id=' + cred.local_id,
            'sin saldo_inicial_at → saldo_disponible=0'
          );
        }

        // El cálculo del saldo se hace DESPUÉS del release report
        // y el dedup, para incluir las filas rr-* recién insertadas.

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

          // 2) POST — siempre generar un reporte nuevo con end_date=ahora
          //    para capturar movimientos hasta el momento exacto del sync.
          const parseListBody = (body) => {
            let data = null;
            try { data = body ? JSON.parse(body) : null; } catch {}
            return Array.isArray(data)
              ? data
              : Array.isArray(data?.results)
              ? data.results
              : [];
          };
          const isCsv = (f) =>
            (f?.file_name || f?.fileName || f?.name || '').toLowerCase().endsWith('.csv');

          const prePostTs = Date.now();
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

          // Esperar 90s para que MP genere el CSV.
          console.log(
            '[mp-sync] esperando 90s para CSV...',
            cred.local_id
          );
          await sleep(90000);

          // GET /list — buscar el CSV recién creado.
          try {
            const listRes = await fetch(
              'https://api.mercadopago.com/v1/account/release_report/list',
              { headers: { Authorization: `Bearer ${cred.access_token}` } }
            );
            releaseReport.list_status = listRes.status;
            releaseReport.list_attempts = 1;
            const listBody = await listRes.text();
            releaseReport.list_body = listBody?.slice(0, 300) || null;
            const rawFiles = parseListBody(listBody);
            const fresh = rawFiles
              .filter((f) => {
                if (!isCsv(f)) return false;
                const dc = new Date(f?.date_created || f?.date || 0).getTime();
                return dc >= prePostTs - 5000;
              })
              .sort((a, b) => {
                const da = new Date(a?.date_created || a?.date || 0).getTime();
                const db_ = new Date(b?.date_created || b?.date || 0).getTime();
                return db_ - da;
              });
            const latest = fresh[0];
            if (latest) {
              releaseReport.file_name =
                latest.file_name || latest.fileName || latest.name || null;
              releaseReport.file_date_created =
                latest.date_created || latest.date || null;
              releaseReport.created_from = 'manual_fresh';
              console.log(
                '[mp-sync] release_report found:',
                releaseReport.file_name
              );
            } else {
              console.warn(
                '[mp-sync] CSV no encontrado después de 90s',
                cred.local_id
              );
            }
          } catch (e) {
            releaseReport.error =
              (releaseReport.error ? releaseReport.error + ' | ' : '') +
              'LIST: ' + String(e?.message || e);
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

                      // Redondeo a 2 decimales para evitar errores de
                      // punto flotante; los montos del CSV vienen como
                      // "1234.56" y queremos conservarlos tal cual.
                      const round2 = (v) => Math.round(v * 100) / 100;
                      let monto = 0;
                      let rowTipo = null;
                      let descripcionDefault = '';
                      if (netDebit > 0) {
                        monto = round2(-netDebit);
                        rowTipo = 'bank_transfer';
                        descripcionDefault = 'Transferencia enviada';
                      } else {
                        monto = round2(netCredit);
                        rowTipo = 'liquidacion';
                        descripcionDefault = 'Liquidación MP';
                      }

                      // Parse del CSV: si no hay marcador TZ, interpretar como Argentina
                      // (el release_report está configurado con display_timezone=GMT-03).
                      // Convertimos a UTC ISO para guardar. Los helpers del cliente lo
                      // formatean de vuelta a AR al mostrarlo.
                      let fechaIso;
                      if (rawDate) {
                        let s = String(rawDate).trim();
                        if (s.includes(' ') && !s.includes('T')) s = s.replace(' ', 'T');
                        if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
                          if (!s.includes('T')) s = s + 'T00:00:00';
                          s = s + '-03:00';
                        }
                        const parsed = new Date(s);
                        fechaIso = !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
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

                  // Post-release dedup: si en este mismo sync la payments API
                  // insertó filas que ahora tienen contraparte rr-*, las borramos
                  // inmediatamente para no devolver duplicados al frontend.
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
                          if (
                            m.id &&
                            !String(m.id).startsWith('rr-') &&
                            m.referencia_id &&
                            postRrRefs.has(String(m.referencia_id))
                          ) {
                            postDupeIds.push(m.id);
                          }
                        }
                        if (postDupeIds.length) {
                          await db
                            .from('mp_movimientos')
                            .delete()
                            .in('id', postDupeIds);
                          console.log(
                            '[mp-sync] post-release dedup deleted:',
                            postDupeIds.length,
                            postDupeIds
                          );
                        }
                      }
                    } catch (e) {
                      console.error('mp-sync: post-release dedup error', e);
                    }
                  }

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

        // ── CÁLCULO DEL SALDO (post release report + dedup) ──
        // Solo filas rr-* approved con fecha >= corte. Nada más.
        // Solo filas rr-* approved con fecha >= corte.
        const { data: movLocal, error: movErr } = await db
          .from('mp_movimientos')
          .select('id, tipo, monto, estado, fecha')
          .eq('local_id', cred.local_id)
          .like('id', 'rr-%')
          .eq('estado', 'approved');
        if (movErr) {
          console.error(
            'mp-sync: sum mp_movimientos error',
            cred.local_id,
            movErr
          );
        } else if (corte) {
          for (const m of movLocal || []) {
            movTotalCount++;
            const monto = Number(m.monto) || 0;
            const cumpleCorte = m.fecha && new Date(m.fecha) >= corte;
            if (cumpleCorte) {
              saldoAprobado += monto;
              movDespuesCount++;
              if (saldoTrace.counted_rows.length < 50) {
                saldoTrace.counted_rows.push({
                  id: m.id,
                  tipo: m.tipo,
                  fecha: m.fecha,
                  monto,
                });
              }
            }
          }
        }

        // por_acreditar: movimientos pendientes (cualquier fuente)
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
        const balanceFuente = corte ? 'saldo_inicial+rr_only' : 'sin_corte';

        console.log(
          '[mp-sync] saldo local_id=' + cred.local_id,
          'inicial=' + saldoInicialNum,
          'aprobado=' + saldoAprobado,
          'disponible=' + credSaldoDisponible,
          'filas_rr=' + movDespuesCount
        );

        balanceTotalMP += credSaldoDisponible;
        balanceConsultado = true;

        console.log(
          '[mp-sync] balance debug local_id=' + cred.local_id,
          {
            saldo_inicial_raw: saldoInicialRaw,
            saldo_inicial_num: saldoInicialNum,
            saldo_inicial_at: saldoInicialAt,
            mov_total_rr: movTotalCount,
            mov_en_saldo: movDespuesCount,
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
          skipped_duplicados: cantSkipped,
          comisiones: cantFees,
          reembolsos: cantRefunds,
          saldo_debug: {
            saldo_inicial_num: saldoInicialNum,
            corte_iso: saldoTrace.corte_iso,
            mov_total: movTotalCount,
            mov_en_saldo: movDespuesCount,
            saldo_aprobado: saldoAprobado,
            saldo_disponible: credSaldoDisponible,
            por_acreditar: porAcreditar,
            counted_rows: saldoTrace.counted_rows,
          },
          release_report: releaseReport,
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
      cleanup_dedup_deleted: cleanupDedupDeleted,
    });
  } catch (err) {
    console.error('mp-sync: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
