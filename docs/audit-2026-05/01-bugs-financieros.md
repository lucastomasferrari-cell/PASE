# Fase 1 — Bugs financieros críticos

**Estado:** ✅ Completa
**Fecha:** 2026-05-26
**Método:** 4 agentes en paralelo (F1A pagar, F1B anular, F1C triggers+MP, F1D RRHH), código leído **live del DB** con `pg_get_functiondef`.

## 📊 Resumen ejecutivo

**52 findings totales** en 7 categorías de RPCs financieras:

| Sub-fase | Total | 🔴 Crítico | 🟠 Alto | 🟡 Medio | 🟢 Bajo |
|---|---|---|---|---|---|
| F1A — Pagar | 13 | 3 | 5 | 4 | 1 |
| F1B — Anular | 12 | 4 | 5 | 2 | 1 |
| F1C — Triggers + MP | 12 | 3 | 4 | 3 | 2 |
| F1D — RRHH | 15 | 5 | 4 | 4 | 2 |
| **TOTAL** | **52** | **15** | **18** | **13** | **6** |

### ⚠️ Hallazgos confirmados en DATA REAL de producción

Los agentes corrieron queries contra la DB live y encontraron casos ya disparados:
- **1 factura con pago activo + estado anulada** (`FACT-1778176077832-myzh`) → plata fantasma en caja
- **24 liquidaciones con `pagos_realizados > total_a_pagar`** → sobrepagos silenciosos de sueldo
- **3 liquidaciones con `estado='pagado'` pero `pagos_realizados < total_a_pagar`** → trigger reseteó historial
- **2 adelantos con `descontado=true` y `liquidacion_consumidora_id=NULL`** → adelantos huérfanos

Esto NO son bugs latentes — están activos.

---

## 🎯 Ranking de los 15 CRÍTICOS (atacar primero)

| # | Bug | Sub-fase | Esfuerzo fix | Impacto |
|---|---|---|---|---|
| 1 | `eliminar_cierre` doble descuento de `saldos_caja` (RPC + trigger) | F1B | 5 min | Eliminar un cierre con 50 ventas → caja −$50k extra |
| 2 | `eliminar_venta` doble descuento (mismo bug) | F1B | 5 min | Cada eliminación de venta corrompe saldo |
| 3 | `pagar_remito` no valida monto vs total + sin pagos parciales | F1A | 15 min | Cobrar $1 sobre remito $100k lo marca pagado |
| 4 | `anular_factura` deja movs huérfanos (NO toca movimientos asociados) | F1B | 10 min + cleanup | Plata fantasma. **1 caso en prod ya** |
| 5 | `pagar_vacaciones`/`pagar_aguinaldo` UNIQUE `(empleado_id, tipo)` bloquea 2do pago **para siempre** | F1D | 30 min + migration | **Explota en SAC junio 2026** |
| 6 | `pagar_sueldo` permite sobrepago silencioso (24 casos en prod) | F1D | 10 min | Doble pago de sueldo si caller envía monto extra |
| 7 | `_resync_liquidacion_pagos` blanquea `pagado_at`/`pagado_por` al re-evaluar | F1D | 10 min | Pérdida de auditoría de quién pagó |
| 8 | Idempotency keys sin `tenant_id` → colisión cross-tenant | F1D | 1h + migration | Tenant B recibe resultado de tenant A en pagar_sueldo |
| 9 | `pagar_sueldo` sin `FOR UPDATE` → race condition de doble pago | F1D | 5 min | Causa probable del bug C4-F14 (Caro 2 movs huérfanos) |
| 10 | `aplicar_nc_a_factura` race en SUM + sin idempotency → NC sobreconsumida | F1A | 30 min | NC consumida 2× silenciosamente |
| 11 | `anular_movimiento` sin `FOR UPDATE` → doble anulación = adelantos resteados 2× | F1B | 5 min | Sueldos descalzados en concurrencia |
| 12 | `pagar_factura` idempotency rota (cross-RPC + respuesta incompleta) | F1A | 20 min | UI rompe en retries |
| 13 | `trg_sync_saldos_caja` cae a tenant Neko si `local_id IS NULL` | F1C | 15 min | Contamina saldos cross-tenant |
| 14 | RPCs `fn_conciliar_mp_*` llaman `_actualizar_saldo_caja` que es NOOP | F1C | 5 min | Ruido + bomba de tiempo si alguien "arregla" la función |
| 15 | `crear_gasto_empleado` UPDATE manual saldos_caja + trigger → **posible** doble descuento | F1D | 5 min + verificar trigger | Si el trigger NO es idempotente: doble salida de plata |

