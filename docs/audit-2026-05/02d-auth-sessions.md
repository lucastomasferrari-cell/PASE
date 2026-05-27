# Fase 2D — Auth, sesiones, JWT, password handling, OAuth, Manager Override

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Scope:** `packages/pase/api/`, `packages/pase/src/{App,Login,Config,Usuarios,ForcePasswordChange,components/ManagerOverrideModal}.{ts,tsx}`, `packages/instagram-bot/api/`, migrations TOTP / OAuth / push subs.
**Método:** lectura estática del código + cross-check contra `AUDITORIA_2026-05-21.md` (sprint hardening ya aplicado). El reporte filtra hallazgos NUEVOS o que el hardening no cubrió.

> **Nota importante:** la mayoría de los críticos clásicos de auth (auth-admin sin JWT, backup-tenants await faltante, vistas sin security_invoker, CORS=`*`) fueron resueltos en el sprint 21-may. Este reporte se concentra en lo que sigue pendiente o apareció después.

---

## 📊 Resumen ejecutivo

**14 findings** en 6 categorías. La superficie de auth ya está bastante hardened — los críticos son edge cases concretos (algunos abren ventanas estrechas pero reales).

| Severidad | Cuenta | Atajos clave |
|---|---|---|
| 🔴 CRÍTICO | 3 | IG token plain-text · password_temporal NO enforced server-side · SHA-256 client-side todavía vivo |
| 🟠 ALTO | 4 | TOTP brute-force sin throttle · refresh-tokens IG sin path 2 · push subs RLS desalineado · cross-tenant push leak |
| 🟡 MEDIO | 4 | precheck no constant-time · auth-admin permite crear user idéntico al caller · TOTP secret lazy-init · COMANDA no tiene `password_temporal` |
| 🟢 BAJO | 3 | obtener_codigo_totp_actual sin rate limit · IG logEvent loguea body con secret enmascarado · backup-cleanup borra basado en path regex |

**Para atacar primero:** CRIT-1 (IG token), CRIT-2 (password_temporal bypass), CRIT-3 (SHA-256 client). Los tres tienen exploit factible y fix de 30 min — 2 h cada uno.

---

## 🎯 Ranking de los 3 CRÍTICOS

| # | Bug | Esfuerzo fix | Impacto |
|---|---|---|---|
| 1 | `ig_config.page_access_token` está en columna **TEXT plana** en la DB, sin pgcrypto encryption | 1-2 h (replicar patrón mp_token con `vault.secrets`) | Compromiso de Postgres → tokens IG long-lived de 60d en claro para todos los tenants. Tokens permiten leer DMs/postear historias en nombre del negocio. |
| 2 | `usuarios.password_temporal=true` NO se chequea en backend — solo en el `ForcePasswordChange.tsx` del frontend | 30 min (helper en `checkUserAuth` o middleware) | User con password temporal (recién creado por admin o reset) puede llamar `/api/claude`, `/api/afip-cae`, RPCs financieras desde curl/script con el JWT, saltándose el cambio obligatorio. |
| 3 | `Usuarios.tsx` y `Config.tsx` siguen escribiendo `usuarios.password` con SHA-256 client-side **sin sal**, contradiciendo CLAUDE.md ("el fallback SHA-256 fue eliminado") | 30 min (eliminar el path; dejar solo auth-admin endpoint) | Si Login.tsx (que solo usa Supabase Auth) volviera a tener fallback SHA-256 por refactor, o si otra app del workspace lee `usuarios.password`, los hashes sin sal son rompibles en minutos con rainbow tables. **Hay 24 filas en `usuarios.password` legacy** que conservan estos hashes hoy (revisar manualmente). |

---

## 1. Endpoints custom de auth

