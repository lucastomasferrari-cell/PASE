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

---

**Última actualización:** 2026-05-27
