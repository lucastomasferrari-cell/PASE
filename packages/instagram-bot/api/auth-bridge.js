// ⚠️ DEPRECATED 24-may: Sprint COMANDA Autónomo Fase 3 eliminó el SSO bridge.
// COMANDA ahora tiene su propia tabla `comanda_usuarios` con perfiles
// independientes. El user se loguea directamente en COMANDA con su
// email/password (Supabase Auth compartido). El botón "Abrir COMANDA"
// de PASE ya no llama a este endpoint.
//
// Lo dejamos respondiendo 410 Gone para detectar cualquier cliente legacy
// que todavía intente usarlo. Si en X meses no hay tráfico, eliminar.
//
// (Histórico original abajo)
// ─────────────────────────────────────────────────────────────────────────
// Endpoint SSO bridge: PASE → COMANDA.
//
// Contexto: COMANDA se está separando a URL propia (decisión Lucas
// 21-may noche). Los 2 deploys (PASE en pase-yndx.vercel.app y COMANDA
// en comanda-yndx.vercel.app o donde sea) viven en dominios distintos.
// Supabase Auth no comparte cookie cross-domain → sin bridge, el staff
// tendría que loguearse 2 veces.
//
// Flow:
//   1. Usuario logueado en PASE clickea "Abrir COMANDA".
//   2. Frontend de PASE pega POST a este endpoint con su JWT en Authorization.
//   3. Validamos JWT, obtenemos la sesión completa del user (access + refresh).
//   4. Devolvemos los tokens. El frontend de PASE genera URL del tipo:
//        https://comanda-yndx.vercel.app/?at=<access_token>&rt=<refresh_token>
//      y abre en nueva tab.
//   5. COMANDA detecta los params al cargar (en main.tsx), llama
//      db.auth.setSession({ access_token, refresh_token }), limpia los
//      params del URL para que no queden en el history.
//
// Seguridad:
//   - Solo emitimos los tokens del MISMO user logueado (no cross-user).
//   - Los tokens viajan en query string → ojo con leak en referrer header.
//     Mitigación: en COMANDA limpiar inmediatamente con replaceState.
//   - Alternativa más segura sería emitir un "magic link token" de un solo
//     uso que se canjea contra session — pero requiere más infra. Para el
//     uso interno (staff Neko), query-string es suficiente.
//
// Por qué vive en el bot y no en PASE: PASE está al límite de 12 functions
// del plan Hobby de Vercel. El bot tiene cupo y ya hace auth (OAuth IG).

import { createClient } from '@supabase/supabase-js';
import { setCorsHeaders } from './_lib/cors.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Sprint COMANDA Autónomo Fase 3 (24-may): endpoint deprecated. COMANDA
  // ahora tiene su propio login → no necesita el bridge. Devolvemos 410 Gone
  // para que cualquier cliente legacy que aún llame se entere claro.
  return res.status(410).json({
    ok: false,
    error: 'AUTH_BRIDGE_DEPRECATED',
    message: 'El SSO bridge fue eliminado en Sprint COMANDA Autónomo (24-may). Loguearse directamente en COMANDA con el mismo email/password de PASE.',
  });

  // eslint-disable-next-line no-unreachable -- código histórico preservado por si rollback
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  // ─── Auth: extraer JWT del header ────────────────────────────────────
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'NO_TOKEN' });
  }
  const accessToken = authHeader.slice(7);

  // ─── Validar token con Supabase Auth ─────────────────────────────────
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await admin.auth.getUser(accessToken);
  if (userErr || !userData?.user) {
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }

  // Verificar que el user esté activo en tabla usuarios.
  const { data: row } = await admin
    .from('usuarios')
    .select('id, rol, activo, tenant_id')
    .eq('auth_id', userData.user.id)
    .maybeSingle();
  if (!row || row.activo === false) {
    return res.status(403).json({ ok: false, error: 'USER_INACTIVE' });
  }

  // ─── Obtener refresh_token desde el body (el front lo manda con el JWT) ─
  // El access_token solo lo conoce el front (vino en el header).
  // Para emitir una nueva sesión en COMANDA necesitamos el refresh también.
  // El front lo lee de localStorage (Supabase Auth lo guarda ahí) y lo
  // manda en el body de la request.
  const { refresh_token: refreshTokenIn } = req.body || {};
  if (!refreshTokenIn) {
    return res.status(400).json({ ok: false, error: 'MISSING_REFRESH_TOKEN' });
  }

  // ─── Validar el refresh_token "rotándolo" con Supabase Auth ──────────
  // Esto verifica que sea válido + nos da una sesión fresca para entregar.
  // No usamos el refresh viejo directamente — siempre damos uno nuevo.
  const userClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: refreshed, error: refreshErr } = await userClient.auth.refreshSession({
    refresh_token: refreshTokenIn,
  });
  if (refreshErr || !refreshed?.session) {
    return res.status(401).json({ ok: false, error: 'REFRESH_FAILED', detail: refreshErr?.message });
  }

  // ─── Devolver el par fresco al frontend ──────────────────────────────
  return res.status(200).json({
    ok: true,
    access_token: refreshed.session.access_token,
    refresh_token: refreshed.session.refresh_token,
    expires_in: refreshed.session.expires_in,
  });
}