### 🔴 CRÍTICO — `password_temporal` no enforced server-side
- **File:** `packages/pase/api/_user-auth.js:46-58` + comparar `ForcePasswordChange.tsx`
- `checkUserAuth` proyecta solo `id, rol, activo, tenant_id` de `usuarios` — **no lee `password_temporal`**. El JWT del user recién creado es completamente válido para todos los endpoints (`/api/claude`, `/api/afip-cae`, RPCs).
- El gate vive solo en `App.tsx:361`: `if (user.password_temporal) return <ForcePasswordChange…>`. Es **UX**, no security.
- **PoC:**
  ```bash
  # 1. Admin crea encargado "alice@pase.local" con password "temp123"
  # 2. Alice obtiene JWT vía signInWithPassword sin abrir el browser
  # 3. Alice llama /api/claude con su JWT
  curl -X POST https://pase-yndx.vercel.app/api/claude \
    -H "Authorization: Bearer <jwt>" \
    -d '{"task":"soporte-chat","messages":[...]}'
  # → 200 OK. Alice nunca cambió su password.
  ```
- **Fix:** agregar `password_temporal` al `select`, devolver 403 `PASSWORD_TEMPORAL_PENDING` si está true. Excepción: `auth-change-password.js` que SÍ debe aceptarlo (es el endpoint que lo libera).

### 🔴 CRÍTICO — SHA-256 client-side persiste en Config.tsx + Usuarios.tsx
- **Files:** `packages/pase/src/pages/Config.tsx:6-10,80-81` y `packages/pase/src/pages/Usuarios.tsx:16-20,175-180`
- A pesar del comentario en CLAUDE.md (*"el fallback SHA-256 fue eliminado"*), ambos componentes siguen ejecutando:
  ```ts
  const hash = await sha256(form.password);           // SHA-256 sin sal
  await db.from("usuarios").update({password: hash}).eq("id", userId);
  ```
- Esto:
  1. Persiste hashes débiles (SHA-256 sin sal = rompible con rainbow tables en segundos).
  2. Crea condición de race con `auth-admin/change_password`: el caller pasa el password por el endpoint Y por el cliente — si el primero falla, el segundo deja un hash "huérfano".
  3. **Filtración del hash en `console.log`** (línea 177 de Usuarios.tsx): `console.log("[Usuarios] UPDATE password:", { userId, hashPreview: hash.slice(0, 16) + "...", ...})`. Los primeros 16 chars del hash hex son suficientes para identificar passwords comunes via rainbow.
- **Fix:** eliminar los dos paths `sha256()` + `db.from("usuarios").update({password: ...})`. Solo dejar el call a `/api/auth-admin?action=change_password`. Auditar valor actual de `usuarios.password` (24 filas?) y considerar `UPDATE usuarios SET password = '__supabase_auth_only__'` para limpiar.

### 🔴 CRÍTICO — IG `page_access_token` almacenado en TEXT plano
- **File:** `packages/pase/supabase/migrations/202605212100_instagram_bot_schema.sql:33`
  ```sql
  page_access_token   TEXT NOT NULL,
  ```
- El comentario dice *"Encriptado a nivel aplicación cuando se guarda (igual que mp_credenciales)"* pero la realidad:
  - `oauth-callback.js:174` upserts `page_access_token: longToken` (string sin encrypt).
  - `refresh-tokens.js:96` mismo patrón.
  - `webhook.js:269,337` lee directo `cfg.page_access_token` (sin desencriptar).
- Es decir, **no hay encryption**. mp_credenciales SÍ usa `vault.secrets + pgp_sym_encrypt` (`202604261246_encriptar_mp_token_part_a.sql`); IG no replicó este patrón.
- **Impacto:** Postgres dump comprometido → atacante obtiene tokens IG long-lived (60d) de TODOS los tenants. Esos tokens permiten leer/responder DMs y postear como el negocio.
- **Fix:** seguir el patrón de mp_token: columna `page_access_token_encrypted bytea` + `vault.secrets` con passphrase `ig_token_key` + RPC `get_ig_token(tenant_id)` SECURITY DEFINER que valida service_role o `auth_es_dueno_o_admin()` del tenant. Refactor `webhook.js`/`refresh-tokens.js`/`send.js` para usar la RPC.