---

## F1A — RPCs PAGAR

### 🔴 CRÍTICO — `pagar_factura` idempotency rota
- Usa `movimientos.idempotency_key` con filtro hardcoded (`tipo='Pago Proveedor' AND fact_id=...`) en vez de la tabla `idempotency_keys`.
- Cache hit devuelve respuesta INCOMPLETA (sin `total_pagado`).
- Cross-RPC: misma key entre `pagar_remito` y `pagar_factura` → SELECT devuelve NULL → procede a cobrar → UNIQUE index tira `unique_violation` al final → frontend recibe 500.
- **Fix:** migrar a tabla `idempotency_keys` (mismo patrón que `pagar_sueldo`).

### 🔴 CRÍTICO — `pagar_remito` sin validación de monto + siempre marca 'pagado'
- No compara `p_monto` con `v_r.monto`. Permite pagar $1 sobre remito de $100k.
- Siempre setea `estado='pagado'` (no soporta pagos parciales como `pagar_factura`).
- Sin `p_idempotency_key`.
- **Fix mínimo:** `IF abs(p_monto - v_r.monto) > 0.01 THEN RAISE 'MONTO_NO_COINCIDE'`.
- **Fix completo:** replicar patrón `pagar_factura` con `pagos jsonb`.

### 🔴 CRÍTICO — `aplicar_nc_a_factura` race en SUM + sin idempotency
- `SELECT SUM(monto) FROM nc_aplicaciones` NO está bajo lock; `FOR UPDATE` solo cubre la fila de NC.
- 2 calls concurrentes ambas leen `v_nc_aplicado=0`, ambas insertan → NC consumida 2×.
- Sin `p_idempotency_key` + sin UNIQUE constraint en `(nc_id, factura_id, monto, fecha)`.
- **Fix:** `p_idempotency_key` + UNIQUE constraint + `SELECT SUM` dentro del mismo lock.

### 🟠 ALTO — Aguinaldo se acumula sobre liquidaciones anuladas
- `aguinaldo_acumulado += v_total_a_pagar / 12.0` corre cuando `v_completa=true`. Si la liquidación se anula y re-paga, suma de nuevo.
- **Fix:** calcular aguinaldo desde sumatoria histórica de liquidaciones NO anuladas (vista derivada).

### 🟠 ALTO — `pagar_sueldo` convención `p_mes` ambigua (0/1-based) sin validar
- `v_meses_nombre[p_mes+1]` asume one-based. Sin guard. Si caller manda 0-based, descripción muestra mes equivocado.

### 🟠 ALTO — Sin validación de `p_fecha` en PAGAR (todas)
- Permite backdating o future-dating sin alerta. Aplica a `pagar_factura`, `pagar_remito`, `pagar_sueldo`, `crear_movimiento_caja`, `transferencia_cuentas`.
- **Fix global:** `IF p_fecha > now() + interval '7 days' OR p_fecha < now() - interval '90 days' THEN RAISE 'FECHA_FUERA_RANGO'`.

### 🟠 ALTO — `crear_movimiento_caja` sin auth check explícito + sin idempotency + sin cap
- Sin `SECURITY DEFINER` ni check explícito de permiso. Sin `p_idempotency_key`. Sin cap de monto.

### 🟠 ALTO — `transferencia_cuentas` sin `p_idempotency_key`
- Doble click duplica 4 movs (2 transferencias). Saldo neto OK pero ledger con ruido permanente.

### 🟠 ALTO — `editar_movimiento_caja` llamadas a `_actualizar_saldo_caja` redundantes
- El trigger ya recalcula. Las llamadas generan doble WARN en `auditoria` + bomba latente.

### 🟡 MEDIO — `pagar_factura` permite sobrepago silencioso
- Sin tope en `total_pagado`. Typo de $500k sobre factura $50k → marca pagada + caja −$500k.

