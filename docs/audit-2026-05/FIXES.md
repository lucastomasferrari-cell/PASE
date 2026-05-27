# Auto-fixes commiteados durante la auditoría

Registro de fixes mecánicos commiteados automáticamente (sin pedir aprobación
en cada uno). Solo van acá los que cumplen criterio "evidente" del design doc.

## Formato

Una entrada por commit, con:
- Fecha + hash corto
- Fase de auditoría que lo originó
- Archivo(s) tocados
- Qué cambió (1 línea)

## Log

### 2026-05-27 — F1 sprint críticos auto-fixeables

**Migration:** `packages/pase/supabase/migrations/202605270700_audit_f1_criticos.sql`
**Aplicada en prod:** 2026-05-27 (1.2s, smoke checks ✅)
**Reporte fuente:** [01-bugs-financieros.md](./01-bugs-financieros.md)

13 críticos arreglados en una migration consolidada:

| # | RPC / Tabla | Cambio |
|---|---|---|
| 1 | `eliminar_cierre` | Quitar `UPDATE saldos_caja` manual del loop (trigger lo hace) |
| 2 | `eliminar_venta` | Quitar `UPDATE saldos_caja` manual (trigger lo hace) |
| 4 | `anular_factura` | Anular movs asociados (`UPDATE movimientos SET anulado=true WHERE fact_id=...`) |
| 5 | `rrhh_pagos_especiales` | Agregar `anio` + `periodo`, reemplazar UNIQUE por `(empleado, tipo, anio, periodo)` → desactiva time bomb SAC junio 2026 |
| 7 | `_resync_liquidacion_pagos` + `pagar_sueldo` + `anular_movimiento` | Preservar `pagado_at`/`pagado_por` aunque cambie estado |
| 8 | `idempotency_keys` | PK con `tenant_id` + RPCs filtran por tenant en lookup/insert |
| 9 | `pagar_sueldo` | Agregar `FOR UPDATE` sobre `rrhh_liquidaciones` y `rrhh_adelantos` |
| 10 | `aplicar_nc_a_factura` | `pg_advisory_xact_lock` por NC + `p_idempotency_key` (drop overload viejo) |
| 11 | `anular_movimiento` | `FOR UPDATE` + promover a `SECURITY DEFINER` |
| 12 | `pagar_factura` | Migrar idempotency a tabla canónica (era hack con `movimientos.idempotency_key`) |
| 13 | `fn_trg_sync_saldos_caja` | Usar `NEW.tenant_id` directo, skipear si `local_id IS NULL`, `IS DISTINCT FROM` |
| 14 | `fn_conciliar_mp_*` (3 RPCs) | Eliminar llamadas a `_actualizar_saldo_caja` NOOP |
| 15 | `crear_gasto_empleado` | Quitar `UPDATE saldos_caja` manual antes del INSERT en movimientos |

**Postergados para decisión humana** (2 críticos que no se auto-fixean):
- **#3 `pagar_remito`**: ¿validar match exacto, parcial, margen %?
- **#6 `pagar_sueldo` sobrepago silencioso**: ¿abortar siempre o flag opt-in?

**Data huérfana confirmada en prod** (limpieza pendiente, no fue auto-fixeada):
- 1 factura anulada con pago activo (`FACT-1778176077832-myzh`)
- 24 liquidaciones con `pagos_realizados > total_a_pagar`
- 3 liquidaciones con estado=`pagado` y `pagos_realizados < total_a_pagar`
- 2 adelantos con `descontado=true` sin `liquidacion_consumidora_id`

### 2026-05-27 — F2 sprint críticos seguridad multi-tenant

**Migrations:**
- `packages/pase/supabase/migrations/202605270800_audit_f2_criticos.sql` (744ms, smoke ✅)
- `packages/pase/supabase/migrations/202605270900_ig_token_encryption.sql` (415ms, smoke ✅)
**Reportes fuente:**
[02-seguridad-multi-tenant.md](./02-seguridad-multi-tenant.md) — sub-reportes 02a/02b/02c/02d.

26 críticos aplicados (de 32 totales — los 6 restantes son ALTO/MEDIO o requieren rediseño):