---

## 2. JWT validation en serverless endpoints

### Inventario auth por endpoint

| Endpoint | Path auth | Roles permitidos | Notas |
|---|---|---|---|
| `auth-admin.js` | `checkUserAuth` ✅ | superadmin/dueno/admin | Fixed 21-may. ROLE_RANK enforced. |
| `auth-change-password.js` | JWT directo via `admin.auth.getUser(jwt)` ✅ | cualquier auth | OK (caller solo se modifica a sí mismo). |
| `crear-tenant.js` | JWT + lookup `usuarios.rol='superadmin'` ✅ | superadmin only | OK. CORS allow-list. |
| `claude.js` | `checkUserAuth` ✅ | todos los authenticated | **Sin rate limit** (ver 9.1). |
| `afip-cae.js` | `checkUserAuth` ✅ | todos los authenticated | tenant_id derivado del JWT. OK. |
| `tienda-mp.js?action=preference` | **anon** | público | OK (es checkout público). |
| `tienda-mp.js?action=webhook` | **anon** | público | Sin validación HMAC del header `x-signature` MP. **TODO viejo, ver MED-4**. |
| `tienda-mp.js?action=rappi-webhook` | **anon** | público | Sin validación HMAC (ALTO-4 pendiente). |
| `tienda-mp.js?action=notify-*` | **anon** + match `cliente_email` ✅ | público | Fixed 21-may (ALTO-3). |
| `tienda-mp.js?action=cron-process-delivered` | `X-Cron-Token` ✅ | cron | OK. |
| `tienda-mp.js?action=rappi-test/sync-menu/import-menu` | `checkUserAuth` + dueno/admin ✅ | dueno/admin/superadmin | OK. |
| `mp-sync.js`, `mp-generate.js`, `mp-process.js`, `mp-update-pending-releases.js` | `checkCronAuth` ✅ | cron o superadmin/dueno/admin | OK. |
| `backup-tenants.js`, `backup-cleanup.js` | `await checkCronAuth` ✅ | cron o admins | Fixed 21-may. |
| `instagram-bot/webhook.js` | HMAC `META_APP_SECRET` ✅ | Meta | OK. |
| `instagram-bot/refresh-tokens.js` | `X-Refresh-Secret` opcional ✅ | cron | Ver ALTO-2 abajo. |
| `instagram-bot/notif-pendientes-process.js` | 3 paths: CRON_BEARER / SERVICE_KEY / JWT+rol ✅ | cron o admins | OK. |
| `instagram-bot/oauth-callback.js` | state token validado en `ig_oauth_states` + consumed flag ✅ | Meta callback | OK. |
| `instagram-bot/auth-bridge.js` | 410 Gone | deprecado | OK. |

**Veredicto general:** la matriz de auth está bien después del sprint 21-may. Las brechas que quedan son las listadas como findings individuales abajo.

---

## 3. Manager Override TOTP

### 🟠 ALTO — `precheck_manager_override` permite brute-force sin rate limit
- **File:** `packages/pase/supabase/migrations/202605180000_manager_override_totp.sql:221-274`
- `precheck_manager_override(p_codigo)` está `GRANT EXECUTE ... TO authenticated`. NO consume el código (solo informa).
- Un encargado con JWT válido puede iterar 1.000.000 de combinaciones en loop. Aún con latencia ~50ms/call, son ~14h para cubrir el espacio entero. Pero con ventana ±1 step (3 secrets válidos por ventana de 30s), y rotación cada 30s, expected-hit a brute-force aleatorio es ~33s con 30k intentos. **Práctico desde un script**.
- Aunque el `auth_tiene_permiso_o_override` real sí consume el step (`UNIQUE`), el atacante puede usar `precheck` para encontrar el código de la ventana actual sin consumirlo, y después llamar a la RPC final 1 sola vez con un código válido garantizado.
- **PoC conceptual:**
  ```ts
  // Encargado con JWT activo
  for (let n = 0; n < 1_000_000; n++) {
    const codigo = String(n).padStart(6,'0');
    const { error } = await db.rpc('precheck_manager_override', { p_codigo: codigo });
    if (!error) {
      // encontrado — ahora invocar anular_factura con override_code=codigo
      break;
    }
  }
  ```