### 🟡 MEDIO — `aplicar_nc_a_factura` deja NC en estado "consumida" ambiguo (sin RPC para revertir)

### 🟡 MEDIO — `pagar_sueldo` race en `rrhh_adelantos.descontado` (SELECT SUM sin FOR UPDATE)

### 🟢 BAJO — `pagar_remito` lee `proveedores` sin filtro `tenant_id` (cross-tenant leak menor)

---

## F1B — RPCs ANULAR

### 🔴 CRÍTICO — `anular_factura` deja movs activos = plata fantasma
- Solo hace `UPDATE facturas SET estado='anulada'`. No anula `movimientos` con `fact_id`.
- **1 caso confirmado en prod:** `FACT-1778176077832-myzh`.
- **Fix:** `UPDATE movimientos SET anulado=true WHERE fact_id=p_factura_id AND NOT anulado` (con `FOR UPDATE`).

### 🔴 CRÍTICO — `eliminar_venta` doble descuento de saldos_caja
- Post-23-may (saldos_caja como cache derivado), el trigger ya recalcula. Pero la RPC sigue haciendo `UPDATE saldos_caja SET saldo = saldo - X` manual encima.
- Resultado: cada eliminación de venta descuenta 2×.
- **Fix:** eliminar el `UPDATE saldos_caja` manual; trigger es fuente de verdad.

### 🔴 CRÍTICO — `eliminar_cierre` doble descuento en loop (peor que eliminar_venta)
- Mismo bug que `eliminar_venta` pero en loop. Cierre con 50 ventas en efectivo → saldo cuenta −$50k extra.
- **Fix:** eliminar los `UPDATE saldos_caja` manuales del loop.

### 🔴 CRÍTICO — `anular_movimiento` sin `FOR UPDATE` (race condition)
- `SELECT * FROM movimientos WHERE id = p_mov_id` sin lock. Doble anulación posible → adelantos consumidos 2× resteados, aguinaldo descontado 2× en sueldos, etc.
- Otras `anular_*` SÍ tienen el fix CRIT-7 (FOR UPDATE). `anular_movimiento` quedó sin él.
- **Fix:** agregar `FOR UPDATE` al SELECT inicial.

### 🟠 ALTO — `anular_remito` no desvincula factura ni revierte stock
- Solo cambia `estado='anulado'`. No toca `facturas.fact_id` que apunta al remito ni revierte stock de insumos recibidos.
- **Fix:** decisión de producto + trigger análogo a `trg_factura_anulada_stock`.

### 🟠 ALTO — `anular_movimiento` parcial NO restaura adelantos consumidos
- Si la liquidación tiene varios pagos y solo se anula uno, los adelantos siguen `descontado=true`.
- Si después se re-paga el faltante, los adelantos se descuentan de nuevo → empleado pierde plata.

### 🟠 ALTO — `anular_gasto` solo procesa UN movimiento asociado (LIMIT implícito)
- `SELECT INTO v_mov FROM movimientos WHERE gasto_id_ref = p_gasto_id` — sin `LIMIT 1` explícito, trae solo la primera silenciosamente.
- Gasto con pago split (2 movs) → solo 1 se anula, el otro queda activo.
- **Fix:** `FOR v_mov IN SELECT ... LOOP ... END LOOP` o UNIQUE constraint.

### 🟠 ALTO — `eliminar_cierre` no anula `ventas_pos` cobradas
- Borra `ventas` agregadas pero NO `ventas_pos`. Stock POS consumido sigue descontado, puntos fidelidad acumulados quedan.

### 🟠 ALTO — `anular_factura` no desaplica NC ni recalcula saldo proveedor con NC fantasma
- NC aplicada queda "consumida" pero la factura ya no existe → NC perdida.
- `trg_saldo_prov_facturas` recalcula sin la factura → saldo cae a negativo porque NC sigue contada.

### 🟡 MEDIO — `anular_movimiento` no es `SECURITY DEFINER` (otras anulaciones sí)
- Comportamiento inconsistente. UPDATE de `rrhh_adelantos` puede fallar silenciosamente por RLS → estado parcial: movimiento anulado pero adelantos no restaurados.

### 🟡 MEDIO — Ninguna RPC anular tiene `p_idempotency_key`
- Segundo intento por timeout de red tira `YA_ANULADO` en vez de devolver respuesta original.

