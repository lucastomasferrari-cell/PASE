// mp-debug-settlement: endpoint TEMPORAL de diagnóstico (Fase 1 de TASK 0.11).
//
// Dispara un settlement_report contra MP, espera hasta 120s a que MP
// genere el CSV, lo descarga, lo parsea y devuelve un resumen JSON al
// caller SIN tocar mp_movimientos. Sirve para confirmar que las
// liquidaciones del día actual aparecen como TRANSACTION_TYPE=SETTLEMENT
// con TRANSACTION_DATE de hoy en near-realtime.
//
// SECURITY: admin-only. Lee el JWT del header Authorization, lo valida
// con auth.getUser() (verificación de firma vía Supabase), y chequea
// que el rol del user en public.usuarios sea 'dueno' o 'admin'.
//
// Cómo dispararlo desde el browser logueado:
//   const { data: { session } } = await db.auth.getSession();
//   const r = await fetch('/api/mp-debug-settlement', {
//     headers: { Authorization: 'Bearer ' + session.access_token }
//   });
//   console.log(await r.json());
//
// Cómo dispararlo desde curl:
//   curl -H "Authorization: Bearer <JWT_DEL_DUENO>" \
//     https://pase-yndx.vercel.app/api/mp-debug-settlement
//
// Endpoint TEMPORAL: se borra en task de cleanup post Fase 6 si la
// migración avanza, o si se decide pivotar a webhooks.

import { createMpTokenGetter } from './_mp-token.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parseListBody = (body) => {
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch {}
  return Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
};

const isCsv = (f) =>
  (f?.file_name || f?.fileName || f?.name || '').toLowerCase().endsWith('.csv');

const parseCsvLines = (csvText) => {
  if (!csvText) return { header: [], rows: [], sep: ',' };
  const cleanCsv = csvText.replace(/^﻿/, '');
  const lines = cleanCsv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { header: [], rows: [], sep: ',' };
  const sep = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(sep).map((h) => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(sep).map((c) => c.replace(/^"|"$/g, '').trim());
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = cells[j] != null ? cells[j] : '';
    }
    rows.push(obj);
  }
  return { header, rows, sep };
};