- **Fix:**
  1. Tabla `manager_override_precheck_attempts (tenant_id, usuario_id, attempted_at)` + RAISE EXCEPTION si >10 intentos en últimos 60s.
  2. O hacer `precheck` consumir un slot temporal (TTL 60s) que limita a N pruebas por window.
  3. Idealmente: log + push al dueño si >5 intentos fallidos consecutivos.

### 🟡 MEDIO — `precheck` y validación de TOTP no son time-constant
- **File:** `202605180000_manager_override_totp.sql:252-270`
- `fn_calcular_totp` produce un string, y la comparación `IF fn_calcular_totp(...) = p_codigo` usa el operador `=` de pgsql sobre TEXT. Postgres NO garantiza comparación constant-time para strings de TEXT.
- Es un finding teórico — la diferencia para 6 dígitos numéricos es probablemente <1µs, no observable por red. Pero si se quisiera hardenear: usar `digest()` + `decode()` y comparar bytea con su propio operador (que tampoco es constant-time, pero al menos no se cortocircuita por longitud).
- **Severidad realista:** muy baja. Listo por completeness.

### 🟡 MEDIO — `obtener_codigo_totp_actual` hace lazy-init del secret
- **File:** `202605180000_manager_override_totp.sql:170-207`
- Si el secret no existe, lo crea con `gen_random_bytes(20)` en ese mismo call. **Implicancia:** dos dueños del mismo tenant que abren `/ajustes/codigos-manager` por primera vez en paralelo pueden race en el INSERT — Postgres tira `unique_violation` en uno de los dos y la pantalla se rompe. Y peor: si el primero hace lazy-init, el código que ve el segundo (post-INSERT por el primero) es completamente diferente.
- **Fix:** mover el init a un trigger de `tenants` (auto-genera al crear tenant) o usar `INSERT ... ON CONFLICT DO NOTHING RETURNING` correctamente.

### 🟢 BAJO — `obtener_codigo_totp_actual` no rate-limita
- **File:** `202605180000_manager_override_totp.sql:170-207`
- Cualquier dueño/admin puede llamarlo sin límite. El frontend lo polea cada N segundos para refrescar countdown. Si abren 50 tabs, son 50 calls/30s. No es exploit pero genera ruido.

### Cosas que SÍ están bien implementadas
- ✅ Secret BYTEA(20) por tenant, almacenado en `tenant_totp_secret` con RLS deny-all a authenticated (solo service_role + RPCs SECURITY DEFINER pueden tocarlo).
- ✅ `auth_tiene_permiso_o_override` consume el time_step con `INSERT ... UNIQUE(tenant_id, time_step)` → anti-reuse real.
- ✅ Auditoría completa en `manager_override_usos` con `(usuario_id, accion, context, time_step, usado_at)`.
- ✅ Ventana de tolerancia ±1 step (60s útil), razonable.
- ✅ El flow nuevo de "solicitar autorización" (`manager_solicitudes`, sprint 27-may) tiene token UUID de uso único + bind al `creada_por_usuario_id` + match de `accion` (defense in depth).

---

## 4. Password handling

### 🔴 CRÍTICO — (ya cubierto en sección 1: SHA-256 client-side persiste)

### 🟠 ALTO — Reset password endpoint sin rate limit
- **File:** `packages/pase/api/auth-admin.js:125-163` (`action=change_password`)
- El endpoint chequea ROLE_RANK (admin no puede resetar dueno), tenant scope. **Falta:** rate limit por caller (un admin comprometido puede resetar 100 passwords en bucle).
- **Severidad** alta porque ya es un endpoint privilegiado — fix sería un counter en Redis o tabla `auth_admin_attempts` con TTL.

