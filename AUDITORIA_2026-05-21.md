# Auditoría técnica completa — PASE / COMANDA / admin-console

**Fecha:** 2026-05-21
**Scope:** `packages/pase` (prod), `packages/comanda` (WIP), `packages/admin-console` (consola Lucas). NO se auditó `packages/instagram-bot` (ya validado funcional).
**Método:** 4 auditores Claude especializados en paralelo (seguridad, multitenant, lógica financiera, escalabilidad).

---

## Executive Summary

El sistema **NO está en estado seguro para producción multi-cliente**. Hay **3 vulnerabilidades CRÍTICAS explotables hoy mismo** que permiten desde takeover total de cuentas (incluida la de Lucas/superadmin) hasta lectura de datos comerciales sensibles de cualquier tenant desde cualquier sesión autenticada. Y hay **bugs de concurrencia financiera** que pueden generar pérdida real de dinero en restaurantes con 2+ usuarios operando caja al mismo tiempo.

**La buena noticia**: la mayoría de los críticos son fixes muy chicos (2-30 min cada uno). Es ~3 horas de trabajo concentrado para cerrar todo lo CRÍTICO. Después queda hardening de ALTOS (~1 día) y mejoras de MEDIOS (próximo sprint).

El otro tema grande: **PASE está al límite EXACTO 12/12 de Vercel Hobby functions**. Cualquier endpoint serverless nuevo rompe el deploy hasta que se desbloquee. Esto se debe arreglar antes de seguir agregando features.

Sobre **separar COMANDA a URL propia**: factible, ~1 día de trabajo + DNS, pero conviene resolver el cuello de 12 functions primero y planear SSO bridge si no se quiere que el staff loguee 2 veces.

---

## 🔥 Lista consolidada de CRÍTICOS (rompe o expone HOY)

Estos están confirmados por 2-3 auditores independientes (alta confianza, no falsos positivos).

### 1. `auth-admin.js` permite takeover total del producto sin autenticación
- **File:** `packages/pase/api/auth-admin.js:17-109`
- **Vector:** endpoint usa `SUPABASE_SERVICE_KEY` y NO valida JWT. Acepta `action=create` (crea usuario con cualquier rol en cualquier tenant) y `action=change_password` (resetea contraseña de cualquier authId).
- **Explotación:** `curl -X POST <url>/api/auth-admin -d '{"action":"change_password","authId":"<UUID-de-Lucas>","password":"hacked"}'` → atacante toma la cuenta de Lucas (superadmin).
- **Fix:** importar `checkUserAuth`, validar rol `superadmin` en `change_password` (o mismo tenant + rol dueno en `create`).
- **Esfuerzo:** 30 min.

### 2. `backup-tenants.js` y `backup-cleanup.js` con `await` faltante → endpoint abierto
- **Files:** `packages/pase/api/backup-tenants.js:75`, `packages/pase/api/backup-cleanup.js:23`
- **Vector:** `checkCronAuth` es async. Se llama como `if (!checkCronAuth(req, res)) return;` SIN `await` → `!Promise` siempre es `false` → la guardia nunca dispara.
- **Explotación:** cualquier anónimo puede ejecutar backups completos de TODOS los tenants (DoS de DB, gasto Vercel) o deletes de `idempotency_keys` en bucle.
- **Fix:** agregar `await` y paréntesis. Cambio de 2 caracteres.
- **Esfuerzo:** 5 min.

### 3. `fn_cmv_real` y `fn_cmv_real_resumen` permiten leer datos de cualquier tenant
- **File:** `packages/pase/supabase/migrations/202605211500_cmv_real.sql:21-50, 226-247`
- **Vector:** RPCs `SECURITY DEFINER` que reciben `p_tenant_id` del cliente sin validarlo contra `auth_tenant_id()`.
- **Explotación:** cualquier user autenticado de cualquier tenant invoca `db.rpc('fn_cmv_real_resumen', { p_tenant_id: '<uuid-otro-tenant>', ... })` → recibe CMV, facturación, márgenes, mermas valorizadas del competidor.
- **Fix:** agregar al inicio: `IF p_tenant_id <> auth_tenant_id() AND NOT auth_es_superadmin() THEN RAISE EXCEPTION 'TENANT_MISMATCH'; END IF;`
- **Esfuerzo:** 15 min (1 migration con 2 ALTER FUNCTION).

