// Endpoint para crear usuarios y cambiar contraseñas via Supabase Auth admin API.
// Solo accesible desde el frontend cuando el usuario tiene rol=dueno/admin/superadmin.
//
// SEGURIDAD (fix auditoría 2026-05-21 CRIT-1):
//   - Requiere JWT del caller en Authorization header.
//   - Solo dueno/admin/superadmin pueden invocar.
//   - change_password: el target authId debe pertenecer al mismo tenant que el
//     caller (excepto superadmin que puede cruzar tenants).
//   - create: rol pedido NO puede ser >= al del caller. Tenant_id forzado al
//     del caller si NO es superadmin (no podés crear usuarios en otro tenant).
//
// Multi-tenant:
// - El payload puede incluir `tenant_id` explícito (solo respetado si caller
//   es superadmin).
// - Si no viene tenant_id y el caller no es superadmin, se usa el tenant del caller.
// - Mantiene fallback a Neko solo para superadmin sin tenant_id pasado.
import { checkUserAuth } from './_user-auth.js';

// Jerarquía de roles (más alto = más poder). Si un rol no está acá, se ignora.
const ROLE_RANK = {
  superadmin: 100,
  dueno: 50,
  admin: 40,
  encargado: 20,
  cajero: 10,
};

async function resolveTenantId(db, payloadTenantId, callerRow) {
  // Solo superadmin puede pasar tenant_id explícito y respetarse.
  if (callerRow.rol === 'superadmin') {
    if (payloadTenantId) return payloadTenantId;
    const { data } = await db.from('tenants').select('id').eq('slug', 'neko').single();
    return data?.id || null;
  }
  // No-superadmin: forzar al tenant del caller (defensa contra cross-tenant create).
  return callerRow.tenant_id;
}

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    // Leer action ANTES de checkUserAuth — algunas actions tienen reglas de
    // auth distintas (ej. change_password_self acepta users con
    // password_temporal=true, que es justamente el caso que usa el flujo).
    const { action, nombre, usuario, password, rol, locales: userLocales, authId, tenant_id: payloadTenantId,
      apps_permitidas: appsPermitidas, cuentas_visibles: cuentasVisibles, rol_id: rolId, usuario_id: targetUsuarioId,
      newPassword } = req.body || {};

    // Actions abiertas a cualquier user autenticado (target = caller).
    const SELF_SERVICE_ACTIONS = new Set(['change_password_self']);

    // ─── AUTH del caller (CRIT-1 fix) ────────────────────────────────────
    const auth = await checkUserAuth(req, res, {
      // change_password_self es el flujo que usa el user con password_temporal
      // para destrabarse — bloquearlo por password_temporal sería lockear al
      // user para siempre.
      allowPasswordTemporal: SELF_SERVICE_ACTIONS.has(action),
    });
    if (!auth) return; // checkUserAuth ya respondió 401/403/500

    // Solo roles administrativos pueden invocar el resto del endpoint.
    if (!SELF_SERVICE_ACTIONS.has(action) && !['superadmin', 'dueno', 'admin'].includes(auth.row.rol)) {
      return res.status(403).json({ ok: false, error: 'forbidden_role' });
    }
    const callerRank = ROLE_RANK[auth.row.rol] || 0;
    // ─────────────────────────────────────────────────────────────────────

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (action === 'create') {
      if (!nombre || !usuario || !password) {
        return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
      }

      const requestedRol = rol || 'encargado';
      const requestedRank = ROLE_RANK[requestedRol] || 0;

      // No podés crear un usuario con rol >= al tuyo.
      // (superadmin=100 sí puede crear superadmin=100 — caso edge para Lucas;
      // dueno=50 NO puede crear dueno=50; admin=40 NO puede crear dueno=50.)
      if (auth.row.rol !== 'superadmin' && requestedRank >= callerRank) {
        return res.status(403).json({ ok: false, error: 'cannot_create_role_higher_or_equal' });
      }

      // 1. Resolver tenant_id ANTES de crear el auth user (lo necesitamos
      // para setearlo en app_metadata del JWT — fix 29-may para que las RPCs
      // que usan `auth.jwt() ->> 'tenant_id'` o `auth_tenant_id()` lo vean).
      // tenant_id forzado al del caller si NO es superadmin (defensa cross-tenant).
      const tenantId = await resolveTenantId(db, payloadTenantId, auth.row);

      // 2. Intentar crear en Supabase Auth (no bloquea si falla)
      let newAuthId = null;
      try {
        const authEmail = usuario.includes('@') ? usuario : usuario + '@pase.local';
        const { data: authUser, error: authErr } = await db.auth.admin.createUser({
          email: authEmail,
          password,
          email_confirm: true,
          user_metadata: { nombre, rol: requestedRol },
          // app_metadata sí se incluye en el JWT del user — defense-in-depth
          // para futuras políticas RLS que usen `auth.jwt() ->> 'tenant_id'`.
          app_metadata: tenantId ? { tenant_id: tenantId, rol: requestedRol } : undefined,
        });
        if (authErr) {
          console.warn('[auth-admin] Supabase Auth falló (continuando sin auth):', authErr.message);
        } else {
          newAuthId = authUser.user.id;
        }
      } catch (authCatchErr) {
        console.warn('[auth-admin] Supabase Auth exception (continuando sin auth):', authCatchErr.message);
      }

      // 3. Hash SHA-256 de la contraseña
      const { createHash } = await import('crypto');
      const hashPassword = createHash('sha256').update(password).digest('hex');

      // 4. INSERT en tabla usuarios.
      const userRow = {
        nombre,
        email: usuario,
        password: hashPassword,
        rol: requestedRol,
        activo: true,
        locales: userLocales || [],
        auth_id: newAuthId,
      };
      // Solo poner tenant_id si NO es superadmin (CHECK usuarios_tenant_check).
      if (requestedRol !== 'superadmin') {
        userRow.tenant_id = tenantId;
      }
      // Campos opcionales (Accesos los manda; PASE Usuarios.tsx legacy no).
      if (Array.isArray(appsPermitidas)) userRow.apps_permitidas = appsPermitidas;
      if (Array.isArray(cuentasVisibles) || cuentasVisibles === null) userRow.cuentas_visibles = cuentasVisibles;
      if (rolId !== undefined) userRow.rol_id = rolId;

      const { data: inserted, error: insertErr } = await db.from('usuarios').insert([userRow]).select('id').single();

      if (insertErr) {
        return res.status(500).json({ ok: false, error: insertErr.message });
      }

      return res.status(200).json({ ok: true, auth_id: newAuthId, id: inserted?.id ?? null });

    } else if (action === 'change_password') {
      // Cambiar contraseña en Supabase Auth
      if (!authId || !password) {
        console.error('[auth-admin] change_password: faltan campos', { authId: !!authId, password: !!password });
        return res.status(400).json({ ok: false, error: 'Faltan authId o password' });
      }

      // ─── Validar que el target pertenece al mismo tenant que el caller ───
      // (superadmin puede cruzar tenants; resto no).
      if (auth.row.rol !== 'superadmin') {
        const { data: targetRow } = await db.from('usuarios')
          .select('id, rol, tenant_id')
          .eq('auth_id', authId)
          .maybeSingle();
        if (!targetRow) {
          return res.status(404).json({ ok: false, error: 'target_user_not_found' });
        }
        if (targetRow.tenant_id !== auth.row.tenant_id) {
          return res.status(403).json({ ok: false, error: 'cross_tenant_password_change_denied' });
        }
        // No podés cambiar la contraseña de alguien con rol >= al tuyo.
        const targetRank = ROLE_RANK[targetRow.rol] || 0;
        if (targetRank >= callerRank) {
          return res.status(403).json({ ok: false, error: 'cannot_change_password_of_higher_role' });
        }
      }

      console.log('[auth-admin] change_password para authId:', authId, '(por caller:', auth.row.id, auth.row.rol + ')');
      const { error: updErr } = await db.auth.admin.updateUserById(authId, {
        password,
      });

      if (updErr) {
        console.error('[auth-admin] change_password falló:', updErr.message);
        return res.status(500).json({ ok: false, error: updErr.message });
      }

      console.log('[auth-admin] change_password OK para authId:', authId);
      return res.status(200).json({ ok: true });

    } else if (action === 'create_comanda') {
      // ─── Sprint COMANDA Autónomo (24-may) ──────────────────────────────
      // Crea un comanda_usuario + sus permisos. Si el email ya existe en
      // auth.users (porque el user tiene cuenta PASE), REUSA el auth_id en
      // lugar de crear uno nuevo. Esto es lo que permite que el mismo email/
      // password loguee en ambos sistemas con perfiles separados.
      const { email, rol_pos, locales: comandaLocales, pin_pos, permisos } = req.body || {};
      if (!nombre || !email || !rol_pos) {
        return res.status(400).json({ ok: false, error: 'Faltan nombre/email/rol_pos' });
      }
      if (!['mozo','cajero','manager','admin'].includes(rol_pos)) {
        return res.status(400).json({ ok: false, error: 'rol_pos_invalido' });
      }

      const tenantId = await resolveTenantId(db, payloadTenantId, auth.row);

      // 1. Buscar auth_id existente — primero en usuarios PASE, después en
      //    comanda_usuarios de otros tenants (caso edge).
      const emailNorm = email.includes('@') ? email : email + '@pase.local';
      let authIdToUse = null;
      const { data: pasaUser } = await db.from('usuarios')
        .select('auth_id').eq('email', email).maybeSingle();
      authIdToUse = pasaUser?.auth_id || null;

      // Si no encontró, ver en otro tenant
      if (!authIdToUse) {
        const { data: comOtro } = await db.from('comanda_usuarios')
          .select('auth_id').eq('email', email).maybeSingle();
        authIdToUse = comOtro?.auth_id || null;
      }

      // 2. Si no existe, crear auth.user
      if (!authIdToUse) {
        if (!password) {
          return res.status(400).json({ ok: false, error: 'password_requerido_para_user_nuevo' });
        }
        const { data: newAuth, error: authErr } = await db.auth.admin.createUser({
          email: emailNorm,
          password,
          email_confirm: true,
          user_metadata: { nombre, rol_pos },
          // app_metadata.tenant_id (fix 29-may) — defense-in-depth para que
          // `auth.jwt() ->> 'tenant_id'` lo vea desde el JWT. auth_tenant_id()
          // ya tiene fallback a comanda_usuarios pero esto es más estándar.
          app_metadata: { tenant_id: tenantId, rol_pos },
        });
        if (authErr) {
          return res.status(500).json({ ok: false, error: 'auth_create_failed: ' + authErr.message });
        }
        authIdToUse = newAuth.user.id;
      } else {
        // 2b. Si auth_id ya existía (user reusado de PASE u otro comanda_usuarios)
        // y NO tiene tenant_id en app_metadata, agregarlo. Idempotente: si
        // ya está, no pisa. Necesario para users viejos creados antes del
        // fix de 29-may.
        try {
          const { data: existing } = await db.auth.admin.getUserById(authIdToUse);
          const currentMeta = existing?.user?.app_metadata ?? {};
          if (!currentMeta.tenant_id) {
            await db.auth.admin.updateUserById(authIdToUse, {
              app_metadata: { ...currentMeta, tenant_id: tenantId, rol_pos },
            });
          }
        } catch (metaErr) {
          console.warn('[auth-admin] update app_metadata falló (no crítico):', metaErr.message);
        }
      }

      // 3. Insert comanda_usuario
      const { data: cuRow, error: cuErr } = await db.from('comanda_usuarios').insert({
        auth_id: authIdToUse,
        tenant_id: tenantId,
        nombre,
        email,
        rol_pos,
        locales: comandaLocales || null,
        pin_pos: pin_pos || null,
        activo: true,
      }).select('id').single();
      if (cuErr) {
        return res.status(500).json({ ok: false, error: cuErr.message });
      }

      // 4. Insert permisos (si los hay). Admin POS bypassa todo, no necesita.
      if (Array.isArray(permisos) && permisos.length > 0 && rol_pos !== 'admin') {
        const permisosRows = permisos.map(slug => ({
          comanda_usuario_id: cuRow.id,
          tenant_id: tenantId,
          modulo_slug: slug,
        }));
        const { error: permErr } = await db.from('comanda_usuario_permisos').insert(permisosRows);
        if (permErr) {
          return res.status(500).json({ ok: false, error: 'permisos_insert_failed: ' + permErr.message });
        }
      }

      return res.status(200).json({ ok: true, id: cuRow.id, auth_id: authIdToUse });

    } else if (action === 'reset_password') {
      // Reset por id numérico de `usuarios` (no auth_id) — flow usado por
      // Accesos: el dueño tilda un empleado y pide reset. Genera password
      // temporal de 8 chars, lo aplica en Supabase Auth y marca
      // `password_temporal=true` para forzar cambio en próximo login.
      if (!targetUsuarioId) {
        return res.status(400).json({ ok: false, error: 'Falta usuario_id' });
      }
      const { data: target, error: targetErr } = await db.from('usuarios')
        .select('id, rol, tenant_id, auth_id')
        .eq('id', targetUsuarioId)
        .maybeSingle();
      if (targetErr || !target) {
        return res.status(404).json({ ok: false, error: 'target_user_not_found' });
      }
      // Mismo tenant (excepto superadmin) y no podés resetear a alguien con rol >= al tuyo.
      if (auth.row.rol !== 'superadmin') {
        if (target.tenant_id !== auth.row.tenant_id) {
          return res.status(403).json({ ok: false, error: 'cross_tenant_reset_denied' });
        }
        const targetRank = ROLE_RANK[target.rol] || 0;
        if (targetRank >= callerRank) {
          return res.status(403).json({ ok: false, error: 'cannot_reset_password_of_higher_role' });
        }
      }
      if (!target.auth_id) {
        return res.status(400).json({ ok: false, error: 'user_sin_supabase_auth' });
      }

      // Password temporal: 8 chars [a-z0-9] generados con crypto.
      const { randomBytes } = await import('crypto');
      const tempPassword = randomBytes(6).toString('base64')
        .replace(/[+/=]/g, '').slice(0, 8).toLowerCase() || 'temp1234';

      const { error: updErr } = await db.auth.admin.updateUserById(target.auth_id, { password: tempPassword });
      if (updErr) {
        return res.status(500).json({ ok: false, error: 'auth_update_failed: ' + updErr.message });
      }

      // Marcar password_temporal=true para forzar cambio. NO tocamos la columna
      // legacy `usuarios.password` (placeholder __supabase_auth_only__ post-F2D).
      await db.from('usuarios').update({ password_temporal: true }).eq('id', target.id);

      return res.status(200).json({ ok: true, temp_password: tempPassword });

    } else if (action === 'credencial-list') {
      // Lista las integraciones del tenant del caller. NUNCA devuelve secretos
      // en plaintext — solo nombres de campos y si están seteados.
      const { data: rows } = await db.from('integraciones')
        .select('id, provider, estado, conectado_at, ultima_verificacion_at, ultimo_error, notas, updated_at, config')
        .eq('tenant_id', auth.row.tenant_id);
      const out = (rows ?? []).map((r) => ({
        ...r,
        // Redactar secretos: dejar solo las KEYS y un preview (..últimos 4)
        config_keys: r.config ? Object.keys(r.config) : [],
        config: undefined,
        config_preview: r.config ? Object.fromEntries(
          Object.entries(r.config).map(([k, v]) => [k,
            typeof v === 'string' && v.length > 8 ? '...' + v.slice(-4) : v
          ])
        ) : null,
      }));
      return res.status(200).json({ ok: true, integraciones: out });

    } else if (action === 'credencial-set') {
      // Upsert una integración. config = objeto con credenciales en plain
      // (RLS protege la tabla — solo service_role lee). Marca estado=desconectado
      // al setear; la verificación efectiva la hace credencial-test.
      const { provider, config, notas } = req.body || {};
      const VALID_PROVIDERS = new Set([
        'whatsapp_api','email','meta_ads','google_ads','search_console',
        'instagram','google_maps','stripe','mp_point',
      ]);
      if (!provider || !VALID_PROVIDERS.has(provider)) {
        return res.status(400).json({ ok: false, error: 'provider_invalido' });
      }
      if (!config || typeof config !== 'object') {
        return res.status(400).json({ ok: false, error: 'config_invalido' });
      }
      const { data: existing } = await db.from('integraciones')
        .select('id').eq('tenant_id', auth.row.tenant_id).eq('provider', provider).maybeSingle();
      if (existing) {
        const { error } = await db.from('integraciones').update({
          config, notas: notas ?? null, estado: 'desconectado',
          ultimo_error: null, updated_at: new Date().toISOString(),
          updated_by: auth.row.id,
        }).eq('id', existing.id);
        if (error) return res.status(500).json({ ok: false, error: error.message });
      } else {
        const { error } = await db.from('integraciones').insert({
          tenant_id: auth.row.tenant_id, provider, config,
          estado: 'desconectado', notas: notas ?? null, updated_by: auth.row.id,
        });
        if (error) return res.status(500).json({ ok: false, error: error.message });
      }
      return res.status(200).json({ ok: true });

    } else if (action === 'credencial-delete') {
      // Desconectar una integración (borra la fila).
      const { provider } = req.body || {};
      if (!provider) return res.status(400).json({ ok: false, error: 'falta_provider' });
      const { error } = await db.from('integraciones')
        .delete()
        .eq('tenant_id', auth.row.tenant_id)
        .eq('provider', provider);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });

    } else if (action === 'stripe-checkout') {
      // Inicia un checkout de Stripe para que el tenant pague la suscripción.
      // Requiere credencial stripe configurada en hub. Crea checkout session
      // y devuelve URL para redirect. Webhook actualiza tenant_subscriptions.
      const { plan_id, success_url, cancel_url } = req.body || {};
      if (!plan_id) return res.status(400).json({ ok: false, error: 'falta_plan_id' });
      const { getCredencial } = await import('./_integraciones.js');
      const stripeCred = await getCredencial(db, auth.row.tenant_id, 'stripe');
      if (!stripeCred?.config?.secret_key) {
        return res.status(400).json({ ok: false, error: 'stripe_no_configurado' });
      }
      // Levantar plan + precio (billing_plans tiene precio_mensual_ars)
      const { data: plan } = await db.from('billing_plans').select('*').eq('id', plan_id).single();
      if (!plan) return res.status(404).json({ ok: false, error: 'plan_no_encontrado' });

      // Levantar/crear customer en Stripe. Si el tenant ya tiene
      // stripe_customer_id usamos ese; si no, creamos uno nuevo.
      const { data: sub } = await db.from('tenant_subscriptions')
        .select('id, stripe_customer_id')
        .eq('tenant_id', auth.row.tenant_id).maybeSingle();
      let customerId = sub?.stripe_customer_id ?? null;

      const stripeAuth = { Authorization: `Bearer ${stripeCred.config.secret_key}` };
      if (!customerId) {
        const cr = await fetch('https://api.stripe.com/v1/customers', {
          method: 'POST', headers: { ...stripeAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ email: auth.row.email || '', name: auth.row.nombre || '' }),
        });
        const cd = await cr.json();
        if (!cr.ok) return res.status(502).json({ ok: false, error: cd?.error?.message || `stripe ${cr.status}` });
        customerId = cd.id;
        if (sub) {
          await db.from('tenant_subscriptions').update({ stripe_customer_id: customerId }).eq('id', sub.id);
        }
      }

      // Crear checkout session en modo subscription. price_data inline para
      // no requerir setup previo de prices en Stripe Dashboard.
      const monto = Number(plan.precio_mensual_ars);
      const form = new URLSearchParams();
      form.append('mode', 'subscription');
      form.append('customer', customerId);
      form.append('success_url', success_url || 'https://pase-admin-console.vercel.app/billing/success');
      form.append('cancel_url', cancel_url || 'https://pase-admin-console.vercel.app/tenants');
      form.append('line_items[0][quantity]', '1');
      form.append('line_items[0][price_data][currency]', 'ars');
      form.append('line_items[0][price_data][product_data][name]', plan.nombre);
      form.append('line_items[0][price_data][unit_amount]', String(Math.round(monto * 100)));
      form.append('line_items[0][price_data][recurring][interval]', 'month');
      form.append('metadata[tenant_id]', auth.row.tenant_id || '');
      form.append('metadata[plan_id]', plan_id);
      const sr = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST', headers: { ...stripeAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      const sd = await sr.json();
      if (!sr.ok) return res.status(502).json({ ok: false, error: sd?.error?.message || `stripe ${sr.status}` });

      // Guardar session id para reconciliación posterior
      await db.from('tenant_subscriptions').update({
        stripe_checkout_session_id: sd.id,
        gateway_provider: 'stripe',
      }).eq('tenant_id', auth.row.tenant_id);

      return res.status(200).json({ ok: true, url: sd.url, session_id: sd.id });

    } else if (action === 'stripe-webhook') {
      // MOVIDO a /api/stripe-webhook.js (fix audit 26-jun CRIT-1).
      // El handler anterior aceptaba el evento sin verificar firma Y permitía
      // a cualquier dueño/admin autenticado modificar tenant_subscriptions
      // ajeno pasando metadata.tenant_id arbitrario. Hardcore cross-tenant.
      // Ahora el endpoint dedicado valida HMAC SHA-256 del header Stripe-Signature.
      // Reconfigurar en Stripe Dashboard:
      //   URL antigua (rota): /api/auth-admin?action=stripe-webhook
      //   URL nueva (con firma): /api/stripe-webhook
      return res.status(410).json({
        ok: false,
        error: 'gone',
        detail: 'Esta acción se movió a /api/stripe-webhook con validación de firma. Actualizar la URL en Stripe Dashboard.',
      });

    } else if (action === 'change_password_self') {
      // Cambiar la PROPIA contraseña (no la de otro user). Diferente a
      // 'change_password' que es para admins reseteando a otros.
      //
      // Movido desde /api/auth-change-password (fix audit 26-jun: hacer
      // espacio para /api/stripe-webhook respetando límite de 12 functions).
      //
      // El JWT del caller ya fue validado por checkUserAuth. Usamos
      // auth.row.auth_id como target (NO authId del body — defense contra
      // que un user pase otro authId arbitrario).
      const np = typeof newPassword === 'string' ? newPassword
        : (typeof password === 'string' ? password : null);
      if (!np) {
        return res.status(400).json({ error: 'BAD_REQUEST' });
      }
      if (np.length < 8) {
        return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
      }
      // checkUserAuth devuelve auth.user (Supabase Auth) y auth.row (tabla
      // usuarios). El auth_id del target = caller es auth.user.id.
      const targetAuthId = auth.user?.id;
      if (!targetAuthId) {
        return res.status(400).json({ error: 'NO_AUTH_ID' });
      }

      const { error: updErr } = await db.auth.admin.updateUserById(targetAuthId, {
        password: np,
      });
      if (updErr) {
        const msg = (updErr.message || '').toLowerCase();
        if (updErr.code === 'same_password' || msg.includes('different from the old')) {
          return res.status(422).json({ error: 'SAME_PASSWORD' });
        }
        if (updErr.code === 'weak_password' || msg.includes('weak password')) {
          return res.status(422).json({ error: 'WEAK_PASSWORD', detail: updErr.message });
        }
        console.error('[auth-admin] change_password_self updateUserById error:', updErr);
        return res.status(500).json({ error: 'UPDATE_FAILED', detail: updErr.message });
      }

      const { error: dbErr } = await db.from('usuarios')
        .update({ password_temporal: false })
        .eq('auth_id', targetAuthId);
      if (dbErr) {
        // El password YA cambió en auth.users. Sin rollback limpio.
        console.error('[auth-admin] change_password_self usuarios UPDATE error:', dbErr);
        return res.status(500).json({
          error: 'FLAG_UPDATE_FAILED',
          detail: dbErr.message,
          passwordChanged: true,
        });
      }

      return res.status(200).json({ ok: true });

    } else if (action === 'wa-send') {
      // Mandar un mensaje de WhatsApp desde la app (Habitué/MESA/COMANDA).
      // Usa la credencial del tenant del caller (no env vars).
      const { to, texto, template } = req.body || {};
      if (!to) return res.status(400).json({ ok: false, error: 'falta_to' });
      const { getCredencial, sendWhatsApp } = await import('./_integraciones.js');
      const wa = await getCredencial(db, auth.row.tenant_id, 'whatsapp_api');
      const result = await sendWhatsApp({ wa, to, texto, template });
      return res.status(200).json(result);

    } else if (action === 'email-send') {
      // Mandar un email transaccional desde la app.
      const { to, subject, html, text } = req.body || {};
      if (!to || !subject) return res.status(400).json({ ok: false, error: 'falta_to_o_subject' });
      const { getCredencial, sendEmailTransactional } = await import('./_integraciones.js');
      const email = await getCredencial(db, auth.row.tenant_id, 'email');
      const result = await sendEmailTransactional({ email, to, subject, html, text });
      return res.status(200).json(result);

    } else if (action === 'credencial-test') {
      // Verifica que la credencial funciona. Implementa pings específicos
      // por provider (HEAD/GET a sus APIs). Si funciona, marca conectado;
      // si no, error.
      const { provider } = req.body || {};
      if (!provider) return res.status(400).json({ ok: false, error: 'falta_provider' });
      const { data: integ } = await db.from('integraciones')
        .select('id, config')
        .eq('tenant_id', auth.row.tenant_id)
        .eq('provider', provider)
        .maybeSingle();
      if (!integ) return res.status(404).json({ ok: false, error: 'no_configurada' });
      const config = integ.config || {};
      let testOk = false;
      let testError = null;
      try {
        if (provider === 'whatsapp_api') {
          const phoneId = config.phone_number_id;
          const token = config.access_token;
          if (!phoneId || !token) throw new Error('Falta phone_number_id o access_token');
          const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) throw new Error(`Meta API ${r.status}`);
          testOk = true;
        } else if (provider === 'email') {
          const apiKey = config.api_key;
          if (!apiKey) throw new Error('Falta api_key');
          const r = await fetch('https://api.resend.com/domains', {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (!r.ok) throw new Error(`Resend ${r.status}`);
          testOk = true;
        } else if (provider === 'meta_ads') {
          const token = config.access_token;
          const adId = config.ad_account_id;
          if (!token || !adId) throw new Error('Falta access_token o ad_account_id');
          const r = await fetch(`https://graph.facebook.com/v21.0/${adId}?fields=id,name`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!r.ok) throw new Error(`Meta Ads ${r.status}`);
          testOk = true;
        } else if (provider === 'google_maps') {
          const apiKey = config.api_key;
          const placeId = config.place_id;
          if (!apiKey || !placeId) throw new Error('Falta api_key o place_id');
          const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name&key=${apiKey}`);
          const data = await r.json();
          if (data.status !== 'OK') throw new Error(`Places ${data.status}: ${data.error_message ?? ''}`);
          testOk = true;
        } else if (provider === 'stripe') {
          const sk = config.secret_key;
          if (!sk) throw new Error('Falta secret_key');
          const r = await fetch('https://api.stripe.com/v1/account', {
            headers: { Authorization: `Bearer ${sk}` },
          });
          if (!r.ok) throw new Error(`Stripe ${r.status}`);
          testOk = true;
        } else {
          testError = 'test_no_implementado_para_este_provider';
        }
      } catch (e) {
        testError = e.message;
      }

      await db.from('integraciones').update({
        estado: testOk ? 'conectado' : 'error',
        ultima_verificacion_at: new Date().toISOString(),
        ultimo_error: testError,
        conectado_at: testOk ? new Date().toISOString() : null,
      }).eq('id', integ.id);

      return res.status(200).json({ ok: testOk, error: testError });

    } else if (action === 'local_login_rotate') {
      // Genera / rota las credenciales del login del local (COMANDA/MESA).
      // Modelo PIN-first: la tablet se loguea 1 vez con este mail ficticio +
      // password aleatoria y queda eternamente logueada. Cada persona se
      // identifica con su PIN en el POS.
      //
      // Params: local_id
      // Auth: admin/dueño del tenant que es dueño del local.
      // Return: { email, password } — one-time (no se guarda en DB).
      const { local_id: localIdRaw } = req.body || {};
      const localId = Number(localIdRaw);
      if (!Number.isFinite(localId) || localId <= 0) {
        return res.status(400).json({ ok: false, error: 'Falta local_id' });
      }

      // Verificar que el local pertenece al tenant del caller (o caller es superadmin)
      const { data: local, error: localErr } = await db.from('locales')
        .select('id, nombre, tenant_id, login_email')
        .eq('id', localId)
        .maybeSingle();
      if (localErr || !local) {
        return res.status(404).json({ ok: false, error: 'local_not_found' });
      }
      if (auth.row.rol !== 'superadmin' && local.tenant_id !== auth.row.tenant_id) {
        return res.status(403).json({ ok: false, error: 'cross_tenant_denied' });
      }

      // Generar password aleatoria (12 chars fáciles de leer).
      const { randomBytes } = await import('crypto');
      const newPassword = randomBytes(9).toString('base64')
        .replace(/[+/=]/g, '')
        .slice(0, 12);

      let loginEmail = local.login_email;
      let authUserId;

      if (!loginEmail) {
        // Primer uso: autogenerar mail ficticio y crear auth user + comanda_usuarios.
        const slug = (local.nombre || 'local').toLowerCase()
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 24) || 'local';
        const hash = randomBytes(3).toString('hex');
        loginEmail = `${slug}_${hash}`;

        const emailAuth = `${loginEmail}@pase.local`;
        const { data: newAuth, error: authErr } = await db.auth.admin.createUser({
          email: emailAuth,
          password: newPassword,
          email_confirm: true,
          user_metadata: { username: loginEmail, kind: 'local_login', local_id: localId },
        });
        if (authErr) {
          return res.status(500).json({ ok: false, error: 'auth_create_failed: ' + authErr.message });
        }
        authUserId = newAuth.user.id;

        // Crear comanda_usuarios ligado al auth
        const { error: cuErr } = await db.from('comanda_usuarios').insert({
          auth_id: authUserId,
          tenant_id: local.tenant_id,
          nombre: `${local.nombre} POS`,
          email: loginEmail,
          rol_pos: 'admin',
          locales: [localId],
          activo: true,
        });
        if (cuErr) {
          return res.status(500).json({ ok: false, error: 'comanda_usuarios_create_failed: ' + cuErr.message });
        }
      } else {
        // Rotación: encontrar el auth user existente por email y updatear la password.
        const emailAuth = loginEmail.includes('@') ? loginEmail : `${loginEmail}@pase.local`;
        const { data: usersList, error: listErr } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (listErr) {
          return res.status(500).json({ ok: false, error: 'auth_list_failed: ' + listErr.message });
        }
        const found = usersList.users.find((u) => u.email === emailAuth);
        if (!found) {
          return res.status(500).json({ ok: false, error: 'auth_user_not_found_for_login_email' });
        }
        authUserId = found.id;
        const { error: updErr } = await db.auth.admin.updateUserById(authUserId, { password: newPassword });
        if (updErr) {
          return res.status(500).json({ ok: false, error: 'auth_update_failed: ' + updErr.message });
        }
      }

      // Actualizar tracking en locales
      await db.from('locales').update({
        login_email: loginEmail,
        login_password_rotated_at: new Date().toISOString(),
        login_password_rotated_by: auth.row.auth_id ?? null,
      }).eq('id', localId);

      return res.status(200).json({
        ok: true,
        email: loginEmail,
        password: newPassword,
        note: 'Anotá la contraseña ahora — no se puede recuperar. Después solo se puede rotar (crea una nueva).',
      });

    } else {
      return res.status(400).json({ ok: false, error: 'action requerida: create | change_password | change_password_self | reset_password | create_comanda | credencial-list | credencial-set | credencial-delete | credencial-test | wa-send | email-send | stripe-checkout | local_login_rotate' });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