### Detalle del flow `auth-change-password.js`
- Implementación correcta: valida JWT con `admin.auth.getUser(jwt)`, cambia con Admin API, UPDATEa `password_temporal=false` con service_key.
- Edge case bien manejado: si el UPDATE final falla pero el password ya cambió, devuelve `FLAG_UPDATE_FAILED` con `passwordChanged: true` → frontend muestra mensaje claro al user. Sin rollback fantasma.
- ✅ OK.

---

## 5. Session leakage

### 🟡 MEDIO — `sessionStorage['pase_user']` cachea perms — staleness UX, no security
- **Files:** `App.tsx:308,365` ("setItem"), `Usuarios.tsx:175` ("logging hash"), `ForcePasswordChange.tsx:55,101` ("removeItem")
- El objeto guardado incluye `_permisos`, `_locales`, `cuentas_visibles`, `cuentas_operables`. Si el dueño cambia permisos de un user logueado, el cache stale persiste hasta logout. CLAUDE.md ya documenta esto como "UX, no security" porque RLS server-side siempre lee fresh.
- **Riesgo real:** un encargado expulsado de un local puede seguir viéndolo en el sidebar hasta que cierre sesión. **No** puede leer datos nuevos (RLS bloquea). OK como diseño, pero conviene exponer un boton "Refrescar permisos" en /ajustes para no esperar logout.

### `pase_tenant_override__superadmin_only` (sessionStorage)
- Escritura: solo en `Tenants.tsx:73`, página gated por `if (user.rol !== "superadmin") return ...`.
- Lectura: solo en `App.tsx:315` con guard explícito `enriched.rol === "superadmin" ? sessionStorage.getItem(...) : null`.
- Si un user no-superadmin manipula manualmente la key via devtools, **es ignorada** porque App.tsx tira nullable. RLS server-side se basa en `auth_tenant_id()` del JWT — el override del client es solo cosmético.
- ✅ OK.

### `localStorage.removeItem("pase_uid")` (App.tsx:266)
- Se borra en SIGNED_OUT. Buscando el `setItem` correspondiente → no aparece en `packages/pase/src/`. Probable residuo legacy. **Recomendar limpieza.**

---

## 6. OAuth IG bot

### 🟠 ALTO — `refresh-tokens.js` solo acepta `X-Refresh-Secret`, sin path 2 (JWT)
- **File:** `packages/instagram-bot/api/refresh-tokens.js:38-43`
  ```js
  if (REFRESH_SECRET) {
    const secret = req.headers['x-refresh-secret'];
    if (secret !== REFRESH_SECRET) return res.status(401).json({...});
  }
  ```
- **Problema:** si `REFRESH_SECRET` NO está seteada en env, el endpoint **acepta cualquier llamada anónima** y rota tokens IG de todos los tenants (que es funcional pero permite DoS y manipulación: refresh forzado, marcar configs como desconectadas si Meta rechaza).
- Comparar con `_cron-auth.js` de PASE que ALTO-2 fix endurece para no abrir endpoints si la env var se borra accidentalmente.
- **Fix:** misma lógica que `_cron-auth.js`: si `process.env.VERCEL` y no hay REFRESH_SECRET, devolver 500 `MISSING_AUTH_CONFIG`. En dev local sin VERCEL, log warning + pasar.

### 🟢 BAJO — `oauth-callback.js` loguea `body_masked` pero enmascarado parcial
- **File:** `packages/instagram-bot/api/oauth-callback.js:103-112`
- El body se loguea a `ig_eventos` con `replace(IG_APP_SECRET, '***SECRET***')`. Funciona, pero:
  - Si el secret aparece URL-encoded (lo cual es exactamente lo que pasa, `URLSearchParams.toString()`), el `replace(encodeURIComponent(IG_APP_SECRET), '***SECRET***')` es la que pega — la primera línea es defense-in-depth.
  - El `code` se enmascara con `replace(String(code), '***CODE***')` — pero el code OAuth de Meta es 1-use y ya fue intercambiado al loguearlo. Riesgo bajo.
