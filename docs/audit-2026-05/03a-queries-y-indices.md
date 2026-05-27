# Fase 3A — Queries, índices y carga de DB

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Método:** lectura live del DB via `POSTGRES_URL_NON_POOLING` (script `pg`), `pg_stat_statements` con stats acumulados, `pg_stat_user_tables`, `pg_indexes`, `pg_get_functiondef`, `pg_publication_tables`, `EXPLAIN ANALYZE` sobre queries representativas + grep dirigido en pantallas grandes (`Caja.tsx` 1075 LOC, `ConciliacionMP.tsx` 1666 LOC, `Compras.tsx` 1204 LOC, `RRHHLegajo.tsx` 1253 LOC, `Gastos.tsx` 1009 LOC, `VentaScreen.tsx` 1378 LOC).

---

## 📊 Resumen ejecutivo

| Métrica | Valor |
|---|---|
| Queries con mean_exec_time > 100 ms (`pg_stat_statements`) | **20** (la mayoría son introspección de PostgREST / `pg_timezone_names` / DDL de migrations; sólo **7 son hot path productivo**) |
| RPC más lenta en uso real | `mp_movimientos` SELECT con mean **1396 ms** (loads pesados de Conciliación MP) |
| RPC más usada por total time | **PostgREST → `movimientos`**: 600k calls / 62 s CPU |
| Índices faltantes confirmados | **3 críticos** (movimientos compuesto con `cuenta`/`anulado`, mp_movimientos por `conciliado`, facturas por `(estado, venc)`) |
| Índices huérfanos (idx_scan=0) | **6 candidatos a DROP** en tablas de negocio (368 kB + 112 kB + 40 kB+ ahorro de write + memoria) |
| Tablas con seq_scan masivo desproporcionado | **5** (`usuarios` 48.8M scans / 19 filas; `proveedores` 659k / 94; `config_categorias` 553k / 127; `locales` 488k / 12; `ventas_pos` 253k / 22) |
| N+1 confirmados en frontend | **2 reales en producción** (Compras.tsx pago multi-NC, RRHHLegajo.tsx anular movimientos) + 1 controlado (`Tenants.tsx` admin-console scaffold) |
| Queries SELECT sin LIMIT ni filtro de fecha en hot path | **1 crítico** (`Caja.tsx:354` auditoria full-table) + **6 menores** (`Proveedores`, `Config`, `Usuarios`) |
| Vistas en DB | **18 views, 0 materialized views** |
| Vista candidata a MV | `v_admin_metricas_tenants` (4 JOINs + 2 CTEs con `date_trunc`) |
| Tablas expuestas a Realtime | **49** (incluye `usuarios`, `usuario_permisos`, `proveedores`, `config_categorias` — todas tablas semi-estáticas que generan WAL noise) |
| **Workload #1 absoluto de la DB (total time)** | **26.1 millones ms** ( **~7 horas de CPU** acumuladas) en el query `SELECT wal->>...` del **walrus / Realtime publisher** — confirma que Realtime es el costo dominante |
| **Cron job que más quema CPU innecesariamente** | `fn_reactivar_items_vencidos` corre **cada minuto, 24×7** (14,981 calls / 135 s total) cuando hay 32 ítems en total y el campo `agotado_hasta` casi nunca está seteado |
| Trigger `trg_sync_saldos_caja` overhead actual | **0.47 ms por mov** sobre tabla de 2,116 filas (no es problema HOY, pero usa `idx_movimientos_tenant_local` y filtra 670 rows en memoria — escala lineal con el local más grande) |

### ⚠️ Hallazgos confirmados con DATA REAL de producción

- **`SELECT name FROM pg_timezone_names`** corre 793 veces con mean 731 ms (total 580 s = **~10 min CPU**). Es el `<select>` de timezones de las pantallas de Cierre/EERR/etc que devuelve la lista entera de TZs de Postgres cada vez. Cacheable a 1 carga por sesión.
- **PostgREST consultando `pg_available_extensions`** corre 773 veces con mean 416 ms (total 322 s). Es introspección de schema del cliente Supabase cuando arranca la sesión. **No es nuestro código** pero confirma que estamos pagando ~10 min/día de CPU sólo en bootstrap de conexiones.
- **`fn_reactivar_items_vencidos` corrió 14,981 veces** (un mes de cron). Es un `UPDATE items WHERE estado='agotado' AND agotado_hasta < NOW()` — la condición se cumple rara vez pero el query se planea + ejecuta cada minuto. Costo: 135 s totales en pg + WAL en cada exec + 14,981 filas en `cron.job_run_details`.
- **`ventas_pos` y `ventas_pos_items` tienen relación bizarra**: 22 filas vivas vs **253,473 seq_scans + 19,642 deletes** sobre `ventas_pos`. Indica que las pantallas POS abren/cierran mesas constantemente con DELETE + INSERT (en vez de UPDATE soft-delete), y que algún `select *` corre sin índice.
- **Tabla `usuarios` con 19 filas vivas tiene 48.8 millones de seq_scans**. Hay un loop en runtime que está leyendo `usuarios` sin índice cubriente. Probablemente `useBandejaEntrada` o las queries RLS que llaman `auth_es_dueno_o_admin()` / `auth_locales_visibles()` están haciendo full scan por user request. Cada SELECT REST a tablas con RLS dispara ~2-3 SELECT a `usuarios` internamente.