### 4. `fn_revertir_stock_factura(TEXT)` permite sabotear stock cross-tenant
- **File:** `packages/pase/supabase/migrations/202605211400_entrada_stock_por_factura.sql:116-156`
- **Vector:** RPC `SECURITY DEFINER` sin auth check. Recibe factura_id y crea movimientos de reversión sobre el stock del tenant dueño de esa factura.
- **Explotación:** user tenant A pasa IDs de facturas de tenant B → destroza el stock histórico de B.
- **Fix:** validar `SELECT tenant_id FROM facturas WHERE id = p_factura_id` == `auth_tenant_id()` + permiso dueño/admin.
- **Esfuerzo:** 15 min.

### 5. `fn_recalcular_stock_todos(p_tenant_id UUID)` escribe stock cross-tenant
- **File:** `202605203200_stock_movimientos.sql:177-201`
- **Vector:** RPC `SECURITY DEFINER` con `COALESCE(p_tenant_id, auth_tenant_id())`. Si se pasa explícito, no se valida.
- **Explotación:** user tenant A pasa `p_tenant_id='<uuid-tenant-B>'` → recalcula `stock_actual` de todos los insumos de B (denial of integrity).
- **Fix:** validar `p_tenant_id <> auth_tenant_id()` antes de respetarlo (solo superadmin puede cruzar).
- **Esfuerzo:** 10 min.

### 6. 8 Vistas SQL sin `security_invoker = on` exponen datos cross-tenant
- **Files:** 
  - `202605210900_subscriptions_billing.sql:289` → `v_admin_metricas_tenants` (ventas/facturación de TODOS los tenants — leak comercial del ecosistema)
  - `202605202800_delivery_riders.sql:335,372` → `v_pedidos_delivery_mapa`, `v_riders_status` (PII grave: nombre/teléfono/dirección/lat/lon de clientes y riders)
  - `202605203400_stock_ajustes_conteo.sql:283,323` → `v_insumos_alertas_stock`, `v_stock_rotacion_30d` (stock + costos cross-tenant)
  - `202605204000_gastos_empleado_concepto.sql:196` → `v_rrhh_adelantos_desglose` (datos salariales)
  - `202605202700_print_agents.sql:195` → `v_print_agents_status` (info técnica)
  - `202605161300_items_review_queue.sql:30` → `v_items_review_queue` (catálogo + precios + recetas)
- **Vector:** sin `security_invoker = on`, las views ejecutan con permisos del owner Postgres, bypaseando RLS de tablas base. `GRANT SELECT TO authenticated` expone todo.
- **Explotación:** `SELECT * FROM v_admin_metricas_tenants` desde sesión de cualquier tenant → lista de todos los clientes del SaaS con facturación.
- **Fix:** `ALTER VIEW <nombre> SET (security_invoker = on);` para las 8.
- **Esfuerzo:** 30 min (1 migration consolidada).

### 7. `pagar_factura` y `pagar_remito` NO usan `FOR UPDATE` → doble cobro concurrente
- **File:** `packages/pase/supabase/migrations/202605091220_sprint7_idempotency_pase_pagos.sql:70, 143`
- **Vector:** SELECT factura sin lock + read-modify-write sobre JSONB `pagos`. Idempotency_key catchea retries pero NO pagos legítimos concurrentes desde keys distintos.
- **Explotación:** 2 usuarios (encargado A + dueño B) cobran la misma factura de $100k al mismo tiempo: T1 lee `pagos=[]`, T2 lee `pagos=[]`. T1 UPDATE `pagos=[A]`, T2 UPDATE `pagos=[B]` (sobrescribe A). Resultado: factura figura pagada 1 vez con $100k, pero hay 2 movimientos de caja → caja sale $100k corta sin razón visible.
- **Fix:** `SELECT * INTO v_fac FROM facturas WHERE id = p_factura_id FOR UPDATE;` (1 línea por RPC).
- **Esfuerzo:** 5 min (1 migration con 2 CREATE OR REPLACE).