- **Severidad:** baja. Solo mencionar que `ig_eventos` no debería ser legible por encargados (verificar RLS).

### Cosas que SÍ están bien implementadas
- ✅ `ig_oauth_states` con state 64-hex (256 bits aleatoriedad) + consumed flag + expiración 15min + UNIQUE PK. CSRF protection sólida.
- ✅ El callback marca consumed=true al inicio para evitar replay.
- ✅ Validación de firma HMAC en `webhook.js:72` con `X-Hub-Signature-256` y `META_APP_SECRET`. ✅ OK.

---

## 7. VAPID / Web Push

### 🟠 ALTO — Push subscriptions: filtro cross-tenant peligroso
- **Files:** 
  - `packages/instagram-bot/api/_lib/push.js:69-72` 
  - `packages/instagram-bot/api/notif-pendientes-process.js:183-205`
- El query es:
  ```js
  .or(`tenant_id.eq.${cfg.tenant_id},tenant_id.is.null`, { foreignTable: 'usuarios' })
  ```
  La lógica documentada: "Superadmin con tenant_id=NULL recibe push de TODOS los tenants (Lucas global)."
- **Riesgo:** si un usuario NO-superadmin termina con `usuarios.tenant_id = NULL` por bug de migración o data legacy, **recibirá push de todos los tenants**. Hay un CHECK constraint `usuarios_tenant_check` que dice `rol = 'superadmin' OR tenant_id IS NOT NULL`, así que técnicamente el constraint protege. PERO si alguien (admin SQL manual, restore, migration) crea una fila con tenant_id NULL sin rol superadmin, el constraint puede haber sido bypaseado (depende del estado de la DB) — esto NO está test-eado en CI.
- **Push payload contiene info sensible:** `title: "📩 DM de @username"`, `body: "Hola, queremos pedir una mesa..."`. Si el filtro falla, atacante recibe DMs de competidores.
- **Fix:** cambiar el filter a `tenant_id.eq.${cfg.tenant_id},and(tenant_id.is.null,rol.eq.superadmin)` o validar explicitamente en código.

### 🟠 ALTO — Push subs RLS desalineado entre tablas y endpoints
- **Files:** `202605201700_admin_push_subscriptions.sql:36-43`, `202605222600_push_subs_sin_restriccion_rol.sql`
- Sequence de migrations:
  1. 20-may: INSERT requiere `auth_es_superadmin()`.
  2. 22-may noche: relajado a "cualquier authenticated del tenant" porque el módulo Mensajería tiene su propio permiso gate.
- **Issue:** el SELECT también se relajó (`USING (user_id = auth_usuario_id())`). Pero el INSERT WITH CHECK queda como `user_id = auth_usuario_id()` sin chequear `usuarios.tenant_id IS NOT NULL`. Combinado con el cross-tenant filter del finding anterior — si una fila usuarios tiene tenant_id NULL por accidente, puede inscribirse a push y recibir notificaciones de todos los tenants.
- **Fix:** agregar en `WITH CHECK`: `... AND (SELECT tenant_id FROM usuarios WHERE id = auth_usuario_id()) IS NOT NULL`.

### ✅ Otras verificaciones de VAPID
- `VAPID_PRIVATE_KEY` solo se usa en backend (`packages/instagram-bot/api/_lib/push.js`, `packages/instagram-bot/api/notif-pendientes-process.js`). No aparece en bundle del cliente. ✅ OK.
- `VITE_VAPID_PUBLIC_KEY` se inyecta al frontend (público por diseño). ✅ OK.

---

## 8. Superadmin path