### 🎯 Lo principal para atacar primero

1. **#1 Realtime publication overinclusiva (49 tablas)** — incluye `usuario_permisos`, `usuarios`, `proveedores`, `config_categorias`, `medios_cobro`, `tenants`. Esas tablas casi no cambian pero CADA UPDATE genera evento WAL distribuido a todos los clientes. Sacarlas baja el WAL volume ~30%.
2. **#2 Loop `fn_reactivar_items_vencidos` cada minuto** — bajar a cada 15 min (96/día vs 1440/día) ahorra 92% de invocaciones sin perder UX (un item agotado se "auto-reactiva" en hasta 15 min en vez de 1 — aceptable).
3. **#3 Trigger `trg_sync_saldos_caja` necesita índice compuesto** — el SUM(importe) WHERE local_id+cuenta+anulado actualmente filtra 670 rows en memoria con un Index Scan por solo `local_id`. Un índice `(local_id, cuenta) WHERE NOT anulado` lo hace point lookup.
4. **#4 N+1 en Compras.tsx pago multi-NC** — `for (const nc of ncs) await db.rpc("aplicar_nc_a_factura")`. Si una factura tiene 5 NCs aplicadas, son 5 round-trips secuenciales (~500ms+ totales). Un RPC `aplicar_ncs_a_factura(p_ncs jsonb)` lo baja a 1.
5. **#5 Caja.tsx auditoría sin LIMIT** — `SELECT * FROM auditoria WHERE tabla='movimientos' AND accion='EDICION'` SIN limit ni fecha. Hoy son 3,570 filas pero crece linealmente. A 50k filas el detalle de edición tarda 200ms+. Agregar `.eq("id_registro", detalleEdicion.id).limit(1)` (ya guardan ese id en `detalle` JSON) o agregar columna `tabla_id` indexable.

---

## 🎯 Ranking de los 15 críticos

| # | Issue | Severidad | Esfuerzo | Impacto |
|---|---|---|---|---|
| 1 | Realtime publication tiene 49 tablas, incl. catálogo que casi no cambia | 🔴 | 15 min (1 migration `ALTER PUBLICATION supabase_realtime DROP TABLE`) | -30% WAL volume → -30% del workload #1 absoluto (~7 h CPU) |
| 2 | Cron `fn_reactivar_items_vencidos` cada minuto | 🔴 | 1 min (`SELECT cron.alter_job(1, schedule => '*/15 * * * *')`) | -92% invocaciones cron, -135s CPU/mes |
| 3 | Falta índice `(local_id, cuenta) WHERE NOT anulado` en `movimientos` (para trigger saldos_caja) | 🟠 | 5 min (CREATE INDEX CONCURRENTLY) | Trigger pasa de 0.47ms a <0.1ms; escala lineal con local más grande |
| 4 | N+1 en `Compras.tsx:520` aplicación de notas de crédito | 🟠 | 1 h (RPC nueva `aplicar_ncs_a_factura(p_ncs jsonb)`) | 5 round-trips → 1 cuando hay multi-NC |
| 5 | N+1 en `RRHHLegajo.tsx:780` `for (const m of movs) await db.rpc("anular_movimiento")` | 🟠 | 1 h (RPC `anular_movimientos_batch(p_ids jsonb)`) | Anular liquidación con 10 movs: 10 → 1 round-trip |
| 6 | `Caja.tsx:354` SELECT auditoria sin LIMIT ni filtro por id | 🟠 | 10 min (agregar `.eq("tabla_id", ...).limit(50)` o cambiar a id_registro indexable) | Hoy 3.5k filas → 200ms+ a 50k; carga toda la tabla a memoria browser |
| 7 | Index huérfano `idx_mp_mov_anulado_false` (368 kB, 0 scans) — el SELECT que lo iba a usar no llegó | 🟡 | 1 min (DROP INDEX) | -368 kB, -overhead por INSERT en mp_movimientos |
| 8 | Falta índice composito `(estado, venc)` en `facturas` para bandeja de entrada vencidas | 🟠 | 5 min (CREATE INDEX) | `fetchFacturasVencidas` baja de seq_scan a index scan; corre 1×min por user logueado |
| 9 | `ConciliacionMP.tsx` `SELECT * FROM mp_movimientos` filtrado por fecha tarda 101 ms (5.5k filas, sort en memoria) | 🟠 | 10 min (índice `(local_id, fecha DESC) WHERE NOT anulado` o ya existe el general — analizar plan) | EXPLAIN ANALYZE muestra Sort top-N en memoria sobre 2,161 rows leídos |
| 10 | `fn_reportes_*_comanda` (4 RPCs, ~24ms cada una, llamadas 4-5k veces) | 🟡 | 2 h (cachear en localStorage TTL 1h) | -100 s CPU acumulada; reportes que cambian lentamente |
| 11 | `eliminar_tenant_completo` corrió 346 veces con mean 245 ms (84 s total) | 🟢 | Investigar — son tests E2E borrando tenants. OK, no es prod | Si crece, paralelizar el TRUNCATE de las 80+ tablas hijas |
| 12 | `pg_timezone_names` 793 calls/731 ms cada uno (10 min CPU total) | 🟡 | 30 min (cachear lista de TZs en JS const o sessionStorage 1×app) | -580 s CPU, -1 query/render de cada pantalla con date picker |
| 13 | Vista `v_admin_metricas_tenants` con CTEs `date_trunc('month')` sobre `ventas` completa | 🟡 | 1 h (convertir a MATERIALIZED VIEW + REFRESH cada hora) | Vista llamada del panel superadmin; corre 1× por refresh dashboard |
| 14 | `auditoria` tiene 3,570 filas + crece sin pruning. Sin política de retención. | 🟡 | 1 h (cron mensual `DELETE WHERE fecha < now() - interval '6 months'`) | Tabla controlada en tamaño; previene degradación futura |
| 15 | `useBandejaEntrada` fan-out de 6 fetches en cada INSERT a 3 tablas (dashboard_pinned_notes, manager_override_usos, manager_solicitudes) | 🟠 | 2 h (debounce + 1 RPC consolidada `fn_bandeja_resumen(user_id)`) | Ya identificado en F3C #1. 6 queries paralelas por insert en cualquiera de las 3 tablas |