### 🟢 BAJO — `_auditar` en `anular_movimiento` sin tenant explícito → cae a tenant Neko fallback

---

## F1C — Triggers + Conciliación MP

### 🔴 CRÍTICO — RPCs `fn_conciliar_mp_*` llaman a `_actualizar_saldo_caja` que es NOOP post-23-may
- 3 RPCs (`fn_conciliar_mp_con_factura_nueva`, `_con_gasto`, `_con_movimiento_interno`) hacen `PERFORM _actualizar_saldo_caja(...)` que ya no actualiza nada.
- No rompe HOY (trigger hace el trabajo real), pero es **bomba latente**: si alguien "arregla" la función volviéndola activa, doble descuento.
- **Fix:** eliminar las 3 llamadas o renombrar la función para que su contrato sea explícito.

### 🔴 CRÍTICO — `trg_sync_saldos_caja` falla con `local_id IS NULL` → contamina tenant Neko
- Si `local_id IS NULL`, el trigger hace fallback `SELECT id FROM tenants WHERE slug='neko'`.
- Todos los movimientos sin local_id contaminan saldos del tenant Neko aunque sean de otro tenant.
- UNIQUE en `saldos_caja(cuenta, local_id)` con NULL → cada INSERT crea fila duplicada (NULL != NULL en UNIQUE de Postgres).
- **Fix:** usar `NEW.tenant_id` directamente (la columna existe NOT NULL). Skipear sync si `local_id IS NULL`.

### 🔴 CRÍTICO — `trg_sync_saldos_caja` usa `<>` en vez de `IS DISTINCT FROM`
- Comparación `OLD.cuenta <> NEW.cuenta` con NULL devuelve NULL (no TRUE). Cambios de/a NULL no disparan sync del OLD.
- **Fix:** `IS DISTINCT FROM` + `WHEN` clause al trigger para no recalcular ante cambios de texto cosmético.

### 🟠 ALTO — `fn_trg_sync_pagos_rrhh` pierde historial `pagado_at`/`pagado_por` en flujos parciales
- Cuando liquidación baja de completa a pendiente, el resync borra `pagado_at` y `pagado_por`. Pérdida de auditoría irreversible.
- Tolerancia de $1 abre puerta a marcar "pagado" pagando $999 de $1000.

### 🟠 ALTO — Schema duplicado en `mp_movimientos`: `justificativo_*` vs `vinculo_*`/`conciliado*`
- Tabla tiene ambas familias de columnas, RPCs solo escriben `justificativo_*`. Cualquier query legacy con `WHERE conciliado=true` ve cero.
- **Fix:** borrar columnas legacy o trigger de sincronización + revisar todos los reportes que las usen.

### 🟠 ALTO — `fn_conciliar_mp_con_movimiento_interno` no valida que `p_destino_cuenta` exista
- Typo del operador crea saldo en cuenta inexistente. Reversión requiere DELETE manual.
- **Fix:** validar contra `config_cuentas`.

### 🟠 ALTO — No existe `fn_desconciliar_mp` para revertir las 3 conciliaciones que crean entidades
- Conciliar es 1 click; desconciliar requiere SQL directo. Solo se puede deshacer con escalamiento a Lucas.

### 🟡 MEDIO — `fn_revertir_stock_factura` no filtra cross-tenant en `insumo_movimientos`
- Defense-in-depth. RLS protege normalmente pero NO aplica a `SECURITY DEFINER`.

### 🟡 MEDIO — `_validar_mp_mov_conciliable` rechaza `monto = 0` legítimos (reversions de MP)

### 🟡 MEDIO — `_gen_id` colisión teórica bajo bulk (sufijo 4 chars md5 + epoch segundo)
- ~0.7% colisión por par en bulk de 1000 facturas/segundo. Operación a mano OK, futuro importador masivo va a chocar.
- **Fix:** sufijo 8 chars o usar `gen_random_uuid()`.

### 🔵 BAJO — Falta CHECK en `mp_movimientos` que prevenga `ignorado=true AND justificativo_tipo IS NOT NULL`

### 🔵 BAJO — `trg_factura_anulada_stock` no detecta des-anulación (UPDATE manual a `estado='emitida'` deja stock doble-sumado)