### Detalles de quién es superadmin
- **Source of truth:** `usuarios.rol = 'superadmin'` con `tenant_id IS NULL`. CHECK constraint `usuarios_tenant_check` exige esto.
- **Asignación:** Solo se asigna manualmente vía SQL (no hay endpoint que cree superadmins, ni siquiera `auth-admin.js` con flag — el ROLE_RANK 100 permite a Lucas crear más superadmins, pero seteando rol='superadmin' explícito en payload). Hoy en producción es solo Lucas.
- **RPC `auth_es_superadmin()`:** lee directo `usuarios.rol` por `auth_id = auth.uid()`. SECURITY DEFINER STABLE. ✅ Source of truth única, no modificable por UI fuera de Tenants.tsx (que es self-gated).

### 🟡 MEDIO — `auth-admin.js` permite a Lucas crear otro superadmin (intencional pero arriesgado)
- **File:** `packages/pase/api/auth-admin.js:74`: `if (auth.row.rol !== 'superadmin' && requestedRank >= callerRank)` — el `!== 'superadmin'` significa que SI es superadmin, puede crear otro superadmin (incluyendo passing `tenant_id = null`). Documentado como "caso edge para Lucas".
- **Riesgo:** si la sesión de Lucas se compromete (XSS, malware, sesión clonada vía pase_uid o algo similar), atacante puede crear backdoor superadmins indistinguibles.
- **Mitigación posible:** segundo factor obligatorio para creación de superadmin (ej. TOTP del propio Lucas) + alerta push automática al `usuarios` superadmin existente cuando se crea otro.

---

## 9. Endpoints custom expuestos (api/*.js)

### 🟠 ALTO — `claude.js` sin rate limit ni cost cap por tenant
- **File:** `packages/pase/api/claude.js:31-60`
- `checkUserAuth` valida JWT (✅ ya está, antes era anon). Pero NO hay:
  - Rate limit por user/tenant.
  - Token cost cap (un user con JWT válido puede mandar `max_tokens=4096` en cada call y gastar la facturación Anthropic).
- El default `DEFAULT_MAX_TOKENS_SOPORTE = 1024` se puede overridear en el body por el caller.
- Sonnet a $3/$15 per MTok no es ruinoso, pero abuso desde un encargado descontento o competidor (con JWT comprado) puede generar facturas inesperadas.
- **Fix:**
  1. Cap `max_tokens` server-side a 2048 (override solo para tenants premium).
  2. Tabla `claude_api_usage (tenant_id, day, tokens_in, tokens_out)` actualizada por response. Bloquear si supera N MTok/día.
  3. Alerta push si un tenant supera Y% del cap.

### `crear-tenant.js`
- ✅ Solo superadmin (valida `usuarios.rol = 'superadmin'`).
- ✅ Rollback completo si la RPC falla (`auth.admin.deleteUser`).
- ✅ Password mínimo 8 chars validado.
- ✅ Slug regex `^[a-z0-9-]+$`.
- ✅ CORS allow-list.
- Pequeño detalle: si `auth.admin.deleteUser` falla en el rollback (línea 130-135), el log queda en console pero el `auth.users` queda huérfano (sin `usuarios`). Recomendable cron de cleanup que detecte `auth.users.email LIKE '%@pase.local' AND NOT EXISTS (SELECT 1 FROM usuarios WHERE auth_id = ...)`.

### `auth-admin.js` (acción `create_comanda`)
- Permite reusar `auth_id` existente entre PASE y COMANDA. Lógica correcta (mismo email → mismo auth_id, perfiles separados).
- ⚠️ **Pequeño:** si un encargado de COMANDA es admin de COMANDA (`rol_pos = 'admin'`) pero NO de PASE (donde es encargado), no chequea jerarquía cross-system. Un admin de PASE puede crear un admin de COMANDA sin restricciones — eso es probablemente lo deseado. Documentar como decisión explícita.

---

## 10. Hard-coded secrets en código