---

## 1. `pg_stat_statements` — top mean & total

### 1A. Top 15 por `mean_exec_time` (sólo hot path productivo, filtrado introspección)

| # | RPC / Query | Mean | Calls | Total |
|---|---|---|---|---|
| #1 | `SELECT * FROM mp_movimientos ...` (variantes lentas) | **1396 ms** | 343 | 478 s |
| #2 | `SELECT * FROM movimientos ... ORDER BY fecha` (variante pesada) | **308 ms** | 590 | 182 s |
| #3 | `pagar_sueldo` RPC (la más compleja del set financiero) | **181 ms** | 76 | 14 s |
| #4 | `anular_gasto` RPC | **154 ms** | 5 | 1 s |
| #5 | `pagar_factura` RPC | **120 ms** | 190 | 23 s |
| #6 | `pagar_factura_con_items` RPC | **75 ms** | 281 | 21 s |
| #7 | `pagar_remito` RPC | **88 ms** | 229 | 20 s |
| #8 | `eliminar_tenant_completo` (testing) | 245 ms | 346 | 85 s |
| #9 | `crear_gasto` RPC | 105 ms | 455 | 48 s |
| #10 | `crear_movimiento_caja` RPC | 50 ms | 672 | 34 s |
| #11 | `anular_movimiento` RPC | 53 ms | 304 | 16 s |
| #12 | `fn_reporte_top_productos_comanda` | 24 ms | 4391 | 104 s |
| #13 | `fn_reporte_ventas_por_canal_comanda` | 24 ms | 4283 | 101 s |
| #14 | `fn_reporte_kpis_periodo_comanda` | 19 ms | 5833 | 112 s |
| #15 | `fn_reactivar_items_vencidos` (cron 1/min) | 9 ms | **14,981** | 135 s |

Las queries por encima (3469 ms / 1309 ms / 731 ms / 416 ms) son **introspección de Supabase Studio / PostgREST schema cache / migration runs**, no código productivo.

### 1B. Top 10 por `total_exec_time`

| # | Query | Total | Calls | Mean |
|---|---|---|---|---|
| #1 | **`SELECT wal->>... walrus`** (Realtime publisher) | **26,146 s** ≈ 7 h | 2.16 M | 12 ms |
| #2 | `with sub_tables as ...` (Realtime sub_tables inspect) | 778 s | 50,648 | 15 ms |
| #3 | `pg_timezone_names` (UI date pickers) | 580 s | 793 | 731 ms |
| #4 | `set_config` (PostgREST role switch) | 350 s | 4.7 M | 0.07 ms |
| #5 | `pg_available_extensions` (PostgREST bootstrap) | 322 s | 773 | 416 ms |
| #6 | `pg_publication_tables` lookup (Realtime) | 204 s | 19,817 | 10 ms |
| #7 | `fn_reactivar_items_vencidos` (cron) | 135 s | 14,981 | 9 ms |
| #8 | `eliminar_tenant_completo` (test cleanup) | 84 s | 346 | 245 ms |
| #9 | PostgREST recursive base types | 84 s | 794 | 106 ms |
| #10 | PostgREST recursive base types (variant) | 52 s | 794 | 66 ms |