---

## F1D — RPCs RRHH

### 🔴 CRÍTICO — `pagar_vacaciones`/`pagar_aguinaldo` UNIQUE `(empleado_id, tipo)` bloquea 2do pago para siempre
- Tabla `rrhh_pagos_especiales` con UNIQUE `(empleado_id, tipo)`. Empleado solo puede recibir vacaciones UNA VEZ en su vida. Aguinaldo solo UNO en su vida (no junio + diciembre).
- **Plazo crítico:** explota en SAC junio 2026 cuando empleados intenten cobrar 2do aguinaldo.
- **Fix:** migration eliminar UNIQUE o agregar `anio`/`periodo` a la PK.

### 🔴 CRÍTICO — `pagar_sueldo` permite sobrepago silencioso (24 casos en prod)
- Si liquidación ya está pagada y caller envía monto extra, la RPC inserta el movimiento sin RAISE.
- Confirmado en data prod: **24 filas con `pagos_realizados > total_a_pagar`**.
- **Fix:** abortar con `MONTO_EXCESIVO` si `v_sobrepago > 0`.

### 🔴 CRÍTICO — `_resync_liquidacion_pagos` blanquea historial `pagado_at`/`pagado_por`
- Cuando se anula un mov de pago y la liquidación baja de completa a pendiente, se borran ambos.
- Confirmado: 3 filas en prod con `estado='pagado' AND pagos_realizados < total_a_pagar` (perdieron historial).
- **Fix:** mantener `pagado_at`/`pagado_por` históricos aunque el estado cambie.

### 🔴 CRÍTICO — Idempotency keys SIN tenant_id → colisión cross-tenant
- PK `(rpc_name, key)` sin `tenant_id`. Si dos tenants usan claves deterministas (ej. `pagar_sueldo:<nov_id>:<fecha>`) colisionan.
- Tenant B recibe resultado de tenant A como `idempotent_replay=true` y NO ejecuta el pago real.
- **Fix:** migration: PK `(rpc_name, key, tenant_id)` + filtrar por tenant en SELECTs.

### 🔴 CRÍTICO — `pagar_sueldo` sin `FOR UPDATE` sobre `rrhh_liquidaciones`
- 2 sesiones concurrentes leen `pagos_realizados=0`, ambas insertan movs por $1000.
- **Causa probable del bug histórico C4-F14** (Caro: 2 movs huérfanos del mismo pago).
- **Fix:** `SELECT * FROM rrhh_liquidaciones WHERE id = p_liq_id FOR UPDATE`.

### 🟠 ALTO — `pagar_sueldo` ignora cesiones (`rrhh_empleado_locales`)
- Solo valida `_validar_local_autorizado(v_emp.local_id)` (local PRINCIPAL del empleado).
- Encargado del local DESTINO de cesión no puede pagar empleado cedido (bug Anto 21-may persiste).
- **Fix:** consultar `rrhh_empleado_locales` para autorización extendida.

### 🟠 ALTO — `crear_gasto_empleado` UPDATE manual `saldos_caja` + INSERT en movimientos (posible doble descuento)
- Hace `UPDATE saldos_caja SET saldo = saldo - p_monto` ANTES del INSERT en `movimientos`.
- Si el trigger `trg_sync_saldos_caja` no es full-recompute idempotente, doble descuento.
- **Crítico verificar:** ¿el trigger recalcula o aplica delta?

### 🟠 ALTO — `liquidacion_final_empleado` no cancela cesiones del empleado
- Marca empleado `activo=false` pero `rrhh_empleado_locales` queda activo. Empleado despedido sigue figurando cedido. Peor: `fn_ceder_empleado_a_local` no chequea `activo` → se puede ceder empleado liquidado.

### 🟠 ALTO — `liquidacion_final_empleado` no chequea liquidaciones/adelantos pendientes
- Asume que `p_total` incluye todo. No verifica `rrhh_liquidaciones` con `estado='pendiente'` ni `rrhh_adelantos` con `descontado=false`.
- Como NO se puede re-correr (UNIQUE), pifia irreversible salvo DB manual.