### 8. `fn_iniciar_traspaso` y `fn_registrar_merma` sin lock de insumos → stock negativo
- **File:** `packages/pase/supabase/migrations/202605211900_traspasos_en_transito.sql:81-105`
- **Vector:** validación de stock `IF v_insumo.stock < p_cantidad` se hace contra SELECT sin `FOR UPDATE`. Otro proceso puede gastar stock entre el chequeo y el INSERT.
- **Explotación:** insumo "lomo" 5kg. Encargado A pide traspaso de 5kg (lee 5, OK). Encargado B en paralelo pide 3kg (lee 5, OK). Ambos insertan. Stock final: -3kg. CMV real corrupto, traspasos iniciados sin producto.
- **Fix:** `SELECT stock_actual INTO v_insumo.stock FROM insumos WHERE id = p_insumo_id FOR UPDATE;` antes del IF.
- **Esfuerzo:** 10 min (incluye `fn_aplicar_stock_venta` que tiene el mismo bug).

### 9. RPCs `_offline` de COMANDA no validan coherencia args con `idempotency_uuid` cached
- **File:** `packages/pase/supabase/migrations/202605161500_offline_pagos_overrides_transfer.sql:107-127`
- **Vector:** dedup por UUID retorna OK silencioso si el UUID ya fue consumido, pero NO valida que los args coincidan. Cliente buggy/malicioso puede reusar mismo UUID para operaciones distintas.
- **Explotación:** device offline genera UUID U para anular item 100, push OK. Bug del cliente reusa U para anular item 200. Server retorna "OK" sin hacer nada. Item 200 NO se anula. Cliente cobra item "cancelado".
- **Fix:** agregar `AND venta_item_id = v_item_id` (o equivalente) al WHERE del dedup. Si existe pero no coincide → `RAISE 'IDEMPOTENCY_UUID_REUSE'`.
- **Esfuerzo:** 30 min (~5 RPCs).

### 10. `fn_registrar_pago_invoice` con `auth.uid()::INTEGER` → cobros del SaaS rotos
- **File:** `packages/pase/supabase/migrations/202605210900_subscriptions_billing.sql:207`
- **Vector:** `v_user_id := auth.uid()::INTEGER`. `auth.uid()` retorna UUID. Cast UUID→INTEGER tira `invalid input syntax`. La RPC ABORTA cada vez que Lucas marca un pago manual desde admin-console.
- **Impact:** Lucas no puede registrar pagos de subscripción → tenants suspendidos por error operativo, pérdida de revenue del SaaS.
- **Fix:** `SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() LIMIT 1;` (patrón canónico).
- **Esfuerzo:** 5 min. **Mismo bug en `fn_cargar_conteo_linea` (`202605203400:276`)** — fix global con un grep.