| Grupo | Bugs | Cambio |
|---|---|---|
| A - RLS history tables | #1-4 | 4 policies con filter `(old_data\|new_data)->>'tenant_id' = auth_tenant_id()` — corta leak de 363+116+115+1 rows × hasta 64 tenants distintos |
| B - RPCs Comanda sin auth | #5-14 | `fn_agregar_pago_venta_comanda`, `fn_procesar_reversos_pendientes_comanda`, `fn_aplicar_cupon`, `fn_aplicar_stock_venta` (+revertir), `fn_marcar_listo`/`entregado_comanda`, `fn_set_pedido_geo`, `fn_recalc_costo_insumo`/`recalcular_stock_insumo`, `fn_recalcular_totales_venta_comanda`, `fn_recalcular_saldo_proveedor`: agregaron `fn_assert_local_autorizado` |
| C - REVOKE helpers | #15-18 | `agent_update_ticket`, `dispatch_auto_fix_workflow`, `_resync_liquidacion_pagos`, `_resync_pago_especial`, `fn_user_quiere_notif` ahora REVOKE FROM PUBLIC, anon, authenticated. Triggers internos siguen funcionando porque corren como postgres |
| D - RLS gaps | #19 | `comanda_permisos_catalogo` ENABLE RLS + 2 policies (select abierto, write superadmin-only) |
| D - tenant escape | #20 | `comanda_print_agents` UPDATE WITH CHECK simétrico (cerraba ventana de cambiar tenant_id en UPDATE) |
| D - UNIQUE leak | #21 | `usuarios.email` UNIQUE → `(email, COALESCE(tenant_id, nil-uuid))` — squatting / enumeration cross-tenant |
| D - UNIQUE leak | #22 | `comanda_local_settings.slug` UNIQUE → `(slug, tenant_id)` |
| E - serverless | #25 | `afip-cae.js` idempotency lookup filtra `tenant_id` |
| E - serverless | #26 + ALTO #8 | `LectorFacturasIA.tsx` + `Blindaje.tsx` Storage upload con prefijo `${tenant_id}/...` |
| E - serverless | ALTO #2 | `tienda-mp.js` eliminada rama `?local_id` en query de webhooks rappi/pedidosya — antes permitía spoof unauth |
| F - auth | #27 | IG `page_access_token` ahora encriptado at-rest con pgcrypto + vault.secrets (passphrase aleatoria 256-bit). Nuevas RPCs `get_ig_token`/`set_ig_token`. 4 endpoints IG (oauth-callback, refresh-tokens, send, webhook) refactor para usar las RPCs |
| F - auth | #28 | `_user-auth.js` chequea `password_temporal` server-side. Antes el flag solo se enforced en frontend — user recién creado podía llamar `/api/claude` con curl |
| F - auth | #29 | Eliminado SHA-256 client-side de `Config.tsx` y `Usuarios.tsx`. Cambio de password SOLO via Supabase Auth (Argon2id). Eliminado el `console.log` que filtraba 16 chars del hash |
| F - auth | ALTO #7 | `refresh-tokens.js` fail-closed si `REFRESH_SECRET` falta en producción |

**No incluidos (requieren decisión o rediseño):**
- F2C#23 `tienda-mp?action=preference` anon + venta_id BIGSERIAL enumerable → necesita rediseño checkout (HMAC short-lived).
- Deuda residual de 15 filas con hash SHA-256 viejo en `usuarios.password` — pendiente cleanup en migration aparte.
- IG token plano (TEXT) sigue en columna `page_access_token` por compat. Drop en migration posterior una vez confirmado que prod funciona con encrypted.

### 2026-05-27 — F3 sprint críticos performance

**Migration:** `packages/pase/supabase/migrations/202605271000_audit_f3_criticos.sql` (589ms, 4 smoke checks ✅)
**Reporte fuente:** [03-performance.md](./03-performance.md) (sub-reportes 03a/03b/03c).

10 fixes aplicados (de 15 críticos/altos totales — los 5 restantes son refactors arquitectónicos que dejé para después):