// Devuelve "YYYY-MM-DD" en zona Argentina (UTC-3, sin DST).
const todayAr = () => {
  const now = new Date();
  const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const y = ar.getUTCFullYear();
  const m = String(ar.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ar.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const isoDate = (s) => {
  if (!s) return null;
  const str = String(s).trim();
  // El CSV puede traer "YYYY-MM-DD HH:MM:SS" sin TZ (asumimos AR -03)
  // o ISO con marcador de TZ. Devolvemos solo la parte YYYY-MM-DD.
  const m = str.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing SUPABASE env vars' });
    }

    // ── 1. Auth admin-only ────────────────────────────────────────────
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return res.status(401).json({ ok: false, error: 'missing_authorization_header' });

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: userData, error: authErr } = await db.auth.getUser(jwt);
    if (authErr || !userData?.user?.id) {
      return res.status(401).json({ ok: false, error: 'invalid_jwt', detail: authErr?.message });
    }
    const authId = userData.user.id;

    const { data: perfil, error: perfilErr } = await db
      .from('usuarios')
      .select('id, email, rol, activo')
      .eq('auth_id', authId)
      .maybeSingle();
    if (perfilErr) return res.status(500).json({ ok: false, error: 'profile_lookup_failed', detail: perfilErr.message });
    if (!perfil) return res.status(403).json({ ok: false, error: 'no_profile_found_for_jwt' });
    if (!perfil.activo) return res.status(403).json({ ok: false, error: 'usuario_inactivo' });
    if (!['dueno', 'admin'].includes(perfil.rol)) {
      return res.status(403).json({ ok: false, error: 'admin_only', rol_actual: perfil.rol });
    }

    // ── 2. Cargar credenciales activas ────────────────────────────────
    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('id, local_id, locales(nombre)')
      .eq('activo', true);

    if (credsError) return res.status(500).json({ ok: false, error: credsError.message });
    if (!creds || creds.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sin credenciales configuradas', credentials: [] });
    }

    const getMpToken = createMpTokenGetter(db);
    const startedAt = new Date().toISOString();
    const todayStr = todayAr();

    // ── 3. Para cada credencial: PUT config → POST → poll list → GET file → parse ──
    const credentials = [];
    for (const cred of creds) {
      const credResult = {
        local_id: cred.local_id,
        local_name: cred.locales?.nombre || null,
        settlement_id: null,
        post_status: null,
        list_attempts: 0,
        generated_at: null,
        processed_at: null,
        total_rows: 0,
        distinct_transaction_types: [],
        rows_today: 0,
        sample_rows: [],
        sample_rows_today: [],
        header_columns: [],
        error: null,
      };

      try {
        const token = await getMpToken(cred.id);

        // Rango: ayer 00:00 UTC → ahora UTC. Cubre el día actual en AR
        // (UTC-3) sin traer demasiada historia.
        const pad = (n) => String(n).padStart(2, '0');
        const now = new Date();
        const ayer = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const beginIso = `${ayer.getUTCFullYear()}-${pad(ayer.getUTCMonth() + 1)}-${pad(ayer.getUTCDate())}T00:00:00Z`;
        const endIso = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}Z`;

        // 3a) PUT /config — idempotente, asegura schedule del settlement_report.
        try {
          await fetch('https://api.mercadopago.com/v1/account/settlement_report/config', {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              scheduled: true,
              execute_after_withdrawal: false,
              display_timezone: 'GMT-03',
              frequency: { hour: 23, type: 'daily' },
            }),
          });
        } catch {} // best-effort; si falla seguimos con el POST manual

        // 3b) POST /v1/account/settlement_report con begin/end_date.
        const prePostTs = Date.now();
        const postRes = await fetch('https://api.mercadopago.com/v1/account/settlement_report', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ begin_date: beginIso, end_date: endIso }),
        });
        credResult.post_status = postRes.status;
        if (!postRes.ok && postRes.status !== 202) {
          const errBody = (await postRes.text()).slice(0, 300);
          credResult.error = `post_failed: ${postRes.status} ${errBody}`;
          credentials.push(credResult);
          continue;
        }

        // 3c) Poll /list cada 10s (máx 12 intentos = 120s) buscando un
        //     CSV con date_created >= prePostTs - 5s.
        let target = null;
        for (let attempt = 1; attempt <= 12; attempt++) {
          await sleep(10000);
          credResult.list_attempts = attempt;
          try {
            const listRes = await fetch('https://api.mercadopago.com/v1/account/settlement_report/list', {
              headers: { Authorization: `Bearer ${token}` },
            });
            const listBody = await listRes.text();
            const rawFiles = parseListBody(listBody);
            const fresh = rawFiles
              .filter((f) => isCsv(f))
              .filter((f) => new Date(f?.date_created || f?.date || 0).getTime() >= prePostTs - 5000)
              .sort((a, b) => new Date(b?.date_created || b?.date || 0) - new Date(a?.date_created || a?.date || 0));
            if (fresh.length) {
              target = fresh[0];
              break;
            }
          } catch (e) {
            // sigue intentando
          }
        }

        if (!target) {
          credResult.error = `csv_timeout_120s: MP no generó el reporte en el tiempo esperado`;
          credentials.push(credResult);
          continue;
        }

        credResult.settlement_id = target.file_name || target.fileName || target.name || null;
        credResult.generated_at = target.date_created || target.date || null;

        // 3d) GET /<file_name> — descargar CSV.
        const fileRes = await fetch(
          `https://api.mercadopago.com/v1/account/settlement_report/${encodeURIComponent(credResult.settlement_id)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!fileRes.ok) {
          credResult.error = `file_get_failed: ${fileRes.status}`;
          credentials.push(credResult);
          continue;
        }
        const csvText = await fileRes.text();

        // 3e) Parsear CSV.
        const { header, rows } = parseCsvLines(csvText);
        credResult.header_columns = header;
        credResult.total_rows = rows.length;
        credResult.processed_at = new Date().toISOString();

        // distinct TRANSACTION_TYPEs con count.
        const typeCounts = new Map();
        for (const r of rows) {
          const t = r.TRANSACTION_TYPE || r.transaction_type || '';
          typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
        }
        credResult.distinct_transaction_types = Array.from(typeCounts.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count);

        // rows_today: filas con TRANSACTION_DATE de hoy AR.
        const todayRows = rows.filter((r) => {
          const td = isoDate(r.TRANSACTION_DATE || r.transaction_date);
          return td === todayStr;
        });
        credResult.rows_today = todayRows.length;

        // Sample 20 filas (mezcla 10 de hoy + 10 de cualquier día) para inspección.
        const samplerCols = (r) => ({
          TRANSACTION_DATE: r.TRANSACTION_DATE || r.transaction_date || null,
          TRANSACTION_TYPE: r.TRANSACTION_TYPE || r.transaction_type || null,
          TRANSACTION_AMOUNT: r.TRANSACTION_AMOUNT || r.transaction_amount || null,
          SETTLEMENT_DATE: r.SETTLEMENT_DATE || r.settlement_date || null,
          SETTLEMENT_NET_AMOUNT: r.SETTLEMENT_NET_AMOUNT || r.settlement_net_amount || null,
          SOURCE_ID: r.SOURCE_ID || r.source_id || null,
          EXTERNAL_REFERENCE: r.EXTERNAL_REFERENCE || r.external_reference || null,
          PAYMENT_METHOD: r.PAYMENT_METHOD || r.payment_method || null,
        });
        credResult.sample_rows_today = todayRows.slice(0, 10).map(samplerCols);
        credResult.sample_rows = rows.slice(0, 20).map(samplerCols);
      } catch (e) {
        credResult.error = `exception: ${e?.message || String(e)}`;
      }

      credentials.push(credResult);
    }

    return res.status(200).json({
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      today_ar: todayStr,
      caller: { auth_id: authId, email: perfil.email, rol: perfil.rol },
      credentials,
    });
  } catch (err) {
    console.error('mp-debug-settlement: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