### 11. Vercel Hobby al límite EXACTO 12/12 functions
- **File:** `packages/pase/api/*.js` (12 functions no-helpers).
- **Vector:** próximo endpoint serverless rompe el deploy con `state=ERROR` post-build. Incidente real documentado 11-may con `crear-tenant.js` (function #13).
- **Fix:** Opciones (en orden de mejor a peor):
  1. Consolidar `mp-generate + mp-process` en uno con `?action=...` (2-3h)
  2. Mover `backup-cleanup + backup-tenants` al proyecto `instagram-bot` (tiene cupo, comparte secrets) (3h)
  3. Mover `auto-fix-trigger` (si vuelve a habilitarse) al proyecto bot
  4. Upgrade a Vercel Pro ($20/mes/seat, lift el límite a 100)
- **Esfuerzo:** 2-3h o $20/mes.

### 12. Bundle inicial sin `manualChunks` para `recharts` y `driver.js`
- **File:** `packages/pase/vite.config.ts:13-21`
- **Vector:** `recharts` (~400KB) y `driver.js` (~80KB) van al chunk principal porque no están particionados. Cualquier pantalla que NO usa charts igual descarga 400KB extra.
- **Fix:** agregar al manualChunks:
  ```js
  if (id.includes('node_modules/recharts')) return 'vendor-charts';
  if (id.includes('node_modules/driver.js')) return 'vendor-onboarding';
  ```
- **Esfuerzo:** 15 min + verificar con `pnpm --filter pase build`.

### 13. PASE+COMANDA acoplados en build coupling
- **File:** `packages/pase/package.json:8` (`node ../../scripts/build-comanda-into-pase.mjs && vite build`)
- **Vector:** PASE no puede deployar si COMANDA falla. Suma 2-3 min a cada deploy. Bug del 21-may del Vercel queue stuck.
- **Fix:** parte del plan de separación COMANDA a URL propia (ver sección dedicada abajo).
- **Esfuerzo:** dentro del plan COMANDA.

---

## ⚠️ ALTOS (sprint hardening — esta semana)

### A1. `_cron-auth.js` Path 2 permite a CAJEROS disparar crons cross-tenant
- **File:** `packages/pase/api/_cron-auth.js:24`. `ALLOWED_ROLES = ['superadmin', 'dueno', 'admin', 'cajero']`.
- **Explotación:** un cajero llama `POST /api/mp-sync?reset=<local_id_de_OTRO_tenant>` → mp-sync.js:61-73 borra mp_movimientos de locales ajenos.
- **Fix:** quitar `cajero` de ALLOWED_ROLES; validar `reset` ids contra `auth_tenant_id()` en el endpoint.
- **Esfuerzo:** 30 min.

### A2. `_cron-auth.js` Path 3 fallback — "sin CRON_BEARER pasa todo"
- **File:** `_cron-auth.js:62-65`. Si la env var no está, devuelve `true`.
- **Riesgo:** Lucas borra accidentalmente la env, todos los crons quedan abiertos al mundo.
- **Fix:** hard-fail en producción. Detectar Vercel con `process.env.VERCEL === '1'`.
- **Esfuerzo:** 15 min.

### A3. 4 endpoints `notify-*` permiten spam con tu dominio
- **File:** `packages/pase/api/tienda-mp.js:462-726`
- **Vector:** anónimos pueden mandar emails al destinatario que quieran con `notify-pedido/notify-listo/notify-rechazado/notify-entregado`. Sin rate limit. Spam dirigido + reputation hit del SMTP.
- **Fix:** validar `email_destinatario === venta.cliente_email` (sin override) o exigir auth.
- **Esfuerzo:** 1h.

### A4. Webhooks Rappi/PedidosYa/Deliverect sin verificación HMAC
- **File:** `packages/pase/api/tienda-mp.js:310-460`. Comentario explícito: "TODO validar firma HMAC".
- **Vector:** atacante manda pedidos falsos a la cocina → DoS operativo + decremento stock fake.
- **Fix:** wire los `verifyRappiWebhookSignature` que están definidos pero `void`-eados. Gate con feature flag si el partner no proveé secret todavía.
- **Esfuerzo:** 2h.

### A5. `tienda-mp.js` y `crear-tenant.js` con CORS `*` + Authorization
- **Vector:** superficie ampliada si JWT se roba en otro front.
- **Fix:** allow-list explícito de origins (`pase-yndx.vercel.app`, `pase-admin.vercel.app`, futura URL COMANDA).
- **Esfuerzo:** 30 min.

### A6. N+1 en `Tenants.tsx` (admin-console)
- **File:** `packages/pase/src/pages/Tenants.tsx:47-53` — por cada tenant, 2 queries count en `Promise.all`.
- **Fix:** RPC `tenants_con_counts()` con LEFT JOIN + GROUP BY.
- **Esfuerzo:** 1h.

### A7. `UltimosOverridesWidget.tsx:76` fetchea TODOS los usuarios para mapear 5
- **Fix:** `.in("id", uniqueIds)`.
- **Esfuerzo:** 10 min.

### A8. Migration realtime publication NO aplicada en prod
- **File:** `packages/comanda/DEUDA_TECNICA.md:73-75` lo declara explícitamente.
- **Impact:** suscripciones realtime degradadas silenciosamente.
- **Fix:** aplicar `202605101100_sprint_realtime_publication.sql`.
- **Esfuerzo:** 5 min de SQL + verificación.

### A9. `pagar_sueldo` multi-local: chequeo de saldo post-failure (UX, no bug)
- **File:** `202605212000_pagar_sueldo_multi_local.sql:158-193`. Rollback funciona, pero el dueño ve "saldo insuficiente" en línea 5 de 5 después de ya intentar.
- **Fix:** pre-validar todos los saldos antes del loop. ~10 líneas.
- **Esfuerzo:** 30 min.

### A10. RPCs Stock + OAuth IG + Billing con error codes NO mapeados en `errors.ts`
- **Files:** `errors.ts:5-101` no tiene: `LOCALES_IGUALES`, `PERMISO_DENEGADO_ORIGEN/DESTINO`, `STOCK_INSUFICIENTE`, `MOTIVO_NO_ENCONTRADO`, `OVERRIDE_INVALIDO`, `INVOICE_NO_ENCONTRADA`, `SOLO_SUPERADMIN`, etc. (~15 codes).
- **Impact:** usuario ve código raw en pantalla → soporte extra.
- **Fix:** agregar 15 strings al MAP.
- **Esfuerzo:** 30 min.

### A11. `anular_factura` sin `FOR UPDATE` → race con pagar_factura
- **File:** `202605180100_anular_con_override.sql:45`. Mismo patrón que CRIT-7.
- **Fix:** `FOR UPDATE` en SELECT inicial.
- **Esfuerzo:** 5 min.

### A12. UI de `pagar_factura` con N pagos no persiste idempotency_key pre-fetch (regla C10)
- **Vector:** browser muere entre pago 2/3, retry automático genera key nueva → doble pago.
- **Fix:** persistir key en localStorage antes del fetch, borrar post-confirmación.
- **Esfuerzo:** 1h.

### A13. `tenant_subscriptions`, `tenant_invoices`, `mermas_motivos`, `simulaciones` sin policy explícita `service_role`
- **Vector:** funciona (service_role bypassa RLS por diseño) pero rompe patrón del repo + lint.
- **Fix:** agregar `FOR ALL TO service_role USING (TRUE)`.
- **Esfuerzo:** 15 min.

---

## 🟡 MEDIOS (próximo sprint)

| ID | Hallazgo | File | Esfuerzo |
|---|---|---|---|
| M1 | `fn_aplicar_stock_venta` itera receta sin lock | `202605203300:51-69` | 1h |
| M2 | `fn_revertir_stock_venta` no respeta `deleted_at` en items | `202605203300:130-142` | 15 min |
| M3 | `fn_registrar_merma` no valida que `p_local_id` pertenezca al tenant | `202605211800:53` | 15 min |
| M4 | `fn_cancelar_traspaso` permite que el destino cancele sin motivo | `202605211900:283` | 15 min |
| M5 | Admin-console `Pagos.tsx` doble-click → 2 invoices pagadas | `Pagos.tsx:164 + billing.sql` | 30 min |
| M6 | Tablas Stock sin RLS confirmada (verificar) | `mermas`, `conteos_stock*`, etc. | 30 min |
| M7 | Filtro fecha default 90d en pantallas nuevas (Stock UI, Mensajería IG) | Cuando se haga la UI | parte de cada feature |
| M8 | Debounce 300ms en pantallas con filtro texto (Compras, Usuarios, MensajeriaIG) | varios | 1h |
| M9 | `mp_credenciales` con tokens MP encriptados en backup → verificar policy bucket | `backup-tenants.js:42` | 20 min |
| M10 | Hardcoded IVA 21% en `tenant_invoices` (no soporta monotributo/exento) | `billing.sql:279` | 30 min |
| M11 | Tests E2E manager override no cubren scenarios multi-local | `manager_override_mutante.spec.ts` | 1h |
| M12 | Posibles índices faltantes: `mermas (tenant_id, local_id, created_at)`, `conteos (local_id, fecha)` | varias migrations | 30 min |

---

## 📋 Tests E2E mutantes faltantes (regla C2)

Priorizado por criticidad — toca plata o lógica financiera:

| # | Feature | Justificación | Esfuerzo |
|---|---|---|---|
| 1 | `pagar_sueldo` multi-local con `formas_pago[].local_id` | Desbalancea cajas en silencio si falla | 2h |
| 2 | `fn_iniciar_traspaso + fn_confirmar_recepcion` | Inventario valorizado = balance | 3h |
| 3 | `fn_registrar_merma` (con motivo + categoría) | Costo a P&L | 1.5h |
| 4 | `fn_conteo_cerrar` | Ajuste inventario sin auditoría puede ser grande | 2h |
| 5 | `editar_gasto_con_override` (20-may) | Toca plata, no testeado | 1h |
| 6 | `fn_registrar_pago_invoice` (admin-console) | Cobros del SaaS | 1.5h |
| 7 | `fn_ig_oauth_iniciar` (state CSRF + single-use) | Seguridad | 1h |
| 8 | Manager Override scenarios multi-local | IDOR latente sin cobertura | 1h |

Total: **~13 horas** de tests + ~1h de setup de fixtures. Se puede repartir entre sprints.

---

## 🔀 Plan separación COMANDA → URL propia

### Estado actual

COMANDA está **triple-deployada** hoy:
1. **Embebida** en `pase-yndx.vercel.app/comanda-app/*` (script `build-comanda-into-pase.mjs` copia el build a `public/`)
2. **Proyecto Vercel separado** (existe pero hay que confirmar URL/uso)
3. PWA manifest tiene `start_url: '/pos'` que NO respeta el base path → install roto en la versión embedded

### Fases del plan

| Fase | Trabajo | Tiempo | Riesgo |
|---|---|---|---|
| **0** | Confirmar URL target (¿`comanda.lucas.com.ar`?, ¿usás dominio propio?) | 30 min | — |
| **1** | Doble vivo: dejar `/comanda-app/` Y deploy separado activos. Banner anunciando cambio en la versión embedded. | 1h | Bajo |
| **2** | Custom domain en Vercel + DNS (`CNAME → cname.vercel-dns.com`). SSL gratis automático. | 1h trabajo + 1-24h DNS | Medio (DNS .com.ar es lento) |
| **3** | **SSO bridge** (opción recomendada): endpoint `/api/auth-bridge` en PASE firma refresh token corto al saltar a COMANDA. COMANDA detecta el param, hace `db.auth.setSession`, limpia URL. **Si NO se hace: staff loguea 2 veces todos los días → quejas en 48h.** | 3-4h | Medio |
| **4** | Verificar PWA install desde URL separada | 30 min | Bajo |
| **5** | Redirect 301 `/comanda-app/(.*) → comanda.X.com.ar/$1`. Mantener 90 días por bookmarks viejos. | 30 min | Bajo |
| **6** | Cleanup: sacar `build-comanda-into-pase.mjs`, rewrite del `vercel.json`, carpeta `public/comanda-app/` | 1h | Bajo |

**Total: ~1 día de trabajo + 24-48h DNS.**

### Riesgos clave

| Riesgo | Mitigación |
|---|---|
| Sesiones perdidas al cutover | Hacer sábado noche + Whatsapp al staff |
| Bookmarks viejos | Redirect 301 90 días |
| API calls cross-origin (`/api/claude`) | CORS allow-list o mover endpoint a `instagram-bot` (tiene cupo) |
| Versión PASE/COMANDA desincronizadas | Regla: nunca cambiar firma de RPC, solo agregar params opcionales |
| Build script resucita por accidente | Borrar el script entero del repo |
| 2 proyectos Vercel Hobby con builds concurrentes → queue stuck (incidente 21-may) | Si recurrente, upgrade a Pro |
| Notificaciones de Bandeja de Entrada cruzando apps con URLs distintas | Usar URLs absolutas en notifications |

### Recomendación

**Separar COMANDA SÍ, pero NO antes de:**
1. Resolver CRIT-11 (12 functions al límite)
2. Decidir si se hace SSO bridge o se acepta login doble por 2 semanas

Si Lucas quiere "ya", camino más limpio = Fases 1+2+5+6 sin SSO, ~6h de trabajo + DNS, y SSO en sprint dedicado.

**NO recomiendo** mantener el doble-deploy actual a largo plazo: tiene lo peor de ambos mundos.

---

## ✅ ÁREAS REVISADAS SIN HALLAZGOS RELEVANTES (para tu tranquilidad)

- ✅ `pase_tenant_override` (localStorage) — backend no lo respeta, solo UI client-side.
- ✅ Admin-console valida rol superadmin server-side + RPCs `crear_tenant_v2`, etc.
- ✅ `crear-tenant.js`, `claude.js`, `instagram-bot/api/send.js`, `telegram-webhook.js`, `mp-sync.js`, `mp-process.js`, `mp-generate.js`, `mp-update-pending-releases.js`, `afip-cae.js` — TODOS validan JWT/secrets correctamente y filtran por tenant.
- ✅ `fn_simular_escenario`, `fn_iniciar_traspaso`, `fn_confirmar_recepcion_traspaso`, `fn_rechazar_recepcion_traspaso`, `fn_cancelar_traspaso`, `fn_registrar_merma` (con TOTP) — validan `auth_tenant_id()` + permisos por local.
- ✅ `fn_ig_oauth_iniciar` — valida tenant + dueño/admin.
- ✅ Tablas IG (`ig_config`, `ig_clientes`, `ig_conversaciones`, `ig_mensajes`, `ig_eventos`) — RLS dual completa.
- ✅ Funciones RLS helpers (`auth_tenant_id`, `auth_locales_visibles`, `auth_es_dueno_o_admin`, `auth_es_superadmin`) — todas declaradas `STABLE`. RLS performance correcta.
- ✅ Vistas `v_ig_conversaciones_admin`, `v_ig_conexion_estado`, `v_stock_transferencias`, `v_mermas_top10`, `v_rrhh_empleados_visible` (parcheada 19-may) — todas con `security_invoker = on`.
- ✅ `fn_agent_select` (SQL arbitrario) — restringido a `service_role`, no expuesto HTTP.
- ✅ Secrets en código — no se encontraron tokens hardcodeados.
- ✅ ESLint rule `pase-local/no-eager-page-import-app` — sin `eslint-disable-next-line` → C8 cumple.
- ✅ Lazy imports en `App.tsx` (PASE + COMANDA + admin-console) — ampliamente aplicados.
- ✅ Índices compuestos `(tenant_id, local_id, fecha)` ya agregados en `202605112100`.
- ✅ Cache de permisos sessionStorage 1h.

---

## Próximos pasos sugeridos (orden ejecutable)

### Sprint hardening crítico (1 sesión, ~3-4 horas)
1. **Fix CRIT-1 + CRIT-2 + CRIT-10** (~45 min): `auth-admin.js` + `backup-*.js` await + `auth.uid()::INTEGER` global
2. **Fix CRIT-3 + CRIT-4 + CRIT-5** (~40 min): RPCs cmv_real, revertir_stock_factura, recalcular_stock_todos — 1 migration consolidada
3. **Fix CRIT-6** (~30 min): 8 vistas con `security_invoker = on` — 1 migration
4. **Fix CRIT-7 + CRIT-8 + A11** (~30 min): `FOR UPDATE` en pagar_factura, pagar_remito, anular_factura, fn_iniciar_traspaso, fn_aplicar_stock_venta — 1 migration
5. **Fix CRIT-9** (~30 min): coherencia args en RPCs `_offline`
6. **Verificar deploy + smoke tests** (~30 min)

### Sprint hardening ALTOS (1 día)
- A1-A13 según orden de severidad
- Implementar tests mutantes 1-4 (pagar_sueldo multi, traspasos, mermas, conteos cierre)

### Decisión Vercel
- Decidir: consolidar `mp-generate + mp-process` (3h) o upgrade Vercel Pro ($20/mes)

### Decisión COMANDA URL
- Decidir: hacer ya con login doble + SSO en sprint dedicado, o esperar y hacer completo

### Roadmap MEDIOS + tests restantes
- Próximo sprint normal