| # | Cambio |
|---|---|
| F3A#1 | Publication `supabase_realtime` de 42 → 20 tablas. Saqué 22 catálogos y master data (proveedores, config_categorias, medios_cobro, tenants, usuarios, etc.) que casi no cambian. Apunta al **#1 absoluto del workload DB** (Realtime publisher consumía ~7h CPU/día solo en publish WAL). |
| F3A#2 | Cron `fn_reactivar_items_vencidos` de `* * * * *` → `*/15 * * * *`. -92% invocaciones. |
| F3A#6 | `CREATE INDEX idx_movimientos_local_cuenta_activo` partial — el trigger `trg_sync_saldos_caja` baja de 0.47ms → <0.1ms y escala lineal con el local más grande. |
| F3A#10 | `CREATE INDEX idx_facturas_estado_venc` — bandeja vencidas baja a index scan. |
| F3A#15 | DROP 5 índices muertos: `idx_mp_mov_anulado_false` (368KB), `idx_mp_mov_release_date_released` (112KB), `idx_mp_mov_sin_justificar` (40KB), `idx_movimientos_anulado_false` (40KB), `idx_items_nombre_trgm` (72KB). |
| F3A#7 | Nueva RPC `aplicar_ncs_a_factura(p_ncs jsonb)` + refactor `Compras.tsx:520`. Antes: `for+await` con N round-trips. Ahora: 1 round-trip. |
| F3A#8 | Nueva RPC `anular_movimientos_batch(p_mov_ids[], p_motivo, p_override_code)` + refactor `RRHHLegajo.tsx:780`. Antes: `for+await` con N round-trips. |
| F3A#9 | `Caja.tsx:354` audit lookup ahora con `.ilike()` filter por id + `.limit(1)`. Antes traía TODA la auditoria EDICION (3.5k hoy, crece). |
| F3B#1+#3 | `packages/comanda/vite.config.ts`: `manualChunks` (vendor-react/supabase/radix/pwa/idb) + `chunkSizeWarningLimit` 1000 → 500. Apunta al index.js 765 KB monolítico. |
| F3B#2 | `packages/comanda/src/App.tsx`: routeWrappers (6 admin tabs, 1.882 LOC) pasaron a `lazy()` individual. |
| F3C#14 | `packages/comanda/src/lib/sync/syncEngine.ts`: pause `setInterval(30s)` cuando `document.hidden`. Antes una pestaña POS oculta tiraba 5 queries/30s indefinidamente. |

**No incluidos (refactors arquitectónicos para decisión / sprint dedicado):**
- F3A#11 `mp-process.js` UPDATE con `IS DISTINCT FROM` (necesita re-diseñar upsert logic con SELECT previo).
- F3C#5 `Caja.tsx` unificar 2 hooks Realtime + debounce conjunto.
- F3C#12 `useBandejaEntrada` consolidación a 1 RPC `fn_bandeja_resumen(user_id)`.
- F3C#13 catálogos (`useCategorias`/`useMediosCobro`/`usePuestosRRHH`) on-focus invalidation + BroadcastChannel cross-tab (en vez de Realtime permanente 24×7).
- Cache `pg_timezone_names` en JS const (580s CPU acumulada, fix de 30 min pero requiere identificar todos los date pickers).

### 2026-05-27 — F4 sprint críticos frontend

**Reporte fuente:** [04-frontend-pase.md](./04-frontend-pase.md) (sub-reportes 04a/04b/04c).

5 fixes aplicados de los 11 críticos totales (los 6 restantes son refactors arquitectónicos):

| # | Cambio |
|---|---|
| F4C#3 | DELETE 5 archivos dead code (~25 KB): `hooks/useFinanzas.ts`, `hooks/useNegocio.ts`, `lib/services/caja.service.ts` (tenía race condition C4-F11), `lib/services/rrhh.service.ts`, `lib/saldoMP.ts` + test. Removida carpeta `lib/services/` vacía. |
| F4C#1 | `utils.ts`: agregado `now()` (Date fresh) + `todayAR_ISO()` (string YYYY-MM-DD en zona AR). `today` const queda con JSDoc `@deprecated` apuntando al bug TZ. |
| F4C#1 (partial) | `useBandejaEntrada.ts`: `fetchFacturasVencidas` y `fetchFacturasPorVencer` migrados a `todayAR_ISO()`. Antes filtraban contra fecha UTC — entre 21:00-23:59 AR la lista mostraba el día siguiente. Migración del resto (~18 callers de `today`) queda gradual. |
| F4A#1 | `ConciliacionMP.tsx`: `setInterval(1s)` del countdown sync ahora se guarda en `syncIntervalRef` y se limpia en unmount + al resolverse. Antes seguía corriendo si el user navegaba fuera mientras sincronizaba → setState sobre componente desmontado. |
| F4A#2 | `Gastos.tsx`: `useEffect` de empleadosVisibles ahora con guard `isMounted` y `deps: [localActivo]`. Antes `deps=[]` no refrescaba al cambiar de local → empleados de locales anteriores quedaban en la lista (bug reportado 2026-05-20). |