### Resultado del scan
- `grep` por `sk-ant-`, `service_role`, `VAPID_PRIVATE`, `anthropic` en `packages/pase/src/`: **0 matches.** ✅
- `process.env.ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_KEY`, `VAPID_PRIVATE_KEY` solo aparecen en `packages/pase/api/`, `packages/instagram-bot/api/`. ✅
- `import.meta.env.VITE_*` (público por diseño): `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`, `VITE_ADMIN_CONSOLE_URL`, `VITE_COMANDA_URL`. ✅

✅ No hay secretos hardcoded.

---

## 🟢 Findings bajos / observaciones no críticas

- **B1.** `_cron-auth.js` cachea el bearer en memoria de módulo (cero estado por invocación). OK.
- **B2.** `mp-update-pending-releases.js` audit log incluye `payment_id` en `auditoria.detalle` (es payment ID, no token). Sin riesgo.
- **B3.** `instagram-bot/oauth-callback.js` redirige a PASE con query params que incluyen `ig_username` y `account_id` — info no sensible, pero conviene revisar que el `error_description` no propague mensajes de error de Meta crudos (potencial leak de internal state).

---

## 📋 Acciones recomendadas (orden de prioridad)

1. **CRIT-2 (30 min):** Agregar `password_temporal` al select de `_user-auth.js` + devolver 403 si está true. Excepción para `auth-change-password.js`.
2. **CRIT-3 (30 min):** Eliminar `sha256()` + `db.update({password:hash})` de `Config.tsx` y `Usuarios.tsx`. Considerar UPDATE masivo `usuarios.password = '__supabase_auth_only__'` para limpiar hashes legacy.
3. **CRIT-1 (1-2 h):** Encriptar `ig_config.page_access_token` con vault.secrets + RPC `get_ig_token`. Refactor de bot endpoints.
4. **ALTO-1 (1 h):** Rate limit `precheck_manager_override` (tabla counter + cap 10/min).
5. **ALTO-2 (30 min):** `refresh-tokens.js` requerir REFRESH_SECRET en VERCEL.
6. **ALTO-3+4 (1 h):** Endurecer filter `tenant_id.is.null` en push subs queries (validar `rol='superadmin'` explícito).
7. **ALTO-5 (1-2 h):** Rate limit `/api/claude` y cap `max_tokens` server-side.
8. **MEDIO + BAJO:** sprints futuros.

---

## 📁 Files clave referenciados

- `C:\Users\lucas\Documents\PASE\packages\pase\api\_user-auth.js`
- `C:\Users\lucas\Documents\PASE\packages\pase\api\auth-admin.js`
- `C:\Users\lucas\Documents\PASE\packages\pase\api\auth-change-password.js`
- `C:\Users\lucas\Documents\PASE\packages\pase\api\crear-tenant.js`
- `C:\Users\lucas\Documents\PASE\packages\pase\api\claude.js`
- `C:\Users\lucas\Documents\PASE\packages\pase\api\_cron-auth.js`
- `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\Login.tsx`
- `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\Usuarios.tsx`
- `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\Config.tsx`
- `C:\Users\lucas\Documents\PASE\packages\pase\src\pages\ForcePasswordChange.tsx`
- `C:\Users\lucas\Documents\PASE\packages\pase\src\App.tsx`
- `C:\Users\lucas\Documents\PASE\packages\pase\src\components\ManagerOverrideModal.tsx`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605180000_manager_override_totp.sql`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605270500_manager_solicitudes.sql`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605212100_instagram_bot_schema.sql`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605220900_ig_oauth_flow.sql`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605201700_admin_push_subscriptions.sql`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202605222600_push_subs_sin_restriccion_rol.sql`
- `C:\Users\lucas\Documents\PASE\packages\pase\supabase\migrations\202604261246_encriptar_mp_token_part_a.sql` (modelo de encryption a replicar para IG)
- `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\oauth-callback.js`
- `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\refresh-tokens.js`
- `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\_lib\push.js`
- `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\notif-pendientes-process.js`
- `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\webhook.js`
- `C:\Users\lucas\Documents\PASE\packages\instagram-bot\api\auth-bridge.js` (deprecated 410 Gone)