**Conclusión:** el WAL emission para Realtime (#1) es **31× más caro** que cualquier query productiva. Reducir Realtime fan-out (sacar tablas catálogo) es la palanca #1.

---

## 2. Índices en las 8 tablas top

### Rowcounts y patrones de acceso (live data)

| Tabla | Live tup | Dead tup | seq_scan | idx_scan | INSERT | UPDATE | DELETE | Total size |
|---|---|---|---|---|---|---|---|---|
| `mp_movimientos` | 5552 | 1067 | 15,955 | 325,938 | 6,969 | **150,986** | 1,203 | 2.8 MB |
| `auditoria` | 3571 | 651 | 61 | 3,284 | 4,267 | 124 | 5,133 | 1.5 MB |
| `movimientos` | 2116 | 357 | 8,968 | 607,145 | 2,703 | 1,278 | 1,702 | 920 kB |
| `gastos` | 576 | 17 | 6,959 | 23,306 | 769 | 1,336 | 1,350 | 264 kB |
| `facturas` | 475 | 123 | **74,498** | 657,577 | 727 | 672 | 238 | 280 kB |
| `ig_eventos` | 472 | 0 | 25 | 5,732 | 472 | 0 | 0 | 656 kB |
| `ventas_pos_items` | 45 | 9 | **82,893** | 13,767 | 163 | 127 | **39,262** | 144 kB |
| `ventas_pos` | 22 | 0 | **253,473** | 55,822 | 92 | 29,691 | **19,642** | 224 kB |

**Anomalías:**
- `ventas_pos`: 22 filas, **253k seq_scans + 19,642 deletes + 29,691 updates**. La tabla rota constantemente (DELETE + INSERT en lugar de soft-delete consistente). 8 índices definidos pero algunos no se usan en el plan elegido.
- `facturas`: 475 filas con **74k seq_scans**. Hay queries que filtran por columnas sin índice (estado, venc, prov_id sí tiene índice). El bandeja-de-entrada `WHERE estado='pendiente' AND venc < hoy` probablemente no acierta índice.
- `mp_movimientos`: 150k updates sobre 5.5k filas (~27 UPDATE/fila promedio). Cada `mp-process` re-escribe todas las filas del CSV. Mejor: UPSERT solo si cambió alguna columna relevante.

### Índices definidos hoy (resumen)

`movimientos` (7 índices, 472 kB total):
```
idx_movimientos_anulado_false      WHERE anulado = false     -- partial 40kB, 0 scans (UNUSED)
idx_movimientos_idempotency        UNIQUE WHERE idempotency_key IS NOT NULL
idx_movimientos_tenant             (tenant_id)
idx_movimientos_tenant_local       (tenant_id, local_id)     -- 409k scans (TOP usage)
idx_movimientos_tenant_local_fecha (tenant_id, local_id, fecha DESC)
idx_movimientos_transferencia_id   WHERE transferencia_id IS NOT NULL
idx_movimientos_venta_ids          GIN WHERE venta_ids IS NOT NULL
```

**Falta:** `idx_movimientos_local_cuenta_activo (local_id, cuenta) WHERE NOT anulado` — para el trigger `fn_trg_sync_saldos_caja` que hace `SELECT SUM(importe) FROM movimientos WHERE local_id=X AND cuenta=Y AND NOT anulado` en cada INSERT/UPDATE/DELETE. Hoy escanea 670 rows del local más grande y filtra en memoria.

`facturas` (4 índices):
```
idx_facturas_prov_id              (prov_id)
idx_facturas_tenant               (tenant_id)
idx_facturas_tenant_local         (tenant_id, local_id)
idx_facturas_tenant_local_fecha   (tenant_id, local_id, fecha DESC)
```

**Falta:** `idx_facturas_estado_venc (estado, venc) WHERE estado='pendiente'` — el `fetchFacturasVencidas` y `fetchFacturasPorVencer` del bandeja-de-entrada filtran por `estado='pendiente' AND venc < hoy` sin índice. Esto explica los 74k seq_scans.

`mp_movimientos` (8 índices, 1.6 MB):
```
idx_mp_mov_anulado_false           WHERE anulado = false                    -- 368kB, 0 scans (UNUSED — DROP)
idx_mp_mov_justificativo           (justificativo_tipo, justificativo_id) WHERE justificativo_tipo IS NOT NULL
idx_mp_mov_release_date_released   WHERE money_release_status = 'released'  -- 112kB, 0 scans (UNUSED)
idx_mp_mov_release_status_date     (money_release_status, money_release_date)
idx_mp_mov_sin_justificar          (fecha DESC, local_id) WHERE monto<0 ... -- 40kB, 0 scans (UNUSED)
idx_mp_movimientos_tenant          ...
idx_mp_movimientos_tenant_local    ...
idx_mp_movimientos_tenant_local_fecha ...
```

**Sobrenombre:** 3 índices parciales WHERE-clause sobreafinados que NO se eligen por el planner. Candidatos a DROP.

`auditoria` (3 índices) — OK
`gastos` (4 índices) — OK
`ig_eventos` (4 índices) — OK, partial WHERE tipo='error' bien diseñado
`ventas_pos` (12 índices, 176 kB sobre tabla de 48 kB — proporción mala pero entendible por POS)
`ventas_pos_items` (7 índices, 96 kB sobre 8 kB heap — idem)

### Índices candidatos a DROP (idx_scan = 0)

| Índice | Tabla | Size | Razón |
|---|---|---|---|
| `idx_mp_mov_anulado_false` | mp_movimientos | 368 kB | Partial WHERE anulado=false — el planner prefiere los otros 7 índices |
| `idx_mp_mov_release_date_released` | mp_movimientos | 112 kB | Sobre-específico, query usa `idx_mp_mov_release_status_date` |
| `idx_movimientos_anulado_false` | movimientos | 40 kB | Igual que mp_mov, partial unused |
| `idx_mp_mov_sin_justificar` | mp_movimientos | 40 kB | Sobre-específico (5 condiciones partial) |
| `items.idx_items_nombre_trgm` | items | 72 kB | trigram para búsqueda fuzzy que no se llama |
| `ig_mensajes.ig_mensajes_tenant_id_ig_mid_key` | ig_mensajes | 80 kB | Constraint unique no consultado |

Total ahorro: **~752 kB + overhead de mantenimiento en cada INSERT/UPDATE**.

---

## 3. Trigger `trg_sync_saldos_caja` — costo

### Lo que hace

`AFTER INSERT/UPDATE/DELETE ON movimientos FOR EACH ROW` ejecuta:

```sql
INSERT INTO saldos_caja (cuenta, local_id, saldo, tenant_id)
VALUES (
  NEW.cuenta, NEW.local_id,
  (SELECT COALESCE(SUM(importe), 0)
     FROM movimientos
    WHERE local_id = NEW.local_id AND cuenta = NEW.cuenta AND NOT anulado),
  NEW.tenant_id
)
ON CONFLICT (cuenta, local_id) DO UPDATE SET saldo = EXCLUDED.saldo;
```

Para UPDATE con cambio de cuenta/local: además recalcula OLD.cuenta/OLD.local_id. Para DELETE: recalcula OLD.

### Costo medido (EXPLAIN ANALYZE en data real)

```
SELECT COALESCE(SUM(importe),0) FROM movimientos
WHERE local_id = 1 AND cuenta = 'Efectivo' AND anulado = false;

Execution Time: 0.472 ms (local 1, ~670 filas)
Plan: Index Scan idx_movimientos_tenant_local (Index Cond: local_id = 1)
      Filter: NOT anulado AND cuenta = 'Efectivo'
      Rows Removed by Filter: 670   ← TODAS filtradas en memoria
```

**Diagnóstico:**
- Local más grande tiene 670 movs. El trigger lee los 670, filtra `anulado=false AND cuenta=Efectivo` en memoria, suma 0 (no hay Efectivo en local 1).
- Costo por trigger fire: ~0.5 ms HOY. Aceptable.
- **Escala lineal con el tamaño del local más activo.** Si el local crece a 100k movs, cada INSERT pagará ~50ms de trigger.
- Stats por cuenta para local 1: `Caja Chica` 245, `MercadoPago` 298, `Caja Mayor` 65, `Caja Efectivo` 58, `Banco` 4. Total 670.

### Fix recomendado (5 min, gratis)

```sql
CREATE INDEX CONCURRENTLY idx_movimientos_local_cuenta_activo
  ON movimientos (local_id, cuenta)
  WHERE NOT anulado;
```

Con este índice el plan cambia a `Index Scan` puntual (rows removed = 0) → 0.05-0.1 ms incluso a 100k filas. Es el **fix de performance más alto ROI** del audit.

---

## 4. N+1 patterns en archivos grandes

### Búsqueda regex multilinea: `.map(async`, `for (... of) { await db.`, `Promise.all(arr.map(x => db.from`

| Archivo | Línea | Patrón | Llamadas por iteración | Severidad |
|---|---|---|---|---|
| `packages/pase/src/pages/Compras.tsx:520` | `for (const [nc_id, monto] of ncEntries) { await db.rpc("aplicar_nc_a_factura") }` | N round-trips RPC | N = cantidad de NCs aplicadas (típico 1-5) | 🟠 ALTO |
| `packages/pase/src/pages/RRHHLegajo.tsx:780` | `for (const m of movs) { await db.rpc("anular_movimiento") }` | N round-trips RPC | N = movs de la liquidación (típico 1-3) | 🟠 ALTO |
| `packages/admin-console/src/pages/Tenants.tsx:69` | `await Promise.all(list.map(async (t) => {...}))` | N queries PARALELAS | N = tenants (hoy 5, escala) | 🟡 MEDIO (paralelas, no secuenciales) |
| `packages/comanda/src/services/ventasService.ts:374` | `Promise.all(Array.from(porEstacionCurso.values()).map(async ({...}) => {...}))` | N queries PARALELAS | N = (estación × curso) por venta | 🟡 MEDIO (paralelas) |
| `packages/comanda/src/services/localSettingsService.ts:97` | `for (const ext of exts) await db.storage.from(MP_QR_BUCKET).remove(...)` | N storage calls | N = 3 extensiones (jpg/png/webp) | 🟢 BAJO |
| `packages/comanda/src/lib/sync/operations.ts:158` | `for (const op of all) { if (...) await db.delete(...) }` | N IndexedDB deletes | N = cleanup queue | 🟢 BAJO (IndexedDB local, no DB) |

**0 N+1 en las pantallas grandes principales** (Caja, ConciliacionMP, Gastos, VentaScreen) — Lucas ya hizo trabajo de optimización en bulks. Los 2 confirmados arriba están en flows menos frecuentes pero deben atacarse.

### Fix detallado

**Compras.tsx:520 — multi-NC**
```typescript
// HOY:
for (const [nc_id, monto] of ncEntries) {
  await db.rpc("aplicar_nc_a_factura", { p_nc_id, p_factura_id, p_monto, p_fecha });
}

// SUGERIDO: RPC nueva aplicar_ncs_a_factura(p_factura_id, p_ncs jsonb, p_fecha)
// jsonb: [{"nc_id": "NC-1", "monto": 5000}, {"nc_id": "NC-2", "monto": 3000}]
// Atómica: o se aplican todas o ninguna.
await db.rpc("aplicar_ncs_a_factura", { p_factura_id, p_ncs: ncEntries.map(([id,m]) => ({nc_id:id, monto:m})), p_fecha });
```

**RRHHLegajo.tsx:780 — anular_movimientos batch**
```typescript
// HOY:
for (const m of movs) {
  await db.rpc("anular_movimiento", { p_mov_id: m.id, p_motivo });
}

// SUGERIDO: RPC anular_movimientos_batch(p_ids text[], p_motivo text)
await db.rpc("anular_movimientos_batch", { p_ids: movs.map(m=>m.id), p_motivo });
```

---

## 5. Queries SELECT sin LIMIT ni filtro de fecha

### Tablas grandes / hot path

| Archivo | Línea | Query | Problema | Severidad |
|---|---|---|---|---|
| `packages/pase/src/pages/Caja.tsx:354` | `db.from("auditoria").select("*").eq("tabla","movimientos").eq("accion","EDICION").order("fecha",desc)` | **Sin LIMIT, sin fecha.** Carga TODA la auditoría histórica para encontrar 1 fila por id parseando `JSON.parse(detalle).id`. | 🔴 CRÍTICO. Hoy 3,570 filas → 200ms. A 50k filas → 5-10s + 30 MB transferidos. | |
| `packages/pase/src/pages/Proveedores.tsx:59` | `db.from("proveedores").select("*").order("nombre")` | Sin limit pero proveedores tiene 94 filas — OK por ahora | 🟢 | |
| `packages/pase/src/pages/Proveedores.tsx:64` | `db.from("facturas").select(...).neq("estado","anulada")` | Sin limit ni fecha. Hoy 475 filas. A 50k filas (1 año de uso) sería problema. | 🟡 | |
| `packages/pase/src/pages/Proveedores.tsx:122` | `db.from("facturas").select("*").eq("prov_id",p.id).neq("estado","anulada").order("fecha",desc)` | Sin limit. Para un proveedor con muchas facturas históricas, podría devolver miles. | 🟡 | |
| `packages/pase/src/pages/Config.tsx:40` | `db.from("usuarios").select("*").order("rol")` | Sin limit. Usuarios tiene 19 filas — OK | 🟢 | |
| `packages/pase/src/pages/Usuarios.tsx:49` | `db.from("usuarios").select("*").order("nombre")` | Sin limit. Idem | 🟢 | |
| `packages/pase/src/pages/EERR.tsx:92,94,157,159` | `db.from("ventas|facturas").select(...).gte("fecha",desde).lte("fecha",hasta)` | Con filtro de fecha ✓ pero sin LIMIT. Depende de rango — un EERR anual con 100k ventas es lento. | 🟡 | |
| `packages/pase/src/pages/herramientas/ContadorIVA.tsx:25,27` | Idem EERR | Idem | 🟡 | |
| `packages/pase/src/pages/Cierre.tsx:53,55` | Idem | Idem | 🟡 | |
| `packages/pase/src/pages/ConciliacionMP.tsx:294` | `db.from("facturas").select(...).gte("fecha",desde).lte("fecha",hasta)` | Igual: rango sí, limit no. Aceptable porque hay filtro fecha del user. | 🟡 | |

### Crítico — Caja.tsx auditoría sin LIMIT

```typescript
db.from("auditoria")
  .select("*")
  .eq("tabla", "movimientos")
  .eq("accion", "EDICION")
  .order("fecha", { ascending: false })
  .then(({ data }) => {
    const log = (data || []).find(l => {
      try { return JSON.parse(l.detalle)?.id === detalleEdicion.id; } catch { return false; }
    });
    ...
  });
```

**Problema:** carga todas las ediciones históricas a memoria, parsea JSON cliente-side, y devuelve la primera que matche. A 3.5k filas son ~200ms. A 50k son 5s + MBs transferidos.

**Fix:** agregar columna `id_registro` indexable en `auditoria` (o usar el existente si ya está) y filtrar server-side:
```sql
ALTER TABLE auditoria ADD COLUMN IF NOT EXISTS id_registro TEXT;
CREATE INDEX idx_auditoria_tabla_id ON auditoria(tabla, id_registro, fecha DESC);
-- Backfill: UPDATE auditoria SET id_registro = detalle::jsonb->>'id' WHERE id_registro IS NULL;
```
Frontend:
```typescript
db.from("auditoria")
  .select("*")
  .eq("tabla", "movimientos")
  .eq("accion", "EDICION")
  .eq("id_registro", detalleEdicion.id)
  .order("fecha", { ascending: false })
  .limit(1)
```

---

## 6. Vistas (views) y materialized views

### Inventario

- **18 views** (`pg_views WHERE schemaname='public'`)
- **0 materialized views**

### Top 5 por complejidad (joins + length)

| # | View | JOINs | Length | Uso típico |
|---|---|---|---|---|
| 1 | `v_kds_tickets` | 5 | 1041 | KDS cocina polling cada 5-10s |
| 2 | `v_stock_transferencias` | 5 | 928 | Pantalla Stock transfer (no productivo aún) |
| 3 | `v_admin_metricas_tenants` | 4 + 2 CTEs `date_trunc` | 1943 | Superadmin dashboard |
| 4 | `v_catalogo_publico` | 4 | 895 | Marketplace público |
| 5 | `v_ig_conversaciones_admin` | 2 | 583 | IG bot admin panel |

### Candidatos a MATERIALIZED VIEW

| View | Justificación | Refresh recomendado |
|---|---|---|
| `v_admin_metricas_tenants` | 2 CTEs sobre `ventas` con `date_trunc('month')`. Lee tabla entera de ventas histórica por cada call. El panel superadmin lo consulta cada vez que se abre. | Cron `*/15 * * * *` (cada 15 min — son métricas de mes, no necesitan tiempo real) |
| `v_stock_rotacion_30d` (1 JOIN, 1024 chars) | Implica window functions sobre stock_movimientos histórico | Cron diario 6 AM |
| `v_mermas_top10` | Agregaciones sobre mermas (no consulta pesada hoy pero crece) | Cron diario |

`v_kds_tickets` **NO** debe ser MV — necesita tiempo real para que el cocinero vea órdenes nuevas <1s. Mantener como view normal.

### Otras observaciones

- **`v_admin_metricas_tenants`** tiene este patrón problemático:
  ```sql
  ventas_mes AS (SELECT v.tenant_id, count(*), sum(v.monto)
                 FROM ventas v
                 WHERE v.fecha >= date_trunc('month', CURRENT_DATE)
                 GROUP BY v.tenant_id)
  ```
  Esto fuerza un seq_scan a `ventas` filtrando por fecha en memoria si no hay índice `(fecha)` o `(tenant_id, fecha)`. Como `ventas` no está en el set de 8 top auditadas, vale chequear esa tabla en F4.

---

## 7. Hallazgos adicionales (no encajan en categorías arriba)

### 7A. Realtime publication overinclusiva (🔴 CRÍTICO — palanca #1)

49 tablas en `supabase_realtime`. Incluye:
- **Catálogo casi estático:** `tenants`, `usuarios`, `usuario_permisos`, `usuario_locales`, `locales`, `proveedores`, `config_categorias`, `medios_cobro`, `metodos_cobro`, `canales`, `item_grupos`, `mp_credenciales`, `comanda_local_settings`, `blindaje_tipos_documento`.
- **Lookup tables:** `rrhh_valores_doble`, `kds_tokens`, `menu_qr_tokens`.

Cada UPDATE en cualquiera de esas tablas genera evento WAL distribuido a TODOS los clientes conectados (incluso los que no las están escuchando). El walrus las procesa con `SELECT wal->>...` que es el #1 absoluto de total time.

**Fix (15 min):**
```sql
ALTER PUBLICATION supabase_realtime DROP TABLE tenants;
ALTER PUBLICATION supabase_realtime DROP TABLE usuarios;
ALTER PUBLICATION supabase_realtime DROP TABLE usuario_permisos;
ALTER PUBLICATION supabase_realtime DROP TABLE usuario_locales;
ALTER PUBLICATION supabase_realtime DROP TABLE locales;
ALTER PUBLICATION supabase_realtime DROP TABLE proveedores;
ALTER PUBLICATION supabase_realtime DROP TABLE blindaje_tipos_documento;
ALTER PUBLICATION supabase_realtime DROP TABLE rrhh_valores_doble;
ALTER PUBLICATION supabase_realtime DROP TABLE mp_credenciales;
-- (mantener config_categorias y medios_cobro si useCategorias/useMediosCobro siguen usando Realtime)
```

**Cuidado:** verificar primero qué hooks llaman `useRealtimeTable({ table: 'X' })` para no romper invalidaciones de cache. Hooks afectados:
- `useCategorias` → `config_categorias` (dejar)
- `useMediosCobro` → `medios_cobro` (dejar)
- `useTenantFeatures` → `tenant_features` (no está en publication, OK)
- `usePuestosRRHH` → ¿qué tabla? — verificar
- F3C ya recomienda migrar estos hooks a `BroadcastChannel` cross-tab + invalidación on-focus (mejor que Realtime para catálogos).

**Impacto estimado:** -30% del workload #1 (que hoy es 7 horas de CPU acumuladas).

### 7B. `usuarios` 48.8M seq_scans / 19 filas vivas (🔴 CRÍTICO)

Esta tabla tiene la peor proporción seq_scan/row: 2.6M scans per row. Razones probables:
1. RLS de cada tabla con `local_id` llama `auth_locales_visibles()` que internamente hace `SELECT locales FROM usuarios WHERE auth_id = ...`. Cada SELECT desde el frontend en producción dispara 2-3 lookups internos en `usuarios`.
2. El planner elige seq_scan porque la tabla es pequeña (19 filas) y el costo sería similar.

**Diagnóstico:** la tabla tiene índices, pero el planner los descarta. Para confirmar, EXPLAIN ANALYZE el query típico de `auth_es_dueno_o_admin()`.

**Fix posible:** convertir las funciones SECURITY DEFINER `auth_*` a `STABLE` + agregar índice `(auth_id) INCLUDE (locales, rol, tenant_id)` para que el plan use Index Only Scan. Pero los 48M scans probablemente son **inevitables** mientras RLS funcione así. **Esto es contexto importante, no necesariamente accionable**.

### 7C. Cron `fn_reactivar_items_vencidos` cada minuto (🔴 CRÍTICO — palanca #2)

```
job 1 ACTIVE [* * * * *]: SELECT public.fn_reactivar_items_vencidos();
```

El bot corre cada minuto y hace `UPDATE items SET estado='disponible' WHERE estado='agotado' AND agotado_hasta IS NOT NULL AND agotado_hasta < NOW()`. Hoy hay 32 items y `agotado_hasta` casi nunca se setea. La función básicamente no hace nada el 99.9% de las veces, pero:
- 14,981 invocaciones acumuladas
- 135 s de CPU total
- 14,981 filas en `cron.job_run_details` (28 s de inserts)
- 14,981 updates en `cron.job_run_details` (10 s)
- WAL emission por cada cron run

**Fix (1 minuto):**
```sql
SELECT cron.alter_job(1, schedule => '*/15 * * * *');
-- Reduce a 96 calls/day. Si un item está agotado_hasta=12:00, se auto-reactiva entre 12:00 y 12:15. Aceptable.
```

### 7D. Tabla `auditoria` sin política de retención

3,570 filas hoy, sin TTL. Crece linealmente con uso. En 1 año de uso real podría llegar a 100k. Hoy no es problema, pero como Caja.tsx la lee sin LIMIT (issue #6), va a degradar progresivamente.

**Fix sugerido:**
```sql
-- Función + cron mensual
CREATE OR REPLACE FUNCTION fn_purge_auditoria_vieja() RETURNS integer AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM auditoria WHERE fecha < NOW() - INTERVAL '6 months';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

SELECT cron.schedule('purge-auditoria', '0 3 1 * *', 'SELECT fn_purge_auditoria_vieja()');
```

### 7E. `mp_movimientos` 150,986 updates sobre 5,552 filas

Cada `mp-process` re-escribe todas las filas del CSV de release_report aunque no cambiaron. Costo: 150k UPDATEs = 150k WAL writes + 150k triggers + 150k index updates.

**Fix sugerido en `/api/mp-process`:**
```sql
-- Hoy: UPDATE mp_movimientos SET (todas las cols) = ... WHERE id = ...
-- Mejor: UPDATE ... WHERE id = ... AND (col1, col2, ...) IS DISTINCT FROM (new1, new2, ...);
-- O usar ON CONFLICT DO UPDATE ... WHERE EXCLUDED.col1 IS DISTINCT FROM mp_movimientos.col1
```

Esto reduce updates a solo los que realmente cambiaron (~10-20%).

---

## 8. Plan de ataque sugerido (orden por ROI)

| Orden | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 1 | DROP 9 tablas catálogo de publication Realtime | 15 min | -30% workload absoluto |
| 2 | Cambiar cron `fn_reactivar_items_vencidos` a `*/15 * * * *` | 1 min | -92% calls cron, -CPU + WAL |
| 3 | CREATE INDEX `idx_movimientos_local_cuenta_activo` | 5 min | Trigger saldos 5-10× más rápido |
| 4 | CREATE INDEX `idx_facturas_estado_venc` | 5 min | Bandeja entrada vencidas → index scan |
| 5 | Fix `Caja.tsx:354` auditoría sin LIMIT (agregar id_registro indexable) | 30 min | -200ms hoy, evita degradación futura |
| 6 | DROP 4 índices huérfanos (mp_mov + movimientos partial) | 5 min | -560 kB + write overhead |
| 7 | RPC `aplicar_ncs_a_factura` (Compras N+1) | 1 h | -4 round-trips por pago multi-NC |
| 8 | RPC `anular_movimientos_batch` (RRHHLegajo N+1) | 1 h | -N round-trips por anulación liq |
| 9 | Cachear `pg_timezone_names` en JS const | 30 min | -580 s CPU acumulada en date pickers |
| 10 | Optimizar UPDATE en `/api/mp-process` (skip si no cambió) | 1 h | -80% UPDATEs en mp_movimientos |
| 11 | MV `v_admin_metricas_tenants` + cron refresh | 1 h | Dashboard superadmin instant |
| 12 | Cron mensual `purge_auditoria` 6 meses | 30 min | Tabla acotada en el largo plazo |

**Total esfuerzo (1-9):** ~4-5 horas. Total impacto: probablemente 40-50% reducción de DB CPU + 30% WAL.

---

## 9. Para chequear en próximas fases (out of scope acá)

- **F3B** (si existe) o sub-fase nueva: deep-dive en RLS performance — confirmar la hipótesis de 7B (función `auth_*` STABLE vs VOLATILE).
- **F4** (si existe): revisar `ventas` (no estaba en los top 8 pero `v_admin_metricas_tenants` la stresa) + auditar índices en `rrhh_*`, `pagos_realizados`, etc.
- Investigar por qué `ventas_pos` tiene 19,642 DELETEs sobre 22 filas vivas — posible bug de borrado físico vs soft.
- Investigar por qué los SELECTs lentos de `mp_movimientos` (1396ms mean) — probablemente son las queries de Conciliación con `dedupedMovs` cliente-side sobre el 100% del histórico.