**No incluidos (sprints dedicados):**
- F4C#2 migrar los 57 `.toISOString().slice(0,10)` UTC → AR (requiere análisis case-by-case).
- F4A#3 `RRHHLegajo.tsx:175` race vacTomadas (necesita rediseño del flow modal).
- F4A#4 `Usuarios.tsx:213` RPC atómica `sincronizar_permisos_usuario` (nueva RPC + refactor).
- F4C#8 helper money math centralizado (decidir Big.js vs custom + migrar 16+8 callers).
- F4C#9 `logError` backend + ErrorBoundary refactor (nuevo endpoint).
- F4B#1 estandarizar pattern `<Modal>` (24 archivos con overlay manual).
- F4B#2 migración 150 `alert/confirm/prompt` → toasts (rampa coordinada).
- Bug TZ resto de 18 callers de `today` + grep de patrones `new Date().toISOString().slice(0,10)`.

### 2026-05-27 — F5 sprint críticos COMANDA

**Reporte fuente:** [05-comanda.md](./05-comanda.md) (sub-reportes 05a páginas/servicios, 05b sync offline, 05c integraciones AFIP/delivery).

7 fixes aplicados (de 14 críticos totales — los 7 restantes requieren decisiones / refactors):

| # | Cambio |
|---|---|
| F5B#2 | `AuthPosProvider.tsx`: `logout()` ahora invoca `resetDb()` (lazy import). Antes IndexedDB conservaba data del user A → al loguearse user B se mezclaban ops cross-tenant. Riesgo de corrupción real cerrado. |
| F5B#3 | `pullInitial.ts::pullVentasAbiertas`: ahora **preserva ventas con `_local_dirty=true`** (cobradas offline sin sincronizar). Antes borraba TODAS al pullear — PoC: cajero cobra venta offline → otro cajero entra → la venta cobrada desaparecía y el server nunca la recibía. Items también filtran por venta padre dirty. |
| F5B#4 | `syncEngine.ts::runFullCycle`: pull y push ahora con try/catch independientes. Antes si pull fallaba (típico al caerse internet), push tampoco corría y las ops pending quedaban indefinidamente sin retry. |
| F5B#1 | `operations.ts`: nueva `resetSyncingOpsAtBoot()` invocada desde `syncEngine.start()`. Ops huérfanas en estado 'syncing' (de un crash anterior) se resetean a 'pending' para reintentarse. |
| F5A#2 | `pullIncremental.ts::pullVentasItemsIncremental`: agregado `.eq('local_id', ctx.localId)` explícito. Antes confiaba en RLS pero dueños con visibilidad cross-local recibían deltas de otros locales que terminaban en IndexedDB del local activo (mezcla al cambiar de local). |
| F5C#1 | `tienda-mp.js::handlePartnerWebhook`: wired `verifyRappiWebhookSignature` + `verifyPedidosYaWebhookSignature`. Antes los helpers existían pero terminaban con `void` al final del archivo — cualquiera podía inyectar pedidos POST al webhook. Modo soft-fail (warning) si el mapeo no tiene `webhook_secret` aún configurado; hard-fail si la firma viene presente pero inválida. |
| F5C#3 | `tienda-mp.js::handlePartnerWebhook`: chequeo de idempotency por `(provider, external_order_id)` antes del INSERT. Antes reenvíos de Rappi/Peya generaban `unique_violation` 500 → partner reintenta indefinidamente. Ahora respondo 200 + `idempotent_replay: true`. |

