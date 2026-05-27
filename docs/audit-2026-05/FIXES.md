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

---

**Última actualización:** 2026-05-27