### 🟡 MEDIO — `pagar_sueldo` acumula aguinaldo sobre NETO (no sobre bruto como pide Ley 27.073)
- Subestima SAC. Además si se anula y reaplica liquidación, suma 2× sin desindex.

### 🟡 MEDIO — `pagar_vacaciones`/`pagar_aguinaldo` sin `p_idempotency_key`
- Reintento por timeout → falla con UNIQUE_VIOLATION feo (no idempotente).

### 🟡 MEDIO — `registrar_adelanto` no chequea permiso `rrhh` ni respeta cesiones (mismo patrón)

### 🟡 MEDIO — `crear_gasto_empleado` idempotency cross-tenant (heredado del CRÍTICO #4)

### 🟢 BAJO — `cambiar_sueldo_empleado` puede grabar `registrado_por=NULL` si caller es superadmin sin fila en `usuarios`

### 🟢 BAJO — `fn_revocar_cesion_empleado` no chequea pagos pendientes en destino

---

## Observaciones generales (cross-agente)

1. **Patrón "trigger + RPC haciendo lo mismo" repetido** (F1B + F1D): el sprint 23-may movió `saldos_caja` a cache derivado pero **quedaron callsites con UPDATE manual**. `eliminar_venta`, `eliminar_cierre`, `crear_gasto_empleado` todos lo hacen. Auditar el codebase completo buscando `UPDATE saldos_caja` para encontrar más.

2. **Inconsistencia en modelo de idempotency** (F1A + F1D): 3 modelos coexisten —
   - Tabla `idempotency_keys` (pagar_sueldo, editar_movimiento_caja)
   - Columna `movimientos.idempotency_key` (pagar_factura)
   - Sin idempotency (crear_movimiento_caja, transferencia_cuentas, aplicar_nc_a_factura, todas las ANULAR, pagar_vacaciones, pagar_aguinaldo)
   - **Estandarizar todas en `idempotency_keys` con `tenant_id` en la PK.**

3. **Falta `FOR UPDATE` en operaciones críticas** (F1B + F1D): `anular_movimiento`, `pagar_sueldo`. El sprint CRIT-7 lo agregó a `anular_factura`/`remito`/`gasto` pero quedaron 2 huérfanas.

4. **Falta validación de `p_fecha`** en TODAS las RPCs (F1A). Backdating intencional o accidental siempre posible.

5. **`_actualizar_saldo_caja` es NOOP pero todavía llamado por ~6 RPCs** (F1C + F1D). Bomba latente — si alguien la "arregla" rompe todo.

6. **`_auditar` swallow-all (`EXCEPTION WHEN OTHERS THEN NULL`)** (F1A + F1C): si auditoría se rompe, RPCs ejecutan sin rastro. Considerar `RAISE WARNING` para diagnóstico.

7. **Auth coverage débil en RRHH** (F1D): solo `cambiar_sueldo_empleado` chequea `permiso rrhh` explícito. Todas las demás dependen de `_validar_local_autorizado` (que se puede saltear con cesiones).

8. **Schema dual en `mp_movimientos`** (F1C): `justificativo_*` (activo) vs `vinculo_*`/`conciliado*` (legacy fósil). Riesgo si algún reporte legacy queda apuntando al schema viejo.

9. **`saldos_caja` con `local_id IS NULL`** (F1C): contamina tenant Neko via fallback. **Crítico para multi-tenant.**

10. **No hay RPCs reverso** (F1B + F1C): conciliación MP, NC aplicada, liquidación final — todas requieren SQL directo para revertir errores del operador.

---

## Para la próxima fase (F2)

F1 reveló varios casos donde la auth/multi-tenant es débil:
- `trg_sync_saldos_caja` con fallback a tenant Neko (CRÍTICO #13)
- Idempotency keys cross-tenant (CRÍTICO #8)
- `_validar_local_autorizado` no respeta cesiones (ALTO en F1D #5)
- `auth_es_superadmin` sin contexto de tenant en algunas RPCs

F2 (seguridad multi-tenant) debe atacar:
- Auditar TODAS las RLS policies de tablas con `tenant_id`
- Verificar que `SECURITY DEFINER` siempre chequee tenant
- Buscar más casos de `WHERE` sin filtro `tenant_id` en JOINs internos
- Cross-tenant leaks en logs, auditoría, `auth.uid()` mal cacheado