**No incluidos (decisiones / refactors):**
- F5C#2 AFIP recovery (CAE huérfano) — necesita decisión: ¿store request_uuid antes de pedir CAE? ¿rollback transaccional? Riesgo fiscal AR real.
- F5C#4 MP webhook itera todos los tenants — requiere coordinar frontend de checkout para que `preference` MP lleve `metadata.mp_credencial_id`.
- F5C#5 Print server local sin auth — decisión mecanismo (bearer token? client cert?).
- F5A#11 docs de sync engine montaje (validar primero si feature flag default ON es intencional).
- F5A#12 idempotency keys window 5s frágil — refactor.
- F5A#13 `_tempIdCounter` persistir en localStorage — refactor.
- F5A#14 VentaScreen god-object 1378 LOC — sprint dedicado de split.
- **Tests E2E del sync engine** — alta prioridad, sprint dedicado.

### 2026-05-27 — F6 sprint críticos bot IG + admin

**Migration:** `packages/pase/supabase/migrations/202605271100_audit_f6_ig_constraints.sql` (454ms, smoke ✅)
**Reporte fuente:** [06-bot-ig-admin-console.md](./06-bot-ig-admin-console.md) (sub-reportes 06a/06b).

5 fixes aplicados (= total de críticos):

| # | Cambio |
|---|---|
| F6A#1 | `webhook.js`: upsert de `ig_conversaciones` reemplazado por SELECT + INSERT condicional. Antes el upsert seteaba `estado='bot'` en cada DM nuevo → si el dueño tomaba la conversación como humano y el cliente seguía escribiendo, el bot reactivaba y respondía sobre lo que el humano había dicho. Ahora respeta el estado existente. |
| F6A#2 | `webhook.js`: implementado rate limit per-tenant antes de llamar a Claude. Lee `cfg.rate_limit_msgs` (default 30) y `cfg.rate_limit_minutos` (default 5). Si excede, skip respuesta + insert evento `rate_limit_hit` en `ig_eventos`. Antes esas columnas existían pero nunca se leían → 5000 DMs en 30s ≈ $150 USD sin tope. |
| F6A#3 | `packages/instagram-bot/vercel.json`: eliminado header global `Access-Control-Allow-Origin: *` que anulaba el allow-list de `_lib/cors.js`. Defense-in-depth restaurada. |
| F6A#4 | Migration `202605271100_audit_f6_ig_constraints.sql`: 5 CHECK constraints en `ig_config` (max_tokens 256-4096, contexto_mensajes 1-50, system_prompt ≤8000 chars, rate_limit_msgs 0-500, rate_limit_minutos 1-1440). Antes un dueño podía setear `max_tokens=200000` y disparar ~$3 USD por mensaje. |
| F2D #27 fase 2 | Misma migration F6: drop columna `page_access_token` plana de `ig_config`. Token IG ahora SOLO existe encrypted vía `get_ig_token` RPC. `webhook.js` actualizado para no usar fallback. |
| F6B#1 | `admin-console/src/pages/Tenants.tsx`: botón "Ver como tenant" OCULTO (`hidden` CSS) hasta implementar el handler `?as=<uuid>` en PASE. Antes Lucas clickeaba "Ver" y el botón abría URL que PASE nunca leía — silently broken. |

**No incluidos (decisiones / sprints dedicados):**
- F6A#5 prompt caching en `_lib/claude.js` (5x más caro de lo necesario, no es crítico).
- F6A#6 rate limit + cap `max_tokens` en `/api/claude` proxy de PASE.
- F6A#7 fix multi-account OAuth (vincular 2da cuenta IG corrompe token).
- F6A#8 CHECK constraint `ig_mensajes.tipo` para cubrir `file/template/fallback`.
- F6A#9 tests del bot (cero tests en 1945 LOC con manejo de dinero).
- F6B `toggleActivo` tenant con audit (RPC nueva `fn_set_tenant_activo`).
- F6B UI eliminar/restaurar tenant (Lucas hoy usa scripts a mano).
- `diagnostic.js` info disclosure (sigue exponiendo first4+last4 de secrets).

---

**Última actualización:** 2026-05-27
